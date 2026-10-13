import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { profiles, reputationSnapshots } from "@/lib/db/schema";
import {
  isWebhookConfigured,
  verifyWebhookSignature,
  mapProviderStatus,
  extractRejectionReason,
} from "@/lib/kyc/provider";
import type { SumSubWebhookPayload } from "@/lib/kyc/types";

/**
 * POST /api/kyc/webhook
 *
 * Receives KYC status updates from SumSub (or compatible provider).
 * SumSub sends a POST with JSON body + `x-payload-digest` header (HMAC-SHA256).
 *
 * Flow:
 *  1. Read raw body (needed for signature verification)
 *  2. Verify HMAC-SHA256 signature
 *  3. Parse payload → map to internal KYC status
 *  4. Update profiles table using service-role client (bypasses RLS)
 *  5. Grant/revoke regulated_pool_access based on outcome
 *
 * Returns 200 quickly — SumSub retries on non-2xx.
 */
export async function POST(request: NextRequest) {
  // ── 1. Read raw body for signature verification ────────────────────────────
  const rawBody = await request.text();
  const digestHeader =
    request.headers.get("x-payload-digest") ??
    request.headers.get("x-hmac-signature") ??
    "";

  // ── 2. Verify HMAC signature (fail closed in non-development environments) ───
  if (!isWebhookConfigured() && process.env.NODE_ENV !== "development") {
    console.error("[KYC Webhook] SUMSUB_WEBHOOK_SECRET is not configured in non-development environment — rejecting request");
    return NextResponse.json(
      { error: "Webhook signature verification service unconfigured" },
      { status: 503 }
    );
  }

  if (!verifyWebhookSignature(rawBody, digestHeader)) {
    console.error("[KYC Webhook] Invalid signature — rejecting request");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── 3. Parse payload ───────────────────────────────────────────────────────
  let payload: SumSubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SumSubWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { applicantId, externalUserId, type } = payload;

  if (!applicantId || !externalUserId) {
    return NextResponse.json(
      { error: "Missing applicantId or externalUserId" },
      { status: 400 }
    );
  }

  console.log(
    `[KYC Webhook] type=${type} applicantId=${applicantId} userId=${externalUserId}`
  );

  // ── 4. Map provider status → internal status ───────────────────────────────
  const newKycStatus = mapProviderStatus(payload);
  const rejectionReason = extractRejectionReason(payload);
  const isVerified = newKycStatus === "verified";

  // ── 5. Update profile in database ────────────────────────────────────────
  const db = getDb();
  if (!db) {
    // Don't fail the webhook — log and return 200 so SumSub doesn't retry endlessly
    console.error("[KYC Webhook] Database unavailable");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const updatePayload: Partial<typeof profiles.$inferInsert> = {
    kycStatus: newKycStatus,
    kycProviderId: applicantId,
    kycProviderStatus: type,
    regulatedPoolAccess: isVerified,
  };

  if (isVerified) {
    updatePayload.kycVerifiedAt = new Date();
    updatePayload.kycRejectionReason = null;
  } else if (newKycStatus === "rejected" && rejectionReason) {
    updatePayload.kycRejectionReason = rejectionReason;
  } else if (newKycStatus === "submitted") {
    updatePayload.kycSubmittedAt = new Date();
  }

  // Try lookup by our user UUID first (reliable), fallback to provider ID
  try {
    const updated = await db
      .update(profiles)
      .set(updatePayload)
      .where(eq(profiles.id, externalUserId))
      .returning({ id: profiles.id });

    if (updated.length === 0) {
      // Fallback: look up by kyc_provider_id (handles re-used applicants)
      await db.update(profiles).set(updatePayload).where(eq(profiles.kycProviderId, applicantId));
    }
  } catch (err) {
    console.error("[KYC Webhook] Failed to update profile:", err instanceof Error ? err.message : err);
    // Still return 200 — log error but don't trigger SumSub retries for DB issues
  }

  if (isVerified) {
    // Seed initial reputation snapshot on first verification
    try {
      await db
        .insert(reputationSnapshots)
        .values({ userId: externalUserId, scoreTotal: 100 })
        .onConflictDoUpdate({
          target: reputationSnapshots.userId,
          set: { scoreTotal: 100, updatedAt: sql`now()` },
        });
    } catch (err) {
      // Non-fatal — reputation will be seeded on next profile interaction
      console.warn("[KYC Webhook] Could not seed reputation:", err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `[KYC Webhook] ✅ Updated userId=${externalUserId} → status=${newKycStatus}`
  );

  // Always return 200 to acknowledge receipt
  return NextResponse.json({ received: true, status: newKycStatus }, { status: 200 });
}

/**
 * GET /api/kyc/webhook — health check for provider dashboard
 */
export async function GET(request: NextRequest) {
  // Lightweight rate limiting for webhook health-check endpoint
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  return NextResponse.json({
    ok: true,
    service: "TrustLend KYC Webhook",
    provider: "SumSub",
  });
}
