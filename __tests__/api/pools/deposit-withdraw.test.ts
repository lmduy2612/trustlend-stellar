import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeDb } from "../../helpers/fake-db";

const LENDER = "GBLENDER00000000000000000000000000000000000000000000000000";
const PLATFORM = "GBPLATFORM0000000000000000000000000000000000000000000000";
const HASH = "9".repeat(64);
const POOL_ID = "aaaa0000-0000-4000-8000-000000000001";
const POSITION_ID = "bbbb0000-0000-4000-8000-000000000002";

const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRouteRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/kyc/middleware", () => ({
  requireKycVerified: vi.fn().mockResolvedValue({ allowed: true, kycStatus: "verified" }),
}));

const mockVerify = vi.fn();
vi.mock("@/lib/stellar/verify-payment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/verify-payment")>("@/lib/stellar/verify-payment");
  return { ...actual, verifyPaymentTransaction: (...args: unknown[]) => mockVerify(...args) };
});

const mockSync = vi.fn();
vi.mock("@/lib/pools/onchain", () => ({ syncPoolOnchain: (...args: unknown[]) => mockSync(...args) }));

const mockPayout = vi.fn();
vi.mock("@/lib/stellar/platform-wallet", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/platform-wallet")>("@/lib/stellar/platform-wallet");
  return { ...actual, payoutFromPlatformWallet: (...args: unknown[]) => mockPayout(...args) };
});

const mockGetDb = vi.fn();
vi.mock("@/lib/db/client", () => ({ getDb: () => mockGetDb() }));

import { POST as deposit } from "@/app/api/pools/deposit/route";
import { POST as withdraw } from "@/app/api/pools/withdraw/route";
import { PlatformWalletError } from "@/lib/stellar/platform-wallet";

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/pools/deposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS = PLATFORM;
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "lender-1", walletAddress: LENDER }, role: "lender" });
    mockSync.mockResolvedValue({ attempted: true, ok: true, txHash: "1".repeat(64), onchainPoolId: 0 });
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS;
  });

  it("verifies the payment to the platform wallet with the pool-bound memo before crediting", async () => {
    const db = createFakeDb();
    db.queue([]); // duplicate tx
    db.queue([{ id: POOL_ID }]); // pool
    db.queue([{ walletAddress: LENDER }]); // lender profile
    db.queue([]); // existing position
    db.queue([{ id: POSITION_ID }]); // insert position
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({
      ok: true,
      txHash: HASH,
      source: LENDER,
      memo: "",
      ledger: 5,
      closedAt: new Date().toISOString(),
      received: { [PLATFORM]: 250 },
      totalNative: 250,
    });

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(201);
    expect((await res.json()).onchain).toMatchObject({ attempted: true, ok: true });
    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSource: LENDER,
        expectedMemo: `TL-DEPOSIT:${POOL_ID.slice(0, 12)}`,
        expectedPayments: [{ destination: PLATFORM, minAmount: 250 }],
      }),
    );
    expect(mockSync).toHaveBeenCalledWith(db, POOL_ID);
  });

  it("does not create a position when verification fails", async () => {
    const db = createFakeDb();
    db.queue([]);
    db.queue([{ id: POOL_ID }]);
    db.queue([{ walletAddress: LENDER }]);
    mockGetDb.mockReturnValue(db);
    mockVerify.mockResolvedValue({ ok: false, status: 422, reason: "Transaction paid 0 XLM" });

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(422);
    expect(db.calls.some((c) => c.method === "insert" || c.method === "update")).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("refuses deposits when no platform wallet is configured", async () => {
    delete process.env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS;
    const db = createFakeDb();
    db.queue([]);
    db.queue([{ id: POOL_ID }]);
    mockGetDb.mockReturnValue(db);

    const res = await deposit(request("/api/pools/deposit", { poolId: POOL_ID, amount: 250, txHash: HASH, lenderAddress: LENDER }));
    expect(res.status).toBe(503);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("POST /api/pools/withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuthenticatedUser.mockResolvedValue({ user: { id: "lender-1", walletAddress: LENDER }, role: "lender" });
    mockSync.mockResolvedValue({ attempted: false, reason: "lifecycle off" });
  });

  function queueWithdrawReads(db: ReturnType<typeof createFakeDb>) {
    db.queue([{ id: POSITION_ID, poolId: POOL_ID, principalAmount: "100", withdrawnAmount: "0" }]); // position
    db.queue([{ availableLiquidity: "500" }]); // pool
    db.queue([{ walletAddress: LENDER }]); // lender profile
  }

  it("pays the lender from the platform wallet, then reduces the position and records the hash", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // position update
    db.queue([]); // pool update
    db.queue([]); // ledger insert
    mockGetDb.mockReturnValue(db);
    mockPayout.mockResolvedValue({ hash: HASH, source: PLATFORM });

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.txHash).toBe(HASH);
    expect(mockPayout).toHaveBeenCalledWith(
      expect.objectContaining({ destination: LENDER, amountXlm: 40, memo: `TL-WDR:${POSITION_ID.slice(0, 12)}` }),
    );
    const ledger = db.calls.find((c) => c.method === "values" && JSON.stringify(c.args).includes("withdrawal"));
    expect(JSON.stringify(ledger?.args)).toContain(HASH);
    expect(mockSync).toHaveBeenCalledWith(db, POOL_ID);
  });

  it("refuses the withdrawal and rolls back the reserved position when the server cannot sign the payout", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // pre-payout position reservation update
    db.queue([]); // rollback update on failure
    mockGetDb.mockReturnValue(db);
    mockPayout.mockRejectedValue(new PlatformWalletError("PLATFORM_WALLET_SECRET is not configured"));

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/PLATFORM_WALLET_SECRET/);
    expect(db.calls.filter((c) => c.method === "update")).toHaveLength(2);
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("returns 502 and rolls back the reserved position when the Stellar submission itself fails", async () => {
    const db = createFakeDb();
    queueWithdrawReads(db);
    db.queue([]); // pre-payout position reservation update
    db.queue([]); // rollback update on failure
    mockGetDb.mockReturnValue(db);
    mockPayout.mockRejectedValue(new Error("tx_bad_seq"));

    const res = await withdraw(request("/api/pools/withdraw", { positionId: POSITION_ID, amount: 40 }));
    expect(res.status).toBe(502);
    expect(db.calls.filter((c) => c.method === "update")).toHaveLength(2);
    expect(db.calls.some((c) => c.method === "insert")).toBe(false);
  });
});
