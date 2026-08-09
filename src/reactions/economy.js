/* =========================================================================
 * REACTION ECONOMY
 *
 * What stops reactions from being free actions.
 *
 * Three independent gates, all serializable, all evaluated before a reaction
 * is offered and re-checked before it executes:
 *
 *   capacity   per-unit reaction points, refunded on a schedule
 *   pools      named shared pools any number of units can draw from
 *   limits     once-per-event / once-per-activation / once-per-battle
 *
 * Pools are the generic mechanism behind the Section Seven Link's shared
 * reaction economy. Nothing here knows that link exists — a pool is declared
 * by content, given an owner set, and drawn from by cost entries.
 * =======================================================================*/

export const DEFAULT_UNIT_CAPACITY = 1;

/** How a pool or a unit's capacity comes back. */
export const REFRESH_MODES = [
  // Refills when any owning unit begins an activation. Suits a tempo economy
  // on a continuous timeline, where there are no rounds to refresh on.
  "ownerActivation",
  // Refills when the unit itself begins an activation.
  "selfActivation",
  // Never refills on its own; only an effect can restore it.
  "manual"
];

export function createReactionEconomyState(poolDefinitions) {
  const pools = {};
  for (const pool of poolDefinitions || []) {
    pools[pool.id] = {
      current: pool.startsAt == null ? pool.max : pool.startsAt,
      max: pool.max,
      // Pools belonging to an inactive link are unavailable but keep their
      // value, so a link that flickers off and on does not hand out free points.
      available: false
    };
  }
  return {
    pools,
    units: {},
    /** reactionId -> count, for once-per-battle limits. */
    battleCounts: {},
    /** "<reactionId>@<activationIndex>" -> count. */
    activationCounts: {},
    /** "<reactionId>@<eventSeq>" -> true. One event is consumed once. */
    eventFired: {}
  };
}

function unitEntry(economy, unitId, capacity) {
  if (!economy.units[unitId]) {
    economy.units[unitId] = {
      current: capacity == null ? DEFAULT_UNIT_CAPACITY : capacity,
      max: capacity == null ? DEFAULT_UNIT_CAPACITY : capacity
    };
  }
  return economy.units[unitId];
}

export function unitCapacity(economy, unitId, capacity) {
  return unitEntry(economy, unitId, capacity);
}

export function poolState(economy, poolId) {
  return economy.pools[poolId] || null;
}

/** Marks a pool usable or not. An unavailable pool blocks every cost that
 *  draws on it, without destroying the points already banked. */
export function setPoolAvailable(economy, poolId, available, options) {
  const pool = economy.pools[poolId];
  if (!pool) return false;
  const was = pool.available;
  pool.available = !!available;
  // Coming back online refills by default: a link that reforms mid-battle
  // should be immediately usable rather than inheriting a spent pool.
  if (!was && pool.available && !(options && options.preserve)) {
    pool.current = pool.max;
  }
  return was !== pool.available;
}

export function refreshPool(economy, poolId, amount) {
  const pool = economy.pools[poolId];
  if (!pool) return 0;
  const before = pool.current;
  pool.current = Math.min(pool.max, pool.current + (amount == null ? pool.max : amount));
  return pool.current - before;
}

export function spendPool(economy, poolId, amount) {
  const pool = economy.pools[poolId];
  if (!pool || !pool.available || pool.current < amount) return false;
  pool.current -= amount;
  return true;
}

/**
 * Can this reaction be paid for right now?
 *
 * Returns `{ ok, reason }` rather than a boolean so the UI can explain why a
 * reaction is greyed out instead of silently omitting it.
 */
export function canAfford(economy, reaction, context) {
  const cost = reaction.cost || {};

  if (cost.reaction) {
    const entry = unitEntry(economy, context.unitId, context.unitCapacity);
    if (entry.current < cost.reaction) {
      return { ok: false, reason: "no reaction capacity left" };
    }
  }

  if (cost.pool) {
    const pool = economy.pools[cost.pool.id];
    if (!pool) return { ok: false, reason: 'unknown reaction pool "' + cost.pool.id + '"' };
    if (!pool.available) return { ok: false, reason: "the shared pool is not active" };
    if (pool.current < cost.pool.amount) {
      return { ok: false, reason: "the shared pool is empty" };
    }
  }

  const limits = reaction.limits || {};
  if (limits.perEvent !== false) {
    // Always on: one event instance can never fire the same reaction twice.
    if (economy.eventFired[reaction.id + "@" + context.eventSeq]) {
      return { ok: false, reason: "already reacted to this event" };
    }
  }
  if (limits.perActivation != null) {
    const key = reaction.id + "@" + context.activationCount;
    if ((economy.activationCounts[key] || 0) >= limits.perActivation) {
      return { ok: false, reason: "used up for this activation" };
    }
  }
  if (limits.perBattle != null) {
    if ((economy.battleCounts[reaction.id] || 0) >= limits.perBattle) {
      return { ok: false, reason: "used up for this battle" };
    }
  }

  return { ok: true, reason: null };
}

/** Deducts the cost and records the limit counters. Call only after
 *  `canAfford` and only immediately before executing. */
export function payCost(economy, reaction, context) {
  const cost = reaction.cost || {};
  const paid = { reaction: 0, pool: null };

  if (cost.reaction) {
    const entry = unitEntry(economy, context.unitId, context.unitCapacity);
    entry.current -= cost.reaction;
    paid.reaction = cost.reaction;
  }
  if (cost.pool) {
    if (!spendPool(economy, cost.pool.id, cost.pool.amount)) {
      // Should be impossible after canAfford, but refund rather than
      // half-charge if the world moved underneath us.
      if (paid.reaction) unitEntry(economy, context.unitId, context.unitCapacity).current += paid.reaction;
      return null;
    }
    paid.pool = { id: cost.pool.id, amount: cost.pool.amount };
  }

  economy.eventFired[reaction.id + "@" + context.eventSeq] = true;
  const activationKey = reaction.id + "@" + context.activationCount;
  economy.activationCounts[activationKey] = (economy.activationCounts[activationKey] || 0) + 1;
  economy.battleCounts[reaction.id] = (economy.battleCounts[reaction.id] || 0) + 1;

  return paid;
}

/** Refunds a payment. Used when a reaction turns out to be illegal at the
 *  moment of execution — a dead actor, a stale target, a faction that moved. */
export function refundCost(economy, paid, context) {
  if (!paid) return;
  if (paid.reaction) {
    const entry = unitEntry(economy, context.unitId, context.unitCapacity);
    entry.current = Math.min(entry.max, entry.current + paid.reaction);
  }
  if (paid.pool) refreshPool(economy, paid.pool.id, paid.pool.amount);
}

/**
 * Refresh hook, called when a unit begins an activation.
 *
 * `ownerActivation` pools regain one point when any of their owners acts,
 * capped at max — a bounded tempo economy rather than a full refill.
 */
export function onActivationStarted(economy, unitId, poolDefinitions, ownerUnitIds) {
  const entry = economy.units[unitId];
  if (entry) entry.current = entry.max;

  for (const pool of poolDefinitions || []) {
    const state = economy.pools[pool.id];
    if (!state || !state.available) continue;
    const mode = pool.refreshOn || "ownerActivation";
    if (mode === "manual") continue;
    if (mode === "selfActivation" && !(ownerUnitIds[pool.id] || []).includes(unitId)) continue;
    if (mode === "ownerActivation" && !(ownerUnitIds[pool.id] || []).includes(unitId)) continue;
    refreshPool(economy, pool.id, pool.refreshAmount == null ? 1 : pool.refreshAmount);
  }

  // Per-activation limits are keyed by activation index, so they expire on
  // their own — nothing to clear here, which keeps save/load trivially correct.
}

/** Snapshot for the HUD. Never mutates. */
export function describeEconomy(economy, poolDefinitions, unitIds) {
  return {
    pools: (poolDefinitions || []).map((pool) => ({
      id: pool.id,
      name: pool.name || pool.id,
      current: economy.pools[pool.id] ? economy.pools[pool.id].current : 0,
      max: pool.max,
      available: !!(economy.pools[pool.id] && economy.pools[pool.id].available)
    })),
    units: (unitIds || []).map((unitId) => ({
      unitId,
      current: economy.units[unitId] ? economy.units[unitId].current : DEFAULT_UNIT_CAPACITY,
      max: economy.units[unitId] ? economy.units[unitId].max : DEFAULT_UNIT_CAPACITY
    }))
  };
}
