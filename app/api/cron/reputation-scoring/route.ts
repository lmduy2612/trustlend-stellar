import { NextRequest, NextResponse } from "next/server";
import { runDailyReputationRecalculation } from "@/lib/reputation/daily-sync";
import { requireCronAuth } from "@/lib/auth/cron";

export async function POST(request: NextRequest) {
  try {
    const authError = requireCronAuth(request);
    if (authError) return authError;

    const summary = await runDailyReputationRecalculation();

    return NextResponse.json(
      {
        ok: true,
        message: "Daily borrower reputation recalculation completed",
        timestamp: new Date().toISOString(),
        ...summary,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Cron /api/cron/reputation-scoring] Execution error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal cron error",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
