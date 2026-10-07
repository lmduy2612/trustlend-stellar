import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "../../helpers/fake-db";

const LENDER = "GBLENDER00000000000000000000000000000000000000000000000000";
const PLATFORM = "GBPLATFORM0000000000000000000000000000000000000000000000";
const HASH = "8".repeat(64);
const POOL_ID = "aaaa0000-0000-4000-8000-000000000001";
const POSITION_ID = "bbbb0000-0000-4000-8000-000000000002";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRouteRateLimit: vi.fn().mockResolvedValue(null) }));

const mockSync = vi.fn();
vi.mock("@/lib/pools/onchain", () => ({ syncPoolOnchain: (...args: unknown[]) => mockSync(...args) }));

const mockPayout = vi.fn();
vi.mock("@/lib/stellar/platform-wallet", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/platform-wallet")>("@/lib/stellar/platform-wallet");
  return { ...actual, payoutFromPlatformWallet: (...args: unknown[]) => mockPayout(...args) };
});

const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({ getDb: () => mockGetDb() }));

import { POST as withdraw, _resetWithdrawStateForTesting } from "@/app/api/pools/withdraw/route";

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/pools/withdraw", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function queueWithdrawReads(db: ReturnType<typeof createFakeDb>, principal = "100", liquidity = "500") {
  db.queue([{ id: POSITION_ID, poolId: POOL_ID, principalAmount: principal, withdrawnAmount: "0" }]); // position
  db.queue([{ availableLiquidity: liquidity }]); // pool
  db.queue([{ walletAddress: LENDER }]); // lender profile
}

describe("POST /api/pools/withdraw - Concurrency and Idempotency (#350)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWithdrawStateForTesting();
    mockRequireAuthenticatedUser.mockResolvedValue({
      user: { id: "lender-1", walletAddress: LENDER },
      role: "lender",
    });
    mockSync.mockResolvedValue({ attempted: false });
  });

  it("prevents double-withdrawal race condition by rejecting concurrent requests for the same position", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // pre-payout update
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);

    // Make payout take some time so the first request stays in-flight
    let resolvePayout!: (val: { hash: string; source: string }) => void;
    mockPayout.mockReturnValue(
      new Promise((resolve) => {
        resolvePayout = resolve;
      })
    );

    // Launch first withdrawal
    const req1Promise = withdraw(makeRequest({ positionId: POSITION_ID, amount: 60 }));

    // Near-simultaneous second withdrawal for the same position while first is in-flight
    const req2Res = await withdraw(makeRequest({ positionId: POSITION_ID, amount: 60 }));

    // Second request MUST be rejected with 409 Conflict immediately
    expect(req2Res.status).toBe(409);
    const req2Json = await req2Res.json();
    expect(req2Json.error).toMatch(/already in progress/i);

    // Resolve first payout
    resolvePayout({ hash: HASH, source: PLATFORM });
    const req1Res = await req1Promise;
    expect(req1Res.status).toBe(200);

    // Platform payout was called exactly ONCE across the two requests
    expect(mockPayout).toHaveBeenCalledTimes(1);
  });

  it("supports idempotency key to return cached response on retries", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // pre-payout update
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);
    mockPayout.mockResolvedValue({ hash: HASH, source: PLATFORM });

    const idempotencyKey = "req-idempotency-key-12345";

    // First request with idempotency key
    const res1 = await withdraw(
      makeRequest(
        { positionId: POSITION_ID, amount: 50 },
        { "x-idempotency-key": idempotencyKey }
      )
    );
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.txHash).toBe(HASH);

    // Second identical request with same idempotency key
    const res2 = await withdraw(
      makeRequest(
        { positionId: POSITION_ID, amount: 50 },
        { "x-idempotency-key": idempotencyKey }
      )
    );
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.txHash).toBe(HASH);

    // Payout and DB inserts were executed only once!
    expect(mockPayout).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent request with the same idempotency key as 409 Conflict", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // pre-payout update
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);

    let resolvePayout!: (val: { hash: string; source: string }) => void;
    mockPayout.mockReturnValue(
      new Promise((resolve) => {
        resolvePayout = resolve;
      })
    );

    const idempotencyKey = "concurrent-idempotency-key-999";

    const p1 = withdraw(
      makeRequest(
        { positionId: POSITION_ID, amount: 30 },
        { "x-idempotency-key": idempotencyKey }
      )
    );

    // Second request with same idempotency key while first is running
    const res2 = await withdraw(
      makeRequest(
        { positionId: "another-position-id", amount: 30 },
        { "x-idempotency-key": idempotencyKey }
      )
    );
    expect(res2.status).toBe(409);
    expect((await res2.json()).error).toMatch(/already in progress/i);

    resolvePayout({ hash: HASH, source: PLATFORM });
    await p1;
  });

  it("restores position principal upon payout failure (atomic rollback)", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db, "100");
    db.queue([]); // pre-payout update
    db.queue([]); // rollback update
    mockGetDb.mockReturnValue(db);
    mockPayout.mockRejectedValue(new Error("Horizon timeout"));

    const res = await withdraw(makeRequest({ positionId: POSITION_ID, amount: 75 }));
    expect(res.status).toBe(502);

    // Check updates: first reserved amount (100 -> 25), second rolled back to 100
    const updateCalls = db.calls.filter((c) => c.method === "update");
    expect(updateCalls).toHaveLength(2);

    // No ledger transaction inserted
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
  });
});
