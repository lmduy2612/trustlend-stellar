import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockRunDailyReputationRecalculation = vi.fn();

vi.mock("@/lib/reputation/daily-sync", () => ({
  runDailyReputationRecalculation: () => mockRunDailyReputationRecalculation(),
}));

import { POST, GET } from "@/app/api/cron/reputation-scoring/route";

const SUMMARY = {
  scanned: 5,
  updated: 4,
  tierUpgrades: 1,
  errors: 0,
  details: [],
};

function authorizedRequest(token = "s3cret"): NextRequest {
  return new NextRequest("http://localhost/api/cron/reputation-scoring", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("POST & GET /api/cron/reputation-scoring", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
  });

  it("runs the daily calculation and returns the summary when authorized", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRunDailyReputationRecalculation.mockResolvedValue(SUMMARY);

    const response = await POST(authorizedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      scanned: 5,
      updated: 4,
      tierUpgrades: 1,
    });
    expect(mockRunDailyReputationRecalculation).toHaveBeenCalledOnce();
  });

  it("rejects unauthorized requests with invalid bearer token (401)", async () => {
    process.env.CRON_SECRET = "s3cret";

    const response = await POST(authorizedRequest("wrong-token"));
    expect(response.status).toBe(401);
    expect(mockRunDailyReputationRecalculation).not.toHaveBeenCalled();
  });

  it("runs via GET when authorized", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRunDailyReputationRecalculation.mockResolvedValue(SUMMARY);

    const req = new NextRequest("http://localhost/api/cron/reputation-scoring", {
      method: "GET",
      headers: { authorization: "Bearer s3cret" },
    });
    const response = await GET(req);
    expect(response.status).toBe(200);
  });

  it("runs without auth in development mode when CRON_SECRET is missing", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CRON_SECRET;
    mockRunDailyReputationRecalculation.mockResolvedValue(SUMMARY);

    const req = new NextRequest("http://localhost/api/cron/reputation-scoring", {
      method: "POST",
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(mockRunDailyReputationRecalculation).toHaveBeenCalledOnce();
  });

  it("fails closed with 500 in production when CRON_SECRET is missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CRON_SECRET;

    const req = new NextRequest("http://localhost/api/cron/reputation-scoring", {
      method: "POST",
    });
    const response = await POST(req);
    expect(response.status).toBe(500);
    expect(mockRunDailyReputationRecalculation).not.toHaveBeenCalled();
  });
});
