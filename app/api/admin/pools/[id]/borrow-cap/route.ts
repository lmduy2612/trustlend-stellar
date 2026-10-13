import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { setPoolBorrowCap } from "@/app/actions/admin-pools";

/**
 * PUT /api/admin/pools/[id]/borrow-cap
 *
 * Set or clear the borrow cap for a lending pool.
 * Admin-only. Requires a valid session with role='admin' and allowlist check.
 *
 * Body: { borrowCap: number | null }
 *   - number: sets a hard ceiling (in XLM/USDC) on total_borrowed
 *   - null: removes the cap (unlimited)
 *
 * Response:
 *   200: { success: true }
 *   400: { error: string }
 *   401/403: auth/authz errors
 *   429: rate limited
 *   500: server error
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ── Rate limit ───────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    // ── Auth: admin only ─────────────────────────────────────────────────────
    await requireApiAdmin();

    const { id: poolId } = await params;
    if (!poolId) {
      return NextResponse.json({ error: "Pool ID is required" }, { status: 400 });
    }

    // ── Parse + validate body ────────────────────────────────────────────────
    let body: { borrowCap?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { borrowCap } = body;

    if (borrowCap !== null && borrowCap !== undefined) {
      const cap = Number(borrowCap);
      if (!Number.isFinite(cap) || cap <= 0) {
        return NextResponse.json(
          { error: "borrowCap must be a positive number, or null to remove the cap" },
          { status: 400 }
        );
      }
    }

    const capValue = borrowCap === null || borrowCap === undefined
      ? null
      : Number(borrowCap);

    // ── Apply via server action ──────────────────────────────────────────────
    const result = await setPoolBorrowCap(poolId, capValue);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(
      {
        success: true,
        poolId,
        borrowCap: capValue,
        message:
          capValue === null
            ? `Borrow cap removed from pool ${poolId}`
            : `Borrow cap set to ${capValue} XLM for pool ${poolId}`,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const status = error.message.includes("Authentication required") ? 401 : 403;
      return NextResponse.json({ success: false, error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
