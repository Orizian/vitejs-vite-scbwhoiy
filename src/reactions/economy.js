/* =========================================================================
 * REACTION ECONOMY
 *
 * What stops reactions from being free actions.
 *
 * Two independent gates, both serializable, both evaluated before a reaction
 * is offered and re-checked immediately before it executes:
 *
 *   cost     resource amounts, drawn through `src/combat/resources.js`
 *   limits   once per event / chain / activation / battle
 *
 * This module used to own a second pool implementation of its own. It no
 * longer owns any balances at all: a reaction cost is an ordinary resource
 * spend, so a squad's Command Points and a unit's reaction capacity are the
 * same mechanism as a chassis's ammunition, and an ability could charge for
 * either without a line of new code.
 *
 * What stays here is the part that is genuinely about reactions: the counters
 * that stop the same response firing twice off one cause.
 * =======================================================================*/

import {
  normalizeResourceDefinition,
  canSpendResource,
  spendResource,
  gainResource
} from "../combat/resources.js";

export function createReactionEconomyState() {
  return {
    /** reactionId -> count, for once-per-battle limits. */
    battleCounts: {},
    /** "<reactionId>@<activationIndex>" -> count. */
    activationCounts: {},
    /** "<reactionId>@<eventSeq>" -> true. One event is consumed once. */
    eventFired: {},
    /** "<reactionId>@<chainId>" -> count. Bounds a cascade without banning it. */
    chainCounts: {}
  };
}

/** Every resource a cost draws on, as `{ definition, amount, owner }`. */
function costEntries(reaction, context) {
  const cost = reaction.cost || {};
  const out = [];
  for (const entry of cost.resources || []) {
    const raw = context.resourceById(entry.id);
    if (!raw) {
      out.push({ definition: null, id: entry.id, amount: entry.amount || 1, owner: null });
      continue;
    }
    const definition = normalizeResourceDefinition({ id: entry.id, ...raw });
    out.push({
      definition,
      id: entry.id,
      amount: entry.amount == null ? 1 : entry.amount,
      owner: definition.scope === "faction" ? { teamId: context.teamId } : { unitId: context.unitId }
    });
  }
  return out;
}

/**
 * Can this reaction be paid for right now?
 *
 * Returns `{ ok, reason }` rather than a boolean so the UI can explain why a
 * reaction is greyed out instead of silently omitting it. "Not enough Command
 * Points" is a tactical fact the player needs; a missing menu entry is a bug
 * report.
 */
export function canAfford(state, economy, reaction, context) {
  // Limits first, and the distinction between the two halves matters. A limit
  // failure means the reaction does not apply and should not be shown at all.
  // A cost failure means it applies and you cannot pay — which the player
  // needs to see, because that is a tactical fact about the shortage.
  const limits = reaction.limits || {};
  if (limits.perEvent !== false) {
    // Always on: one event instance can never fire the same reaction twice.
    if (economy.eventFired[reaction.id + "@" + context.eventSeq]) {
      return { ok: false, kind: "limit", reason: "already reacted to this event" };
    }
  }
  if (limits.perChain != null && context.chainId) {
    const key = reaction.id + "@" + context.chainId;
    if ((economy.chainCounts[key] || 0) >= limits.perChain) {
      return { ok: false, kind: "limit", reason: "already fired in this chain" };
    }
  }
  if (limits.perActivation != null) {
    const key = reaction.id + "@" + context.activationCount;
    if ((economy.activationCounts[key] || 0) >= limits.perActivation) {
      return { ok: false, kind: "limit", reason: "used up for this activation" };
    }
  }
  if (limits.perBattle != null) {
    if ((economy.battleCounts[reaction.id] || 0) >= limits.perBattle) {
      return { ok: false, kind: "limit", reason: "used up for this battle" };
    }
  }

  for (const entry of costEntries(reaction, context)) {
    if (!entry.definition) {
      return { ok: false, kind: "limit", reason: 'unknown resource "' + entry.id + '"' };
    }
    const check = canSpendResource(state, entry.definition, entry.owner, entry.amount);
    if (!check.ok) return { ...check, kind: "cost" };
  }

  return { ok: true, kind: null, reason: null };
}

/** Deducts the cost and records the limit counters. Call only after
 *  `canAfford` and only immediately before executing. */
export function payCost(state, economy, reaction, context) {
  const entries = costEntries(reaction, context);
  const paid = [];

  for (const entry of entries) {
    if (!entry.definition || !spendResource(state, entry.definition, entry.owner, entry.amount)) {
      // Should be impossible after canAfford, but refund rather than
      // half-charge if the world moved underneath us.
      for (const done of paid) gainResource(state, done.definition, done.owner, done.amount);
      return null;
    }
    paid.push(entry);
  }

  economy.eventFired[reaction.id + "@" + context.eventSeq] = true;
  if (context.chainId) {
    const chainKey = reaction.id + "@" + context.chainId;
    economy.chainCounts[chainKey] = (economy.chainCounts[chainKey] || 0) + 1;
  }
  const activationKey = reaction.id + "@" + context.activationCount;
  economy.activationCounts[activationKey] = (economy.activationCounts[activationKey] || 0) + 1;
  economy.battleCounts[reaction.id] = (economy.battleCounts[reaction.id] || 0) + 1;

  return paid;
}

/** Refunds a payment. Used when a reaction turns out to be illegal at the
 *  moment of execution — a dead actor, a stale target, a faction that moved. */
export function refundCost(state, paid) {
  for (const entry of paid || []) {
    gainResource(state, entry.definition, entry.owner, entry.amount);
  }
}

/** Human-readable cost, for the prompt. */
export function describeCost(cost, resourceById) {
  const parts = [];
  for (const entry of (cost && cost.resources) || []) {
    const definition = resourceById ? resourceById(entry.id) : null;
    parts.push((entry.amount == null ? 1 : entry.amount) + " " + ((definition && definition.name) || entry.id));
  }
  return parts.join(" + ") || "free";
}
