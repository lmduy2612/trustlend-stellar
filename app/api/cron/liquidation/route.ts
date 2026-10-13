import { NextRequest, NextResponse } from "next/server";
import { getAdminKeypair } from "@/lib/stellar/server-contract";
import { loadConfig, runLiquidationKeeper } from "@/scripts/liquidation-keeper";
import { requireCronAuth } from "@/lib/auth/cron";

/**
 * POST/GET /api/cron/liquidation
 *
 * Automated Liquidation Bot (issue #259). Triggered every 5 minutes by
 * `.github/workflows/keepers.yml`, once a day by Vercel Cron (`vercel.json`,
 * the Hobby-plan ceiling) or any external scheduler (cURL, systemd).
 * Loads the keeper configuration from env, scans open loans for
 * under-collateralization, and automatically submits `mark_defaulted` for any
 * loan whose LTV has crossed the contract's dynamic liquidation threshold.
 *
 * Secured via CRON_SECRET in the Authorization header (`Bearer <secret>`), the
 * same scheme as the payment-due and default-management crons. The on-chain
 * liquidation call itself is additionally gated by `require_auth()` on
 * ADMIN_SECRET_KEY's address, so a leaked endpoint alone cannot move funds.
 */
export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const start = Date.now();
  try {
    const cfg = loadConfig([]);
    const signer = getAdminKeypair();
    const summary = await runLiquidationKeeper(cfg, signer);
    const duration = Date.now() - start;
    console.log(
      `[liquidation] Run complete in ${duration}ms: ` +
        `scanned=${summary.scanned} liquidated=${summary.liquidated} ` +
        `healthy=${summary.healthy} skipped=${summary.skipped} failed=${summary.failed}`
    );
    return NextResponse.json({ ok: true, ...summary, duration });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[liquidation] Keeper run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well.
export const GET = POST;

// Liquidation checks span many loans; allow long-running invocations.
export const maxDuration = 300;
