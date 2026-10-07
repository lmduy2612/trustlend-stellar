import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { ledgerTransactions, lendingPools, poolPositions, profiles } from "@/lib/db/schema";
import { syncPoolOnchain } from "@/lib/pools/onchain";
import { PlatformWalletError, payoutFromPlatformWallet } from "@/lib/stellar/platform-wallet";
import { PAYMENT_MEMO } from "@/lib/stellar/verify-payment";
import { isRedirectError } from "next/dist/client/components/redirect-error";

// In-flight withdrawal tracker to block concurrent requests on the same position
const inFlightPositions = new Set<string>();

// In-memory idempotency cache: key -> { status, response, statusCode, timestamp }
interface IdempotencyRecord {
  status: "pending" | "completed";
  response?: Record<string, unknown>;
  statusCode?: number;
  timestamp: number;
}
const idempotencyStore = new Map<string, IdempotencyRecord>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupIdempotencyStore() {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}

export function _resetWithdrawStateForTesting() {
  inFlightPositions.clear();
  idempotencyStore.clear();
}

/**
 * POST /api/pools/withdraw
 *
 * Body: { positionId, amount, idempotencyKey? }
 * Headers: x-idempotency-key? or idempotency-key?
 *
 * Pays `amount` XLM from the platform wallet back to the lender's wallet
 * (server-signed with PLATFORM_WALLET_SECRET), with atomic pre-payout state
 * transition and rollback on failure to prevent double-withdrawal race conditions.
 */
export async function POST(request: NextRequest) {
  let acquiredPositionId: string | null = null;
  let activeIdempotencyKey: string | null = null;

  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("lender");
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { positionId, amount } = body as { positionId?: string; amount?: number };

    if (!positionId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: "Amount exceeds maximum allowed" }, { status: 400 });
    }

    // ── Idempotency Check ────────────────────────────────────────────────────
    const idempotencyKey =
      request.headers.get("x-idempotency-key") ||
      request.headers.get("idempotency-key") ||
      (typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined);

    if (idempotencyKey) {
      cleanupIdempotencyStore();
      const existing = idempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.status === "pending") {
          return NextResponse.json(
            { error: "A withdrawal request with this idempotency key is already in progress" },
            { status: 409 }
          );
        }
        if (existing.status === "completed" && existing.response) {
          return NextResponse.json(existing.response, { status: existing.statusCode ?? 200 });
        }
      }
      activeIdempotencyKey = idempotencyKey;
      idempotencyStore.set(idempotencyKey, { status: "pending", timestamp: Date.now() });
    }

    // ── Concurrency Lock ─────────────────────────────────────────────────────
    if (inFlightPositions.has(positionId)) {
      if (activeIdempotencyKey) idempotencyStore.delete(activeIdempotencyKey);
      return NextResponse.json(
        { error: "A withdrawal for this position is already in progress" },
        { status: 409 }
      );
    }
    inFlightPositions.add(positionId);
    acquiredPositionId = positionId;

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Get position and verify ownership
    const [positionRow] = await db
      .select({
        id: poolPositions.id,
        poolId: poolPositions.poolId,
        principalAmount: poolPositions.principalAmount,
        withdrawnAmount: poolPositions.withdrawnAmount,
      })
      .from(poolPositions)
      .where(
        and(eq(poolPositions.id, positionId), eq(poolPositions.lenderId, user.id), eq(poolPositions.status, "active")),
      )
      .limit(1);

    if (!positionRow) {
      return NextResponse.json({ error: "Position not found" }, { status: 404 });
    }
    const position = {
      id: positionRow.id,
      pool_id: positionRow.poolId,
      principal_amount: Number(positionRow.principalAmount),
      withdrawn_amount: Number(positionRow.withdrawnAmount),
    };

    if (amount > position.principal_amount) {
      return NextResponse.json(
        { error: "Withdrawal amount exceeds principal" },
        { status: 400 }
      );
    }

    // Get pool
    const [poolRow] = await db
      .select({ availableLiquidity: lendingPools.availableLiquidity })
      .from(lendingPools)
      .where(eq(lendingPools.id, position.pool_id))
      .limit(1);

    if (!poolRow) {
      return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    }

    if (amount > Number(poolRow.availableLiquidity)) {
      return NextResponse.json(
        { error: "Insufficient liquidity in pool for withdrawal" },
        { status: 400 }
      );
    }

    // ── Pay the lender from the platform wallet ──────────────────────────────
    const [lenderProfile] = await db
      .select({ walletAddress: profiles.walletAddress })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    const destination = lenderProfile?.walletAddress || user.walletAddress;
    if (!destination) {
      return NextResponse.json(
        { error: "Connect a Stellar wallet on your profile before withdrawing" },
        { status: 409 }
      );
    }

    // ── Pre-Payout State Transition (Atomic Reservation) ───────────────────
    const newPrincipal = position.principal_amount - amount;
    await db
      .update(poolPositions)
      .set({
        principalAmount: String(newPrincipal),
        withdrawnAmount: String(position.withdrawn_amount + amount),
        status: newPrincipal === 0 ? "closed" : "active",
        closedAt: newPrincipal === 0 ? new Date() : null,
      })
      .where(eq(poolPositions.id, positionId));

    const withdrawalAmount = Number(Number(amount).toFixed(7));
    let payout: { hash: string; source: string };
    try {
      payout = await payoutFromPlatformWallet({
        destination,
        amountXlm: withdrawalAmount,
        memo: PAYMENT_MEMO.withdraw(String(positionId)),
      });
    } catch (payoutError) {
      // ── Roll back state transition on failure ───────────────────────────
      try {
        await db
          .update(poolPositions)
          .set({
            principalAmount: String(position.principal_amount),
            withdrawnAmount: String(position.withdrawn_amount),
            status: "active",
            closedAt: null,
          })
          .where(eq(poolPositions.id, positionId));
      } catch (rollbackErr) {
        console.error("Failed to roll back position state transition:", rollbackErr);
      }

      if (activeIdempotencyKey) {
        idempotencyStore.delete(activeIdempotencyKey);
      }

      if (payoutError instanceof PlatformWalletError) {
        return NextResponse.json(
          { error: `Withdrawals are unavailable: ${payoutError.message}` },
          { status: 503 }
        );
      }
      const message = payoutError instanceof Error ? payoutError.message : String(payoutError);
      return NextResponse.json({ error: `Payout failed: ${message}` }, { status: 502 });
    }

    // Update pool liquidity (SQL-side decrement)
    await db
      .update(lendingPools)
      .set({
        totalLiquidity: sql`${lendingPools.totalLiquidity} - ${amount}`,
        availableLiquidity: sql`${lendingPools.availableLiquidity} - ${amount}`,
      })
      .where(eq(lendingPools.id, position.pool_id));

    // Record transaction
    await db.insert(ledgerTransactions).values({
      userId: user.id,
      category: "withdrawal",
      amount: String(amount),
      currency: "XLM",
      status: "confirmed",
      refType: "pool_position",
      refId: positionId,
      metadata: { txHash: payout.hash, lenderAddress: destination, platformWallet: payout.source },
    });

    // ── Mirror pool totals to the PooledLendingContract ──────────────────────
    const onchain = await syncPoolOnchain(db, position.pool_id);

    const successResponse = {
      message: "Withdrawal successful",
      withdrawalAmount: amount,
      txHash: payout.hash,
      onchain,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${payout.hash}`,
    };

    if (activeIdempotencyKey) {
      idempotencyStore.set(activeIdempotencyKey, {
        status: "completed",
        response: successResponse,
        statusCode: 200,
        timestamp: Date.now(),
      });
    }

    return NextResponse.json(successResponse, { status: 200 });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Withdrawal error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    if (acquiredPositionId) {
      inFlightPositions.delete(acquiredPositionId);
    }
  }
}
