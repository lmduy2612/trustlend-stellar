import { NextRequest, NextResponse } from "next/server";

export interface CronAuthResult {
  authorized: boolean;
  response?: NextResponse;
}

/**
 * Verify whether an incoming request to a scheduled cron endpoint is authorized.
 *
 * Rules:
 *  - In development (`process.env.NODE_ENV === "development"`), if `CRON_SECRET`
 *    is unset, unauthenticated requests are allowed for local developer convenience.
 *  - In all non-development environments (production, staging, test), if `CRON_SECRET` is unset,
 *    fails closed with 500 Server Misconfigured.
 *  - If `CRON_SECRET` is set, `Authorization: Bearer <CRON_SECRET>` is strictly required,
 *    returning 401 Unauthorized if missing or mismatched.
 */
export function verifyCronAuth(request: NextRequest): CronAuthResult {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      console.warn(
        "[Cron Auth] CRON_SECRET is not set — bypassing auth in development mode",
      );
      return { authorized: true };
    }
    console.error(
      "[Cron Auth] CRON_SECRET is not configured in non-development environment — failing closed",
    );
    return {
      authorized: false,
      response: NextResponse.json(
        { error: "Server Misconfigured: CRON_SECRET is not set" },
        { status: 500 },
      ),
    };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    return {
      authorized: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  return { authorized: true };
}

/**
 * Convenience guard for Next.js route handlers.
 * Returns an error `NextResponse` if unauthorized, or `null` if authorized.
 */
export function requireCronAuth(request: NextRequest): NextResponse | null {
  const result = verifyCronAuth(request);
  if (!result.authorized) {
    return (
      result.response ??
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
  }
  return null;
}
