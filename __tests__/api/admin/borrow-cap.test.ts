import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockRequireApiAdmin, MockUnauthorizedError } = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
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

vi.mock("@/lib/rate-limit", () => ({
  enforceRouteRateLimit: vi.fn().mockResolvedValue(null),
}));

const mockSetPoolBorrowCap = vi.fn();
vi.mock("@/app/actions/admin-pools", () => ({
  setPoolBorrowCap: (...args: unknown[]) => mockSetPoolBorrowCap(...args),
}));

import { PUT } from "@/app/api/admin/pools/[id]/borrow-cap/route";

function makeRequest(poolId: string, body?: unknown) {
  return PUT(
    new NextRequest(`http://localhost/api/admin/pools/${poolId}/borrow-cap`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ id: poolId }) },
  );
}

describe("PUT /api/admin/pools/[id]/borrow-cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the user is unauthenticated", async () => {
    mockRequireApiAdmin.mockRejectedValue(
      new MockUnauthorizedError("Authentication required."),
    );

    const response = await makeRequest("pool-1", { borrowCap: 50000 });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Authentication required.",
    });
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not an authorized allowlisted admin", async () => {
    mockRequireApiAdmin.mockRejectedValue(
      new MockUnauthorizedError("Admin access required."),
    );

    const response = await makeRequest("pool-1", { borrowCap: 50000 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Admin access required.",
    });
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });

  it("updates borrow cap successfully for authorized admin", async () => {
    mockRequireApiAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mockSetPoolBorrowCap.mockResolvedValue({ success: true });

    const response = await makeRequest("pool-1", { borrowCap: 50000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      poolId: "pool-1",
      borrowCap: 50000,
    });
    expect(mockSetPoolBorrowCap).toHaveBeenCalledWith("pool-1", 50000);
  });

  it("clears borrow cap when borrowCap is null", async () => {
    mockRequireApiAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });
    mockSetPoolBorrowCap.mockResolvedValue({ success: true });

    const response = await makeRequest("pool-1", { borrowCap: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      poolId: "pool-1",
      borrowCap: null,
    });
    expect(mockSetPoolBorrowCap).toHaveBeenCalledWith("pool-1", null);
  });

  it("rejects non-positive borrow cap (400)", async () => {
    mockRequireApiAdmin.mockResolvedValue({ id: "admin-1", role: "admin" });

    const response = await makeRequest("pool-1", { borrowCap: -100 });
    expect(response.status).toBe(400);
    expect(mockSetPoolBorrowCap).not.toHaveBeenCalled();
  });
});
