import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { verifyCronAuth, requireCronAuth } from "@/lib/auth/cron";

describe("Cron Authentication (lib/auth/cron)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function createRequest(authHeader?: string): NextRequest {
    const headers = new Headers();
    if (authHeader !== undefined) {
      headers.set("authorization", authHeader);
    }
    return new NextRequest("http://localhost/api/cron/liquidation", {
      method: "POST",
      headers,
    });
  }

  describe("when CRON_SECRET is missing", () => {
    it("allows execution in local development environment (NODE_ENV=development)", () => {
      process.env.NODE_ENV = "development";
      delete process.env.CRON_SECRET;

      const req = createRequest();
      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(true);

      const errorResponse = requireCronAuth(req);
      expect(errorResponse).toBeNull();
    });

    it("fails closed (500 Server Misconfigured) in production (NODE_ENV=production)", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.CRON_SECRET;

      const req = createRequest();
      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(false);
      expect(result.response?.status).toBe(500);

      const errorResponse = requireCronAuth(req);
      expect(errorResponse).not.toBeNull();
      expect(errorResponse?.status).toBe(500);
      expect(await errorResponse?.json()).toEqual({
        error: "Server Misconfigured: CRON_SECRET is not set",
      });
    });

    it("fails closed in test environment (NODE_ENV=test)", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.CRON_SECRET;

      const req = createRequest();
      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(false);
      expect(result.response?.status).toBe(500);
    });
  });

  describe("when CRON_SECRET is configured", () => {
    const SECRET = "super-secret-cron-token-123";

    beforeEach(() => {
      process.env.CRON_SECRET = SECRET;
    });

    it("authorizes request with matching Bearer token in production", () => {
      process.env.NODE_ENV = "production";
      const req = createRequest(`Bearer ${SECRET}`);

      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(true);

      const errorResponse = requireCronAuth(req);
      expect(errorResponse).toBeNull();
    });

    it("rejects request with missing Authorization header (401)", async () => {
      process.env.NODE_ENV = "production";
      const req = createRequest();

      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(false);
      expect(result.response?.status).toBe(401);

      const errorResponse = requireCronAuth(req);
      expect(errorResponse?.status).toBe(401);
      expect(await errorResponse?.json()).toEqual({
        error: "Unauthorized",
      });
    });

    it("rejects request with invalid Authorization header (401)", async () => {
      process.env.NODE_ENV = "production";
      const req = createRequest("Bearer wrong-secret");

      const result = verifyCronAuth(req);
      expect(result.authorized).toBe(false);
      expect(result.response?.status).toBe(401);
    });
  });
});
