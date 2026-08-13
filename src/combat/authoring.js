/* =========================================================================
 * AUTHORED VOCABULARY
 *
 * The words content is allowed to use, in the one place both halves of the
 * project can see them.
 *
 * The engine owns what these words *do* — a scaling source needs battle state
 * to read, a trigger event needs a handler to fire it — and none of that can
 * live here, because the content validator, the Studio schema and the export
 * pipeline are all pure and must not import the simulation. What they need is
 * not the behaviour but the list: which sources exist, which modes are legal,
 * which moments a status may name.
 *
 * Splitting the list from the behaviour is how a typo in authored data becomes
 * a refused export instead of a silent zero at runtime. The engine asserts
 * that its registries cover exactly these ids, so the two cannot drift.
 *
 * Pure data. No logic, no state, no content ids.
 * =======================================================================*/

/**
 * Where an effect may earn extra value from.
 *
 * Route sources measure something the action did on its way in; the status
 * source measures something already true about the target. Both are counts,
 * multiplied by an authored `perUnit`, which is why "further is stronger" and
 * "marked is stronger" are the same mechanism.
 */
export const EFFECT_SCALING_SOURCE_IDS = [
  "approachDistance",
  "segmentDistance",
  "redirectCount",
  "hopIndex",
  "hopDistance",
  "propagationKills",
  "targetStatus"
];

/** Sources that read a status rather than a route, and so name one. */
export const STATUS_SCALING_SOURCES = ["targetStatus"];

/**
 * How earned value lands.
 *
 * `power` adds to the formula's input before it runs — a charge that becomes a
 * heavier hit. `multiplier` scales the result afterwards — a vulnerability that
 * becomes a percentage. They are different numbers on purpose: adding power to
 * a percent-of-max-HP formula and multiplying its result are not the same
 * mechanic, and an author needs to be able to say which one they meant.
 */
export const EFFECT_SCALING_MODES = ["power", "multiplier"];

/** Who an effect-level resource question is asked about. */
export const EFFECT_RESOURCE_OWNERS = ["source", "target"];

/**
 * Conditions an effect or an ability may be gated on.
 *
 * The engine owns the predicates; this is the list of names that exist. It is
 * here so authored data can be *refused* for naming one that does not — before
 * this list, an unknown condition type evaluated to false at runtime and the
 * ability simply never worked, with nothing anywhere saying why.
 */
export const EFFECT_CONDITION_IDS = [
  "targetHpBelowPercent",
  "targetHpAbovePercent",
  "sourceHpBelowPercent",
  "sourceHpAbovePercent",
  "sourceHasStatus",
  "targetHasStatus",
  "sourceMissingStatus",
  "targetMissingStatus",
  "targetIsDefeated",
  "targetIsAlive",
  "targetIsAlly",
  "targetIsEnemy",
  "tileIsEmpty",
  "tileHasTerrainTag",
  "distanceAtMost",
  "distanceAtLeast",
  "resourceBalance",
  "chance"
];

/**
 * Moments a status may act on.
 *
 * Deliberately few. Each one has to answer *who the effect lands on*
 * unambiguously; a moment that cannot is worse missing than guessed at. Two
 * candidates were considered and left out for exactly that reason:
 *
 *   holder destroyed   the holder is dead and its statuses are already gone,
 *                      so a death rattle would have to resurrect a list the
 *                      defeat handler clears. That is a different feature.
 *
 *   status removed     "removed" covers expiry, cleanse and defeat, which are
 *                      three different fictions with three different actors.
 *
 * `counterpart` names the other party, where the moment has one. A trigger may
 * land its effects on the holder (the default) or on that counterpart, which
 * is the whole difference between poison and retaliation.
 */
export const STATUS_TRIGGER_EVENTS = {
  activationStart: {
    label: "Activation start",
    summary: "The holder is about to act. Burning, poison, upkeep.",
    counterpart: null
  },
  activationEnd: {
    label: "Activation end",
    summary: "The holder has finished acting. Cooling cycles, decay, end-of-turn payoffs.",
    counterpart: null
  },
  unitDamaged: {
    label: "Holder damaged",
    summary: "The holder took damage and survived it. Retaliation, reactive plating.",
    counterpart: "whoever dealt the damage"
  },
  unitMoved: {
    label: "Holder moved",
    summary: "The holder finished a move. Trails, leaks, anything left behind.",
    counterpart: null
  },
  killedUnit: {
    label: "Holder destroyed something",
    summary: "The holder landed a killing blow. Momentum, trophies, escalation.",
    counterpart: "the unit that was destroyed"
  },
  statusApplied: {
    label: "Holder gained a status",
    summary: "Any status landed on the holder, including this one. Adaptation, resonance.",
    counterpart: "whoever applied it"
  }
};

export const STATUS_TRIGGER_EVENT_IDS = Object.keys(STATUS_TRIGGER_EVENTS);

/** Where a trigger's effects land. */
export const STATUS_TRIGGER_TARGETS = ["holder", "counterpart"];

/** True when this moment has a second party for `target: "counterpart"`. */
export function statusTriggerHasCounterpart(eventName) {
  const entry = STATUS_TRIGGER_EVENTS[eventName];
  return !!(entry && entry.counterpart);
}
