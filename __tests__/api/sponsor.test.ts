import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Address,
  Asset,
} from "@stellar/stellar-sdk";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

const mockEnforceRouteRateLimit = vi.fn();
const mockEnforceCustomRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: (...args: unknown[]) => mockEnforceRouteRateLimit(...args),
  enforceCustomRateLimit: (...args: unknown[]) => mockEnforceCustomRateLimit(...args),
}));

import { POST } from "@/app/api/sponsor/route";

describe("POST /api/sponsor", () => {
  const borrowerKeypair = Keypair.random();
  const borrowerWallet = borrowerKeypair.publicKey();
  const adminKeypair = Keypair.random();
  const approvedContractId = Address.contract(Buffer.alloc(32, 1)).toString();
  const unapprovedContractId = Address.contract(Buffer.alloc(32, 2)).toString();

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;
    process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID = approvedContractId;
    delete process.env.ADMIN_SECRET_KEY;

    mockEnforceRouteRateLimit.mockResolvedValue(null);
    mockEnforceCustomRateLimit.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function buildContractTx(
    contractId: string,
    keypair = borrowerKeypair,
    method = "apply_loan"
  ): string {
    const account = new Account(keypair.publicKey(), "1000");
    const op = Operation.invokeContractFunction({
      contract: contractId,
      function: method,
      args: [],
    });
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(300)
      .build();
    return tx.toXDR();
  }

  function makeRequest(body: unknown) {
    return new NextRequest("http://localhost/api/sponsor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when the user is not authenticated", async () => {
    mockRequireAuthenticatedUser.mockRejectedValue(new Error("Unauthorized"));

    const validXdr = buildContractTx(approvedContractId);
    const res = await POST(makeRequest({ xdr: validXdr }));

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/Unauthorized/i);
  });

  it("returns 403 when the authenticated user is not a borrower", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-lender", role: "lender", walletAddress: borrowerWallet },
      role: "lender",
    });

    const validXdr = buildContractTx(approvedContractId);
    const res = await POST(makeRequest({ xdr: validXdr }));

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/Borrower role required/i);
  });

  it("returns 429 when per-user rate limit is exceeded", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const { NextResponse } = await import("next/server");
    mockEnforceCustomRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const validXdr = buildContractTx(approvedContractId);
    const res = await POST(makeRequest({ xdr: validXdr }));

    expect(res.status).toBe(429);
  });

  it("returns 400 when body is missing XDR", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing transaction XDR/i);
  });

  it("returns 400 when XDR is malformed", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const res = await POST(makeRequest({ xdr: "not-valid-xdr" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid transaction XDR/i);
  });

  it("returns 403 when transaction source does not match authenticated borrower wallet", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const otherKeypair = Keypair.random();
    const mismatchedTxXdr = buildContractTx(approvedContractId, otherKeypair);

    const res = await POST(makeRequest({ xdr: mismatchedTxXdr }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/source does not match/i);
  });

  it("returns 400 when transaction targets an unapproved contract", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const unapprovedTxXdr = buildContractTx(unapprovedContractId);
    const res = await POST(makeRequest({ xdr: unapprovedTxXdr }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/unapproved contract/i);
  });

  it("returns 400 when transaction operation is not a contract invocation", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const account = new Account(borrowerWallet, "1000");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(300)
      .build();

    const res = await POST(makeRequest({ xdr: tx.toXDR() }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/not eligible for fee sponsorship/i);
  });

  it("returns simulation response when ADMIN_SECRET_KEY is not set", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    const validXdr = buildContractTx(approvedContractId);
    const res = await POST(makeRequest({ xdr: validXdr }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.isSimulated).toBe(true);
    expect(data.sponsoredXdr).toBe(validXdr);
  });

  it("builds and signs FeeBumpTransaction when ADMIN_SECRET_KEY is set", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "user-borrower-1", role: "borrower", walletAddress: borrowerWallet },
      role: "borrower",
    });

    process.env.ADMIN_SECRET_KEY = adminKeypair.secret();

    const validXdr = buildContractTx(approvedContractId);
    const res = await POST(makeRequest({ xdr: validXdr }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.isSimulated).toBe(false);
    expect(data.sponsoredXdr).toBeDefined();

    // Verify it parses as FeeBumpTransaction
    const parsedBump = TransactionBuilder.fromXDR(data.sponsoredXdr, Networks.TESTNET);
    expect((parsedBump as any).feeSource).toBe(adminKeypair.publicKey());
  });
});
