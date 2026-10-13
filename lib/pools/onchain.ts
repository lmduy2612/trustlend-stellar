/**
 * lib/pools/onchain.ts
 *
 * Mirrors lending-pool aggregates to the PooledLendingContract after a
 * verified deposit or withdrawal. The contract only tracks totals
 * (`update_pool_state(pool_id, total_supply, total_borrows)`), so after each
 * database change we push the pool's current liquidity and borrowed amounts.
 *
 * Like lib/loans/onchain.ts this never throws: the funds have already moved,
 * so a chain failure is reported back rather than unwinding the ledger.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { lendingPools } from "@/lib/db/schema";
import {
  isOnchainLifecycleRequired,
  pooledLendingContractId,
  setPoolConfigOnchain,
  syncPoolStateOnchain,
  xlmToStroops,
} from "@/lib/stellar/onchain-lifecycle";

export type PoolSyncOutcome =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; txHash: string; onchainPoolId: number }
  | { attempted: true; ok: false; error: string };

export async function syncPoolOnchain(db: Db, poolId: string): Promise<PoolSyncOutcome> {
  if (!isOnchainLifecycleRequired()) return { attempted: false, reason: "lifecycle off" };
  if (!pooledLendingContractId()) {
    return { attempted: false, reason: "NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID not configured" };
  }

  const [pool] = await db
    .select({
      onchainPoolId: lendingPools.onchainPoolId,
      totalLiquidity: lendingPools.totalLiquidity,
      totalBorrowed: lendingPools.totalBorrowed,
    })
    .from(lendingPools)
    .where(eq(lendingPools.id, poolId))
    .limit(1);

  if (!pool) return { attempted: false, reason: "pool not found" };
  if (pool.onchainPoolId === null || pool.onchainPoolId === undefined) {
    return { attempted: false, reason: "pool has no on-chain id (created before mirroring was enabled)" };
  }

  try {
    const totalSupply = xlmToStroops(Number(pool.totalLiquidity));
    const totalBorrows = xlmToStroops(Number(pool.totalBorrowed));
    const result = await syncPoolStateOnchain({
      onchainPoolId: pool.onchainPoolId,
      totalSupplyStroops: totalSupply < 0n ? 0n : totalSupply,
      totalBorrowsStroops: totalBorrows > totalSupply ? totalSupply : totalBorrows,
    });
    if (!result) return { attempted: false, reason: "pooled lending contract not configured" };
    return { attempted: true, ok: true, txHash: result.hash, onchainPoolId: pool.onchainPoolId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[onchain] update_pool_state failed for pool:", poolId, message);
    return { attempted: true, ok: false, error: message };
  }
}

/** Interest-rate curve every mirrored pool starts with (matches the deploy script). */
export const DEFAULT_POOL_CONFIG = {
  baseRateBps: 200,
  multiplierPerSlopeBps: 1000,
  jumpMultiplierBps: 10000,
  kinkBps: 8000,
  reserveFactorBps: 1000,
};

export type PoolRegisterOutcome =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; txHash: string; onchainPoolId: number }
  | { attempted: true; ok: false; error: string };

/**
 * Assign the next free on-chain pool id to a freshly created pool and
 * register its rate curve with `set_pool_config`. Pool 0 is created by the
 * deploy script, so ids are allocated from the highest one already stored.
 */
export async function registerPoolOnchain(db: Db, poolId: string): Promise<PoolRegisterOutcome> {
  if (!isOnchainLifecycleRequired()) return { attempted: false, reason: "lifecycle off" };
  if (!pooledLendingContractId()) {
    return { attempted: false, reason: "NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID not configured" };
  }

  const [row] = await db
    .select({ maxId: sql<number | null>`max(${lendingPools.onchainPoolId})` })
    .from(lendingPools);
  const onchainPoolId = row?.maxId === null || row?.maxId === undefined ? 0 : Number(row.maxId) + 1;

  try {
    const { hash } = await setPoolConfigOnchain(onchainPoolId, DEFAULT_POOL_CONFIG);
    await db.update(lendingPools).set({ onchainPoolId }).where(eq(lendingPools.id, poolId));
    return { attempted: true, ok: true, txHash: hash, onchainPoolId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[onchain] set_pool_config failed for pool ${poolId}:`, message);
    return { attempted: true, ok: false, error: message };
  }
}
