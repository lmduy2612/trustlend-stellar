/**
 * lib/loans/rate-config.ts
 *
 * Admin-tunable interest rate schedules for loan origination (issue #321).
 *
 * The loan application endpoint used to hardcode its APR ladder, so changing a
 * rate meant shipping a deployment. Rates now live in the
 * `interest_rate_configs` table: one active, versioned row per rate model that
 * admins publish from the dashboard.
 *
 * Pricing resolution order, applied by `priceLoanApr`:
 *   1. Start from the highest `amountTiers` entry whose `minAmount` the
 *      principal clears; fall back to `baseAprBps` when none match.
 *   2. Multiply by the highest `reputationTiers` entry whose `minScore` the
 *      borrower's trust score clears (10000 bps = 1.00x, so a 9000 multiplier
 *      is a 10% discount for trusted borrowers).
 *   3. Clamp into `[minAprBps, maxAprBps]`.
 *
 * Every quote carries the `version` of the schedule it came from. Origination
 * stamps that into `loans.metadata.rate_config_version`, which is what keeps
 * publishing a new schedule from silently repricing loans already in flight:
 * a loan's `apr_bps` column is written once, and later reads use the stored
 * column rather than re-deriving a rate. Floating-rate loans are the
 * deliberate exception — they are priced from the schedule that is active when
 * the rate is next recomputed, which is the point of the floating model.
 *
 * The DB is authoritative; `DEFAULT_RATE_CONFIGS` below mirrors the values that
 * were hardcoded before this change and is used only when the database is
 * unreachable or unseeded, so origination degrades to the old behaviour
 * instead of failing.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { interestRateConfigs } from "@/lib/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RateModel = "fixed" | "floating";

export const RATE_MODELS: readonly RateModel[] = ["fixed", "floating"] as const;

/** One rung of the principal ladder: loans at or above `minAmount` get `aprBps`. */
export interface AmountTier {
  /** Inclusive lower bound of the principal band, in XLM. */
  minAmount: number;
  /** APR for this band, in basis points (e.g. 1200 = 12.00%). */
  aprBps: number;
}

/** One rung of the trust ladder: scores at or above `minScore` get the multiplier. */
export interface ReputationTier {
  /** Inclusive lower bound of the trust score band. */
  minScore: number;
  /** Multiplier applied to the tier APR, in bps (10000 = 1.00x). */
  multiplierBps: number;
}

export interface InterestRateConfig {
  rateModel: RateModel;
  version: number;
  /** APR floor in bps used when no amount tier matches. */
  baseAprBps: number;
  minAprBps: number;
  maxAprBps: number;
  amountTiers: AmountTier[];
  reputationTiers: ReputationTier[];
  notes?: string | null;
  updatedByEmail?: string | null;
  updatedAt?: string | null;
}

/** A priced quote plus the inputs that produced it, for audit and display. */
export interface AprQuote {
  aprBps: number;
  rateModel: RateModel;
  /** Schedule version this quote came from; stamped onto the loan. */
  configVersion: number;
  /** APR after the amount tier, before the reputation multiplier. */
  tierAprBps: number;
  /** Reputation multiplier that was applied, in bps. */
  reputationMultiplierBps: number;
  /** `minAmount` of the matched amount tier, or null when the base rate was used. */
  matchedAmountTier: number | null;
  /** True when the clamp changed the computed rate. */
  clamped: boolean;
  /** True when the schedule came from code defaults, not the database. */
  usedFallback: boolean;
}

// ─── Bounds ───────────────────────────────────────────────────────────────────

export const RATE_CONFIG_BOUNDS = {
  /** Highest APR an admin may configure anywhere in a schedule: 100%. */
  MAX_APR_BPS: 10000,
  /** Lowest APR floor an admin may configure: 0%. */
  MIN_APR_BPS: 0,
  /** 0.10x — guards against a multiplier that zeroes out interest. */
  MIN_MULTIPLIER_BPS: 1000,
  /** 3.00x — guards against a multiplier that triples the quoted rate. */
  MAX_MULTIPLIER_BPS: 30000,
  MAX_AMOUNT_TIERS: 10,
  MAX_REPUTATION_TIERS: 10,
  /** Minimum characters of rationale required to publish a schedule. */
  MIN_NOTES_LENGTH: 5,
} as const;

// ─── Code defaults (fallback only) ────────────────────────────────────────────

/**
 * Mirrors the APR ladder that was hardcoded in app/api/loans/apply/route.ts
 * before issue #321. Used only when the database has no active schedule.
 *
 * The thresholds are nudged past the round numbers because the old ladder used
 * a strict `amount > 1000` while tiers match on `amount >= minAmount`: this
 * keeps a loan of exactly 1000 or 2000 XLM priced as it was before.
 */
export const DEFAULT_RATE_CONFIGS: Record<RateModel, InterestRateConfig> = {
  fixed: {
    rateModel: "fixed",
    version: 0,
    baseAprBps: 1500, // 15% default
    minAprBps: 100,
    maxAprBps: 5000,
    amountTiers: [
      { minAmount: 1000.000001, aprBps: 1200 }, // 12%
      { minAmount: 2000.000001, aprBps: 1000 }, // 10%
    ],
    reputationTiers: [
      { minScore: 0, multiplierBps: 10000 },
      { minScore: 500, multiplierBps: 10000 },
      { minScore: 750, multiplierBps: 10000 },
    ],
    notes: "Code default — no active schedule found in the database",
  },
  floating: {
    rateModel: "floating",
    version: 0,
    baseAprBps: 500, // 5% base floating rate
    minAprBps: 100,
    maxAprBps: 5000,
    amountTiers: [
      { minAmount: 1000.000001, aprBps: 450 }, // 4.5%
      { minAmount: 2000.000001, aprBps: 400 }, // 4%
    ],
    reputationTiers: [
      { minScore: 0, multiplierBps: 10000 },
      { minScore: 500, multiplierBps: 10000 },
      { minScore: 750, multiplierBps: 10000 },
    ],
    notes: "Code default — no active schedule found in the database",
  },
};

// ─── Parsing ──────────────────────────────────────────────────────────────────

export function isRateModel(value: unknown): value is RateModel {
  return value === "fixed" || value === "floating";
}

/**
 * Coerces a jsonb amount-tier array into a sorted, well-formed ladder.
 * Malformed entries are dropped rather than throwing: a bad row must not take
 * loan origination down.
 */
export function parseAmountTiers(raw: unknown): AmountTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const tier = entry as Record<string, unknown>;
      const minAmount = Number(tier.minAmount ?? tier.min_amount);
      const aprBps = Number(tier.aprBps ?? tier.apr_bps);
      if (!Number.isFinite(minAmount) || minAmount < 0) return null;
      if (!Number.isFinite(aprBps) || aprBps < 0) return null;
      return { minAmount, aprBps: Math.round(aprBps) };
    })
    .filter((tier): tier is AmountTier => tier !== null)
    .sort((a, b) => a.minAmount - b.minAmount);
}

/** Same contract as `parseAmountTiers`, for the reputation ladder. */
export function parseReputationTiers(raw: unknown): ReputationTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const tier = entry as Record<string, unknown>;
      const minScore = Number(tier.minScore ?? tier.min_score);
      const multiplierBps = Number(tier.multiplierBps ?? tier.multiplier_bps);
      if (!Number.isFinite(minScore) || minScore < 0) return null;
      if (!Number.isFinite(multiplierBps) || multiplierBps <= 0) return null;
      return { minScore, multiplierBps: Math.round(multiplierBps) };
    })
    .filter((tier): tier is ReputationTier => tier !== null)
    .sort((a, b) => a.minScore - b.minScore);
}

// ─── Pricing math (pure) ──────────────────────────────────────────────────────

/**
 * Highest amount tier the principal clears, or null when none apply.
 * Does not assume the ladder is sorted — the UI builds drafts in edit order.
 */
export function selectAmountTier(config: InterestRateConfig, amount: number): AmountTier | null {
  let matched: AmountTier | null = null;
  for (const tier of config.amountTiers) {
    if (amount >= tier.minAmount && (matched === null || tier.minAmount >= matched.minAmount)) {
      matched = tier;
    }
  }
  return matched;
}

/** Highest reputation tier the score clears; neutral 1.00x when none apply. */
export function selectReputationMultiplierBps(
  config: InterestRateConfig,
  reputationScore: number,
): number {
  let best: ReputationTier | null = null;
  for (const tier of config.reputationTiers) {
    if (reputationScore >= tier.minScore && (best === null || tier.minScore >= best.minScore)) {
      best = tier;
    }
  }
  return best ? best.multiplierBps : 10000;
}

/**
 * Prices a loan against a schedule. Pure — the same inputs always produce the
 * same quote, which is what makes the preflight estimate and the committed
 * loan agree.
 */
export function priceLoanApr(
  config: InterestRateConfig,
  params: { amount: number; reputationScore: number; usedFallback?: boolean },
): AprQuote {
  const { amount, reputationScore } = params;

  const matched = selectAmountTier(config, amount);
  const tierAprBps = matched ? matched.aprBps : config.baseAprBps;

  const reputationMultiplierBps = selectReputationMultiplierBps(config, reputationScore);
  const adjusted = Math.round((tierAprBps * reputationMultiplierBps) / 10000);

  // Guard against an inverted min/max slipping through, so the clamp can never
  // produce a rate outside the admin's own stated ceiling.
  const floor = Math.min(config.minAprBps, config.maxAprBps);
  const ceiling = Math.max(config.minAprBps, config.maxAprBps);
  const aprBps = Math.max(floor, Math.min(ceiling, adjusted));

  return {
    aprBps,
    rateModel: config.rateModel,
    configVersion: config.version,
    tierAprBps,
    reputationMultiplierBps,
    matchedAmountTier: matched ? matched.minAmount : null,
    clamped: aprBps !== adjusted,
    usedFallback: params.usedFallback ?? false,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

type ConfigRow = {
  rateModel: string;
  version: number;
  baseAprBps: number;
  minAprBps: number;
  maxAprBps: number;
  amountTiers: unknown;
  reputationTiers: unknown;
  notes: string | null;
  updatedByEmail: string | null;
  updatedAt: Date | string | null;
};

function rowToConfig(row: ConfigRow): InterestRateConfig {
  return {
    rateModel: isRateModel(row.rateModel) ? row.rateModel : "fixed",
    version: Number(row.version),
    baseAprBps: Number(row.baseAprBps),
    minAprBps: Number(row.minAprBps),
    maxAprBps: Number(row.maxAprBps),
    amountTiers: parseAmountTiers(row.amountTiers),
    reputationTiers: parseReputationTiers(row.reputationTiers),
    notes: row.notes,
    updatedByEmail: row.updatedByEmail,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ?? null),
  };
}

const CONFIG_COLUMNS = {
  rateModel: interestRateConfigs.rateModel,
  version: interestRateConfigs.version,
  baseAprBps: interestRateConfigs.baseAprBps,
  minAprBps: interestRateConfigs.minAprBps,
  maxAprBps: interestRateConfigs.maxAprBps,
  amountTiers: interestRateConfigs.amountTiers,
  reputationTiers: interestRateConfigs.reputationTiers,
  notes: interestRateConfigs.notes,
  updatedByEmail: interestRateConfigs.updatedByEmail,
  updatedAt: interestRateConfigs.updatedAt,
};

/**
 * Loads the active schedule for a rate model.
 *
 * Never throws: on a database error or an unseeded table it returns the code
 * default with `usedFallback: true`, because refusing to originate loans is a
 * worse failure than pricing them at the pre-#321 rates. Callers that care
 * (the admin dashboard) surface the flag.
 */
export async function getActiveRateConfig(
  db: Db | null,
  rateModel: RateModel,
): Promise<{ config: InterestRateConfig; usedFallback: boolean }> {
  if (!db) {
    return { config: DEFAULT_RATE_CONFIGS[rateModel], usedFallback: true };
  }

  try {
    const [row] = await db
      .select(CONFIG_COLUMNS)
      .from(interestRateConfigs)
      .where(
        and(eq(interestRateConfigs.rateModel, rateModel), eq(interestRateConfigs.isActive, true)),
      )
      .limit(1);

    if (!row) {
      return { config: DEFAULT_RATE_CONFIGS[rateModel], usedFallback: true };
    }

    return { config: rowToConfig(row as ConfigRow), usedFallback: false };
  } catch (error) {
    console.error("Failed to load active rate config, using defaults:", rateModel, error);
    return { config: DEFAULT_RATE_CONFIGS[rateModel], usedFallback: true };
  }
}

/** Active schedules for every rate model, keyed by model. */
export async function getActiveRateConfigs(
  db: Db | null,
): Promise<{ configs: Record<RateModel, InterestRateConfig>; usedFallback: boolean }> {
  const results = await Promise.all(
    RATE_MODELS.map(async (model) => [model, await getActiveRateConfig(db, model)] as const),
  );

  const configs = {} as Record<RateModel, InterestRateConfig>;
  let usedFallback = false;
  for (const [model, result] of results) {
    configs[model] = result.config;
    usedFallback = usedFallback || result.usedFallback;
  }

  return { configs, usedFallback };
}

/** Published history for a rate model, newest first. Powers the audit trail. */
export async function getRateConfigHistory(
  db: Db | null,
  limit = 20,
): Promise<InterestRateConfig[]> {
  if (!db) return [];
  try {
    const rows = await db
      .select(CONFIG_COLUMNS)
      .from(interestRateConfigs)
      .orderBy(desc(interestRateConfigs.createdAt))
      .limit(limit);
    return (rows as ConfigRow[]).map(rowToConfig);
  } catch (error) {
    console.error("Failed to load rate config history:", error);
    return [];
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface RateConfigDraft {
  baseAprBps: number;
  minAprBps: number;
  maxAprBps: number;
  amountTiers: AmountTier[];
  reputationTiers: ReputationTier[];
}

/**
 * Validates an admin-submitted schedule before it is published.
 *
 * Stricter than `parseAmountTiers`, which silently drops junk: an admin typing
 * a bad number deserves an error, not a quietly different schedule.
 */
export function validateRateConfigDraft(draft: Partial<RateConfigDraft>): {
  valid: boolean;
  error?: string;
} {
  const { MAX_APR_BPS, MIN_APR_BPS, MIN_MULTIPLIER_BPS, MAX_MULTIPLIER_BPS } = RATE_CONFIG_BOUNDS;

  const scalars: [string, unknown][] = [
    ["baseAprBps", draft.baseAprBps],
    ["minAprBps", draft.minAprBps],
    ["maxAprBps", draft.maxAprBps],
  ];
  for (const [name, value] of scalars) {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      return { valid: false, error: `${name} must be a whole number of basis points` };
    }
    if (num < MIN_APR_BPS || num > MAX_APR_BPS) {
      return {
        valid: false,
        error: `${name} must be between ${MIN_APR_BPS / 100}% and ${MAX_APR_BPS / 100}%`,
      };
    }
  }

  if (Number(draft.minAprBps) > Number(draft.maxAprBps)) {
    return { valid: false, error: "Minimum APR cannot exceed maximum APR" };
  }

  if (!Array.isArray(draft.amountTiers)) {
    return { valid: false, error: "amountTiers must be an array" };
  }
  if (draft.amountTiers.length > RATE_CONFIG_BOUNDS.MAX_AMOUNT_TIERS) {
    return {
      valid: false,
      error: `At most ${RATE_CONFIG_BOUNDS.MAX_AMOUNT_TIERS} amount tiers are allowed`,
    };
  }

  const seenAmounts = new Set<number>();
  for (const tier of draft.amountTiers) {
    const minAmount = Number(tier?.minAmount);
    const aprBps = Number(tier?.aprBps);
    if (!Number.isFinite(minAmount) || minAmount < 0) {
      return { valid: false, error: "Each amount tier needs a minAmount of 0 or more" };
    }
    if (!Number.isFinite(aprBps) || !Number.isInteger(aprBps) || aprBps < 0 || aprBps > MAX_APR_BPS) {
      return {
        valid: false,
        error: `Each amount tier APR must be a whole number between 0% and ${MAX_APR_BPS / 100}%`,
      };
    }
    if (seenAmounts.has(minAmount)) {
      return { valid: false, error: `Duplicate amount tier threshold: ${minAmount}` };
    }
    seenAmounts.add(minAmount);
  }

  if (!Array.isArray(draft.reputationTiers)) {
    return { valid: false, error: "reputationTiers must be an array" };
  }
  if (draft.reputationTiers.length > RATE_CONFIG_BOUNDS.MAX_REPUTATION_TIERS) {
    return {
      valid: false,
      error: `At most ${RATE_CONFIG_BOUNDS.MAX_REPUTATION_TIERS} reputation tiers are allowed`,
    };
  }

  const seenScores = new Set<number>();
  for (const tier of draft.reputationTiers) {
    const minScore = Number(tier?.minScore);
    const multiplierBps = Number(tier?.multiplierBps);
    if (!Number.isFinite(minScore) || minScore < 0) {
      return { valid: false, error: "Each reputation tier needs a minScore of 0 or more" };
    }
    if (
      !Number.isFinite(multiplierBps) ||
      !Number.isInteger(multiplierBps) ||
      multiplierBps < MIN_MULTIPLIER_BPS ||
      multiplierBps > MAX_MULTIPLIER_BPS
    ) {
      return {
        valid: false,
        error: `Reputation multipliers must be whole basis points between ${
          MIN_MULTIPLIER_BPS / 100
        }x and ${MAX_MULTIPLIER_BPS / 100}x`,
      };
    }
    if (seenScores.has(minScore)) {
      return { valid: false, error: `Duplicate reputation tier threshold: ${minScore}` };
    }
    seenScores.add(minScore);
  }

  return { valid: true };
}

/** Sample quotes across principal bands, for previewing a schedule in the UI. */
export function previewRateSchedule(
  config: InterestRateConfig,
  amounts: number[] = [100, 500, 1000, 2000, 5000],
  reputationScore = 250,
) {
  return amounts.map((amount) => {
    const quote = priceLoanApr(config, { amount, reputationScore });
    return {
      amount,
      aprBps: quote.aprBps,
      aprPct: Number((quote.aprBps / 100).toFixed(2)),
      matchedAmountTier: quote.matchedAmountTier,
    };
  });
}
