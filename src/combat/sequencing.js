/* =========================================================================
 * ACTIVATION SEQUENCING
 *
 * Taking several activations that are already coming and choosing what order
 * they happen in.
 *
 * Not extra turns. Not speed. Nobody acts twice, nobody loses a turn, and
 * nothing is refunded — the same units act the same number of times, in a
 * different sequence. That restriction is the whole design: a commander who
 * grants turns is a commander who breaks the initiative system, and a
 * commander who only sequences is one who makes the initiative system the
 * interesting part.
 *
 * WHY THIS IS NOT A TIMESTAMP REWRITE
 *
 * The obvious implementation is to permute the units' `nextActionTime` values
 * among themselves. It is wrong twice over:
 *
 *   1. It cannot express every permutation. Two units sharing a timestamp are
 *      separated by the timeline's tie-breaks — speed, then creation order —
 *      so re-dealing equal numbers silently re-sorts them back. The player's
 *      chosen order just does not happen, with nothing reported.
 *
 *   2. A rewritten timestamp is a lie every other reader believes. `turnEnded`
 *      recovery, timeline modifiers and the HUD all treat that number as *when
 *      this unit acts*; a commander who edits it has moved the goalposts for
 *      anything that later does arithmetic on it.
 *
 * So this is a **view over time, not a rewrite**. A plan captures the
 * timestamps the selected units already own and re-deals that exact multiset
 * in the commanded order. The comparator consults the dealt slot instead of
 * the unit's own time — and breaks ties by the commanded index, which is what
 * makes every permutation expressible even when the numbers collide.
 *
 * `nextActionTime` is never touched. Ordinary haste and delay keep operating
 * on the truth, a save is exact because it is the same plain numbers, and when
 * the window is spent the layer empties and ordering reverts to plain time
 * with nothing to clean up.
 * =======================================================================*/

/** What a command may do about hostile activations inside the span it covers. */
export const HOSTILE_BARRIER_MODES = ["stop", "ignore"];

/** Who a command may sequence. */
export const WINDOW_RELATIONSHIPS = ["allied", "any"];

/** Stable reasons a unit is not eligible. Rendered by the UI and asserted by
 *  tests, so they are ids as much as they are prose. */
export const INELIGIBLE_REASONS = {
  beyondWindow: "too far ahead to command",
  behindBarrier: "an enemy acts first",
  notAllied: "not yours to command",
  currentlyActing: "already acting",
  cannotAct: "cannot act",
  beyondReach: "more than this command can sequence"
};

export const ORDER_REFUSALS = {
  empty: "no units selected",
  duplicate: "a unit was selected twice",
  unknown: "that unit is not in the command window",
  ineligible: "that unit cannot be commanded",
  tooMany: "more units than this command can sequence",
  stale: "the timeline moved since that plan was made"
};

/* ---------------------------------------------------------------
 * STATE
 * -------------------------------------------------------------*/

export function createSequencingState() {
  return {
    /** Dealt slots in commanded order. Empty means ordinary time rules. */
    entries: [],
    issuedBy: null,
    abilityId: null,
    issuedAt: 0
  };
}

export function sequenceIsActive(collection) {
  return !!(collection && collection.entries && collection.entries.length);
}

/* ---------------------------------------------------------------
 * PLANNING
 * -------------------------------------------------------------*/

/**
 * Which upcoming activations a command may sequence.
 *
 * Pure, and pure over an abstract entry list rather than over a battle: the
 * preview, the validator, the executor and the tests all call this, and none
 * of them should be able to disagree about what the window contains.
 *
 * @param entries  already ordered `{ unitId, time, relationship, actionable, active }`
 * @param options  `{ now, lookahead, maxUnits, relationship, hostileBarrier, includeActive }`
 */
export function planActivationWindow(entries, options) {
  const opts = options || {};
  const now = opts.now == null ? 0 : opts.now;
  const lookahead = opts.lookahead == null ? Infinity : opts.lookahead;
  const maxUnits = opts.maxUnits == null ? Infinity : opts.maxUnits;
  const wants = opts.relationship || "allied";
  const barrierMode = opts.hostileBarrier || "stop";
  const includeActive = opts.includeActive === true;

  const out = [];
  let barrier = null;
  let eligibleCount = 0;
  let stopped = false;

  for (const entry of entries || []) {
    const delay = entry.time - now;
    const record = {
      unitId: entry.unitId,
      time: entry.time,
      // The unit's own clock, which is not the same thing as its position when
      // a command is already in force. The slot is what decides order; the
      // clock is what decides whether the command still speaks for this unit.
      scheduledTime: entry.scheduledTime == null ? entry.time : entry.scheduledTime,
      delay,
      relationship: entry.relationship,
      // Where this unit sat before anybody commanded anything. The UI shows it
      // and the executor compares against it, so a reorder is always described
      // against something concrete.
      originalOrder: out.length,
      eligible: false,
      reason: null
    };
    out.push(record);

    if (stopped) {
      record.reason = barrier ? INELIGIBLE_REASONS.behindBarrier : INELIGIBLE_REASONS.beyondWindow;
      continue;
    }
    if (delay > lookahead) {
      // Everything after this is further away still, so the window is closed
      // rather than merely skipping this one.
      record.reason = INELIGIBLE_REASONS.beyondWindow;
      stopped = true;
      continue;
    }
    if (entry.active && !includeActive) {
      // The commanding unit is standing in the present, not in the queue. Its
      // slot is being spent right now and there is nothing to reorder.
      record.reason = INELIGIBLE_REASONS.currentlyActing;
      continue;
    }
    if (!entry.actionable) {
      record.reason = INELIGIBLE_REASONS.cannotAct;
      continue;
    }
    if (wants === "allied" && entry.relationship === "hostile") {
      // The barrier rule, and the reason initiative stays a real system: a
      // commander rearranges her own people, she does not shuffle the enemy's
      // turn to the back of the queue.
      record.reason = INELIGIBLE_REASONS.behindBarrier;
      if (barrierMode === "stop") {
        barrier = { unitId: entry.unitId, time: entry.time };
        stopped = true;
      }
      continue;
    }
    if (wants === "allied" && entry.relationship !== "allied" && entry.relationship !== "self") {
      record.reason = INELIGIBLE_REASONS.notAllied;
      continue;
    }
    if (eligibleCount >= maxUnits) {
      record.reason = INELIGIBLE_REASONS.beyondReach;
      continue;
    }
    record.eligible = true;
    eligibleCount += 1;
  }

  const eligible = out.filter((record) => record.eligible);
  return {
    now,
    lookahead,
    maxUnits,
    relationship: wants,
    hostileBarrier: barrierMode,
    entries: out,
    eligibleIds: eligible.map((record) => record.unitId),
    /** The natural order of the eligible units, for the before/after report. */
    naturalOrder: eligible.map((record) => record.unitId),
    barrier,
    windowStart: out.length ? out[0].time : now,
    windowEnd: eligible.length ? eligible[eligible.length - 1].time : now
  };
}

/* ---------------------------------------------------------------
 * VALIDATING AND DEALING
 * -------------------------------------------------------------*/

/**
 * Whether a chosen order is a legal permutation of a subset of the window.
 *
 * A subset is allowed on purpose: choosing three of four eligible units
 * permutes those three among the three slots *they* held, and the fourth keeps
 * its own. Requiring the whole window would make the interaction all-or-
 * nothing for no gain.
 */
export function validateOrder(plan, order) {
  const chosen = order || [];
  if (!chosen.length) return { ok: false, reason: ORDER_REFUSALS.empty };
  if (chosen.length > plan.maxUnits) return { ok: false, reason: ORDER_REFUSALS.tooMany };

  const seen = new Set();
  const byId = new Map(plan.entries.map((record) => [record.unitId, record]));
  for (const unitId of chosen) {
    if (seen.has(unitId)) return { ok: false, reason: ORDER_REFUSALS.duplicate, unitId };
    seen.add(unitId);
    const record = byId.get(unitId);
    if (!record) return { ok: false, reason: ORDER_REFUSALS.unknown, unitId };
    if (!record.eligible) {
      return { ok: false, reason: record.reason || ORDER_REFUSALS.ineligible, unitId };
    }
  }
  return { ok: true, reason: null, selected: chosen.slice() };
}

/**
 * Re-deals the selected units' own timestamps in the commanded order.
 *
 * The multiset of slots is exactly the multiset those units already owned, so
 * nobody outside the selection shifts by even one position, and the total
 * number of activations is unchanged by construction rather than by promise.
 */
export function dealSlots(plan, order) {
  const byId = new Map(plan.entries.map((record) => [record.unitId, record]));
  const slots = order
    .map((unitId) => byId.get(unitId).time)
    .sort((a, b) => a - b);
  return order.map((unitId, index) => ({
    unitId,
    time: slots[index],
    // What the unit's own clock said when the plan was made. If it stops
    // matching, something authoritative moved this unit and the command no
    // longer speaks for it.
    baseline: byId.get(unitId).scheduledTime
  }));
}

export function commitSequence(collection, dealt, meta) {
  collection.entries = dealt.map((entry, index) => ({ ...entry, index }));
  collection.issuedBy = (meta && meta.issuedBy) || null;
  collection.abilityId = (meta && meta.abilityId) || null;
  collection.issuedAt = (meta && meta.issuedAt) || 0;
  return collection.entries.map((entry) => entry.unitId);
}

/* ---------------------------------------------------------------
 * READING AND SPENDING
 * -------------------------------------------------------------*/

export function sequencedEntry(collection, unitId) {
  if (!sequenceIsActive(collection)) return null;
  return collection.entries.find((entry) => entry.unitId === unitId) || null;
}

/** A unit has taken its commanded slot; the command is done with it. */
export function consumeSequence(collection, unitId) {
  if (!sequenceIsActive(collection)) return false;
  const before = collection.entries.length;
  collection.entries = collection.entries.filter((entry) => entry.unitId !== unitId);
  if (collection.entries.length === before) return false;
  if (!collection.entries.length) clearSequence(collection);
  return true;
}

/**
 * Drops entries the command can no longer honestly claim.
 *
 * Two reasons, and both matter. A unit that died or went dormant obviously has
 * no slot to take. A unit whose own clock has moved since the plan was made
 * has been rescheduled by something authoritative — a haste, a delay, a
 * revive — and holding it in a commanded slot would make the sequencing layer
 * outrank the timeline rather than sit on top of it.
 *
 * @param isValid  `(unitId) => { actionable, time }` or null when the unit is gone
 * @returns the dropped unit ids
 */
export function pruneSequence(collection, isValid) {
  if (!sequenceIsActive(collection)) return [];
  const dropped = [];
  collection.entries = collection.entries.filter((entry) => {
    const live = isValid(entry.unitId);
    if (!live || !live.actionable) {
      dropped.push({ unitId: entry.unitId, reason: "gone" });
      return false;
    }
    if (live.time !== entry.baseline) {
      dropped.push({ unitId: entry.unitId, reason: "rescheduled" });
      return false;
    }
    return true;
  });
  collection.entries = collection.entries.map((entry, index) => ({ ...entry, index }));
  if (!collection.entries.length) clearSequence(collection);
  return dropped;
}

export function clearSequence(collection) {
  collection.entries = [];
  collection.issuedBy = null;
  collection.abilityId = null;
  collection.issuedAt = 0;
}

/* ---------------------------------------------------------------
 * PRESENTATION
 * -------------------------------------------------------------*/

/** "Reyes then Veteran then Nyx". Used by the log and the confirm step. */
export function describeOrder(unitIds, nameOf) {
  return (unitIds || []).map((id) => (nameOf ? nameOf(id) : id)).join(" then ");
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 *
 * Plain data. A save taken mid-window reloads with the same remaining order,
 * carried rather than re-derived — re-deriving it from timestamps is exactly
 * the thing that cannot represent a permutation in the first place.
 * -------------------------------------------------------------*/

export function serializeSequencing(collection) {
  if (!collection) return null;
  return {
    entries: (collection.entries || []).map((entry) => ({ ...entry })),
    issuedBy: collection.issuedBy || null,
    abilityId: collection.abilityId || null,
    issuedAt: collection.issuedAt || 0
  };
}

export function deserializeSequencing(raw) {
  const fresh = createSequencingState();
  if (!raw || !Array.isArray(raw.entries)) return fresh;
  fresh.entries = raw.entries.map((entry, index) => ({ ...entry, index }));
  fresh.issuedBy = raw.issuedBy || null;
  fresh.abilityId = raw.abilityId || null;
  fresh.issuedAt = raw.issuedAt || 0;
  return fresh;
}
