import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Keypair, Networks, Transaction, Address } from "@stellar/stellar-sdk";
import { enforceRouteRateLimit, enforceCustomRateLimit } from "@/lib/rate-limit";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { CONTRACTS } from "@/lib/deployment/contracts-manifest";

/**
 * TrustLend Advanced Feature: Fee Sponsorship (Gasless Transactions)
 * This endpoint allows the platform (Treasury) to sponsor transaction fees for borrowers.
 * By wrapping the user's signed transaction in a FeeBumpTransaction, the platform pays the gas,
 * enabling true "gasless" experiences for users without XLM balances.
 */

export function getApprovedContractIds(): Set<string> {
  const ids = new Set<string>();
  for (const c of CONTRACTS) {
    const val = process.env[c.envVar];
    if (val && typeof val === "string" && val.trim()) {
      ids.add(val.trim());
    }
  }
  const extra = process.env.SPONSOR_APPROVED_CONTRACT_IDS;
  if (extra) {
    for (const id of extra.split(",")) {
      if (id.trim()) ids.add(id.trim());
    }
  }
  return ids;
}

export async function POST(req: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(req);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // 1. Authenticate borrower session
    let authUser: { id: string; role?: string; walletAddress?: string | null };
    try {
      const auth = await requireAuthenticatedUser("borrower");
      if (auth.role !== "borrower") {
        console.warn(`[Sponsor] Forbidden access attempt by role '${auth.role}'`);
        return NextResponse.json(
          { error: "Forbidden: Borrower role required" },
          { status: 403 }
        );
      }
      authUser = auth.user;
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : String(authError);
      console.warn(`[Sponsor] Unauthorized sponsorship request: ${message}`);
      const isRole = message.toLowerCase().includes("role") || message.toLowerCase().includes("forbidden");
      return NextResponse.json(
        { error: isRole ? "Forbidden: Borrower role required" : "Unauthorized: Borrower session required" },
        { status: isRole ? 403 : 401 }
      );
    }

    // 2. Strict per-user and per-wallet rate limits
    if (authUser.id) {
      const userRateLimit = await enforceCustomRateLimit(
        `user:${authUser.id}`,
        "sponsor:user",
        { limit: 10, window: "10 m" },
        "Too many sponsorship requests for your user account. Please try again later."
      );
      if (userRateLimit) return userRateLimit;
    }

    if (authUser.walletAddress) {
      const walletRateLimit = await enforceCustomRateLimit(
        `wallet:${authUser.walletAddress}`,
        "sponsor:wallet",
        { limit: 10, window: "10 m" },
        "Too many sponsorship requests for this wallet. Please try again later."
      );
      if (walletRateLimit) return walletRateLimit;
    }

    // 3. Parse JSON body
    let body: { xdr?: unknown };
    try {
      body = await req.json();
    } catch (jsonErr) {
      console.warn("[Sponsor] Failed to parse request body as JSON:", jsonErr);
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { xdr } = body;
    if (!xdr || typeof xdr !== "string") {
      console.warn("[Sponsor] Missing or invalid transaction XDR");
      return NextResponse.json({ error: "Missing transaction XDR" }, { status: 400 });
    }

    const networkPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

    // 4. Decode and inspect inner transaction
    let innerTx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      if (!(parsed instanceof Transaction)) {
        console.warn("[Sponsor] XDR is not a base Transaction (cannot sponsor FeeBumpTransaction)");
        return NextResponse.json({ error: "Only base transactions can be fee-sponsored" }, { status: 400 });
      }
      innerTx = parsed;
    } catch (decodeErr) {
      console.warn("[Sponsor] Malformed transaction XDR:", decodeErr instanceof Error ? decodeErr.message : decodeErr);
      return NextResponse.json({ error: "Invalid transaction XDR format" }, { status: 400 });
    }

    // 5. Validate operations
    if (!innerTx.operations || innerTx.operations.length === 0) {
      console.warn("[Sponsor] Transaction contains no operations");
      return NextResponse.json({ error: "Transaction must contain at least one operation" }, { status: 400 });
    }

    // 6. If user wallet is known, enforce source account match
    if (authUser.walletAddress && innerTx.source !== authUser.walletAddress) {
      console.warn(
        `[Sponsor] Source account mismatch: tx source '${innerTx.source}' != user wallet '${authUser.walletAddress}'`
      );
      return NextResponse.json(
        { error: "Transaction source does not match authenticated borrower wallet" },
        { status: 403 }
      );
    }

    // 7. Validate targets: ensure operations only target approved TrustLend contracts
    const approvedContracts = getApprovedContractIds();
    for (let i = 0; i < innerTx.operations.length; i++) {
      const op = innerTx.operations[i] as any;
      if (op.type === "invokeHostFunction" && op.func) {
        if (op.func.switch().name !== "hostFunctionTypeInvokeContract") {
          console.warn(`[Sponsor] Op #${i} invokes non-contract host function`);
          return NextResponse.json({ error: "Only contract invocation operations can be fee-sponsored" }, { status: 400 });
        }
        const invocation = op.func.invokeContract();
        const calledContract = Address.fromScAddress(invocation.contractAddress()).toString();
        if (approvedContracts.size > 0 && !approvedContracts.has(calledContract)) {
          console.warn(`[Sponsor] Op #${i} targets unapproved contract: ${calledContract}`);
          return NextResponse.json({ error: "Transaction targets unapproved contract" }, { status: 400 });
        }
      } else {
        console.warn(`[Sponsor] Op #${i} has unapproved operation type: ${op.type}`);
        return NextResponse.json(
          { error: `Operation type '${op.type}' is not eligible for fee sponsorship` },
          { status: 400 }
        );
      }
    }

    const adminSecret = process.env.ADMIN_SECRET_KEY;
    if (!adminSecret) {
      // Simulation mode if key is not set up
      return NextResponse.json({
        success: true,
        message: "Fee Sponsorship Simulation: Admin secret key not configured. In production, this returns a signed FeeBumpTransaction.",
        sponsoredXdr: xdr,
        isSimulated: true,
      });
    }

    // 8. Wrap transaction in FeeBumpTransaction
    const sponsorKeypair = Keypair.fromSecret(adminSecret);
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      "100000",
      innerTx,
      networkPassphrase
    );

    // 9. Sign wrapper with platform key
    feeBumpTx.sign(sponsorKeypair);

    return NextResponse.json({
      success: true,
      message: "Transaction fees sponsored successfully.",
      sponsoredXdr: feeBumpTx.toXDR(),
      isSimulated: false,
    });
  } catch (error) {
    console.error("[Sponsor] Unexpected error in sponsorship handler:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to sponsor transaction",
      },
      { status: 500 }
    );
  }
}

