import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock Auth ─────────────────────────────────────────────────────────────────
const { mockRequireApiAdmin, MockUnauthorizedError } = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    constructor(message = "Not authenticated") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return {
    mockRequireApiAdmin: vi.fn(),
    MockUnauthorizedError,
  };
});

vi.mock("@/lib/auth/session", () => ({
  requireApiAdmin: () => mockRequireApiAdmin(),
  UnauthorizedError: MockUnauthorizedError,
}));

// ── Mock Rate Limiter ─────────────────────────────────────────────────────────
vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

// ── Mock Server Action ────────────────────────────────────────────────────────
const mockSetPoolBorrowCap = vi.fn();
vi.mock("@/app/actions/admin-pools", () => ({
  setPoolBorrowCap: (...args: unknown[]) => mockSetPoolBorrowCap(...args),
}));

import { PUT } from "@/app/api/admin/pools/[id]/borrow-cap/route";

function makeRequest(body?: unknown) {
  return new NextRequest("http://localhost/api/admin/pools/pool-123/borrow-cap", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("PUT /api/admin/pools/[id]/borrow-cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiAdmin.mockResolvedValue({
      id: "admin-1",
      email: "admin@trustlend.org",
      role: "admin",
    });
    mockSetPoolBorrowCap.mockResolvedValue({ success: true });
  });

  it("sets borrow cap successfully when valid positive number provided", async () => {
    const res = await PUT(makeRequest({ borrowCap: 50000 }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.borrowCap).toBe(50000);
    expect(json.poolId).toBe("pool-123");
    expect(mockSetPoolBorrowCap).toHaveBeenCalledWith("pool-123", 50000);
  });

  it("removes borrow cap when borrowCap is null", async () => {
    const res = await PUT(makeRequest({ borrowCap: null }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.borrowCap).toBeNull();
    expect(mockSetPoolBorrowCap).toHaveBeenCalledWith("pool-123", null);
  });

  it("rejects an unauthenticated caller with 401 JSON response", async () => {
    mockRequireApiAdmin.mockRejectedValue(new MockUnauthorizedError("Not authenticated"));

    const res = await PUT(makeRequest({ borrowCap: 50000 }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Not authenticated");
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized non-admin or unlisted caller with 403 JSON response", async () => {
    mockRequireApiAdmin.mockRejectedValue(new MockUnauthorizedError("Admin access required."));

    const res = await PUT(makeRequest({ borrowCap: 50000 }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Admin access required.");
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });

  it("returns 400 when borrowCap is a negative number or zero", async () => {
    const res = await PUT(makeRequest({ borrowCap: -100 }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("borrowCap must be a positive number");
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });

  it("returns 400 when request body is not valid JSON", async () => {
    const badReq = new NextRequest("http://localhost/api/admin/pools/pool-123/borrow-cap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    const res = await PUT(badReq, {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid JSON body");
  });

  it("returns 400 when setPoolBorrowCap fails", async () => {
    mockSetPoolBorrowCap.mockResolvedValue({ success: false, error: "Pool not found" });

    const res = await PUT(makeRequest({ borrowCap: 1000 }), {
      params: Promise.resolve({ id: "pool-123" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Pool not found");
  });
});
