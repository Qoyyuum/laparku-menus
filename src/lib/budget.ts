// Per-provider daily spend accounting on provider_budget(provider, day,
// calls). Shared by product-lookup (per-call budgets) and the gmaps_link
// provider chain (browser seconds + serpfast calls). `calls` is a generic
// counter — seconds for browser_run, requests for everything else.

import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { provider_budget } from "../db/schema";

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Hard-stops a provider once `limit` units went out today (UTC). The spend
// is recorded before the request — a timeout still consumed the attempt.
// The increment is a single conditional UPDATE (… WHERE calls < limit), so
// concurrent spenders can't overshoot the cap; a missing row falls back to
// INSERT … ON CONFLICT DO NOTHING, with one retry to absorb insert races.
export async function spendBudget(db: Db, provider: string, limit: number, day: string): Promise<boolean> {
  const inc = () =>
    db
      .update(provider_budget)
      .set({ calls: sql`${provider_budget.calls} + 1` })
      .where(
        and(
          eq(provider_budget.provider, provider),
          eq(provider_budget.day, day),
          lt(provider_budget.calls, limit),
        ),
      )
      .returning({ calls: provider_budget.calls });
  if ((await inc()).length > 0) return true;
  const inserted = await db
    .insert(provider_budget)
    .values({ provider, day, calls: 1 })
    .onConflictDoNothing()
    .returning({ calls: provider_budget.calls });
  if (inserted.length > 0) return true;
  return (await inc()).length > 0;
}

// Metered-amount variant for budgets counted in something other than
// calls (browser session-seconds). Splits the atomic guard from the
// write: budgetAvailable pre-checks, recordSpend adds the observed amount
// unconditionally after the fact. Post-hoc recording can drift a little
// over the cap under concurrency — acceptable for a budget meant to keep
// usage inside a free tier, not to enforce a hard contract.
export async function budgetAvailable(db: Db, provider: string, limit: number, day: string): Promise<boolean> {
  const [row] = await db
    .select({ calls: provider_budget.calls })
    .from(provider_budget)
    .where(and(eq(provider_budget.provider, provider), eq(provider_budget.day, day)))
    .limit(1);
  return (row?.calls ?? 0) < limit;
}

export async function recordSpend(db: Db, provider: string, day: string, amount: number): Promise<void> {
  const units = Math.max(1, Math.round(amount));
  const updated = await db
    .update(provider_budget)
    .set({ calls: sql`${provider_budget.calls} + ${units}` })
    .where(and(eq(provider_budget.provider, provider), eq(provider_budget.day, day)))
    .returning({ calls: provider_budget.calls });
  if (updated.length === 0) {
    await db
      .insert(provider_budget)
      .values({ provider, day, calls: units })
      .onConflictDoNothing();
  }
}
