import { NextRequest, NextResponse } from "next/server";
import { runPaymentDueScheduler } from "@/lib/scheduler/payment-due";
import { requireCronAuth } from "@/lib/auth/cron";

/**
 * POST /api/cron/payment-due
 *
 * Triggered by an external scheduler (e.g., Vercel Cron, GitHub Actions, cURL).
 * Secured via CRON_SECRET in the Authorization header.
 */
export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const start = Date.now();
  try {
    const result = await runPaymentDueScheduler();
    const duration = Date.now() - start;
    console.log(`[payment-due] Run complete in ${duration}ms:`, result);
    return NextResponse.json({ ok: true, ...result, duration });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[payment-due] Scheduler run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well
export const GET = POST;
