/* =========================================================================
 * REACTION CONDITIONS
 *
 * A small declarative vocabulary, not a scripting language. Every condition is
 * a pure function of (data, context) so the same check runs identically during
 * discovery, during the pre-execution re-check, and in a headless replay.
 *
 * The re-check matters: a reaction that was legal when the window opened can
 * be illegal by the time it executes, because an earlier reaction in the same
 * chain killed the actor, moved the target or flipped a faction. Everything
 * here is therefore cheap and side-effect free.
 * =======================================================================*/

import { KNOWLEDGE_STATES as KNOWLEDGE_ORDER } from "../perception/channels.js";

export const REACTION_CONDITION_REGISTRY = {
  all: {
    fields: ["all"],
    summary: "Every listed condition holds.",
    evaluate: (condition, ctx) =>
      (condition.all || []).every((entry) => evaluateReactionCondition(entry, ctx))
  },

  any: {
    fields: ["any"],
    summary: "At least one listed condition holds.",
    evaluate: (condition, ctx) =>
      (condition.any || []).some((entry) => evaluateReactionCondition(entry, ctx))
  },

  not: {
    fields: ["not"],
    summary: "The listed condition does not hold.",
    evaluate: (condition, ctx) => !evaluateReactionCondition(condition.not, ctx)
  },

  /** The unit that caused the triggering event. */
  sourceUnit: {
    fields: ["sourceUnit"],
    summary: "The event was caused by this unit (by authored ref).",
    evaluate: (condition, ctx) => {
      const wanted = condition.sourceUnit;
      const actual = ctx.event.sourceRef || ctx.event.unitRef;
      return Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted;
    }
  },

  /** The unit the event happened *to*. */
  subjectUnit: {
    fields: ["subjectUnit"],
    summary: "The event's subject is this unit (by authored ref).",
    evaluate: (condition, ctx) => {
      const wanted = condition.subjectUnit;
      return Array.isArray(wanted) ? wanted.includes(ctx.event.unitRef) : ctx.event.unitRef === wanted;
    }
  },

  /** Relationship between the reacting unit and the event's subject. */
  subjectRelation: {
    fields: ["subjectRelation"],
    summary: "hostile / allied / neutral, from the reactor's point of view.",
    evaluate: (condition, ctx) => {
      const subjectId = ctx.event.unitId;
      if (!subjectId) return false;
      return ctx.relationship(ctx.reactorId, subjectId) === condition.subjectRelation;
    }
  },

  sourceRelation: {
    fields: ["sourceRelation"],
    summary: "hostile / allied / neutral between the reactor and the event's source.",
    evaluate: (condition, ctx) => {
      const sourceId = ctx.event.sourceUnitId;
      if (!sourceId) return false;
      return ctx.relationship(ctx.reactorId, sourceId) === condition.sourceRelation;
    }
  },

  /** Guards the whole Section Seven family without the engine knowing it. */
  linkActive: {
    fields: ["linkActive"],
    summary: "A named combat link is currently active.",
    evaluate: (condition, ctx) => ctx.linkActive(condition.linkActive)
  },

  reactorAlive: {
    fields: [],
    summary: "The reacting unit is still alive and not dormant. Always checked.",
    evaluate: (condition, ctx) => ctx.reactorIsActionable()
  },

  reactorHpBelow: {
    fields: ["reactorHpBelow"],
    summary: "The reacting unit is at or below a percentage of max HP.",
    evaluate: (condition, ctx) => ctx.reactorHpPercent() <= condition.reactorHpBelow
  },

  subjectAlive: {
    fields: ["subjectAlive"],
    summary: "The event's subject is (or is not) still alive.",
    evaluate: (condition, ctx) => {
      const alive = ctx.unitIsAlive(ctx.event.unitId);
      return condition.subjectAlive === false ? !alive : alive;
    }
  },

  withinRange: {
    fields: ["withinRange", "of"],
    summary:
      "The reactor is within N tiles of the event's subject or source. Distance is " +
      "the engine's grid distance, which counts a diagonal as two steps — the same " +
      "measure ability ranges use.",
    evaluate: (condition, ctx) => {
      const targetId = condition.of === "source" ? ctx.event.sourceUnitId : ctx.event.unitId;
      const distance = ctx.distanceTo(targetId);
      return distance != null && distance <= condition.withinRange;
    }
  },

  /**
   * The reactor's faction knows the event's subject (or source) well enough.
   *
   * Without this, a reaction is a detection oracle: an overwatch shot that
   * fires at a unit nobody can see tells the player exactly where it is. Any
   * reaction that responds to a hostile should carry one of these.
   */
  knowsSubject: {
    fields: ["knowsSubject", "of"],
    summary:
      "The reactor's faction holds at least this knowledge state on the event's subject " +
      "(or its source, with `of: \"source\"`). Defaults to `acquired`.",
    evaluate: (condition, ctx) => {
      const targetId = condition.of === "source" ? ctx.event.sourceUnitId : ctx.event.unitId;
      if (!targetId) return false;
      const wanted = condition.knowsSubject === true ? "acquired" : condition.knowsSubject || "acquired";
      const actual = ctx.knowledgeState(targetId);
      return KNOWLEDGE_ORDER.indexOf(actual) >= KNOWLEDGE_ORDER.indexOf(wanted);
    }
  },

  abilityId: {
    fields: ["abilityId"],
    summary: "The triggering ability is one of these.",
    evaluate: (condition, ctx) => {
      const wanted = condition.abilityId;
      return Array.isArray(wanted) ? wanted.includes(ctx.event.abilityId) : ctx.event.abilityId === wanted;
    }
  },

  statusId: {
    fields: ["statusId"],
    summary: "The triggering status is one of these.",
    evaluate: (condition, ctx) => {
      const wanted = condition.statusId;
      return Array.isArray(wanted) ? wanted.includes(ctx.event.statusId) : ctx.event.statusId === wanted;
    }
  },

  reactorHasStatus: {
    fields: ["reactorHasStatus"],
    summary: "The reacting unit currently has this status.",
    evaluate: (condition, ctx) => ctx.reactorHasStatus(condition.reactorHasStatus)
  },

  missionFact: {
    fields: ["missionFact", "equals"],
    summary: "A mission-local fact set by the scripting layer.",
    evaluate: (condition, ctx) => {
      const value = ctx.missionFact(condition.missionFact);
      if (condition.equals !== undefined) return value === condition.equals;
      return value !== undefined && value !== null && value !== false;
    }
  },

  /** The reactor is itself the unit that caused the event. */
  sourceIsReactor: {
    fields: ["sourceIsReactor"],
    summary: "The reactor caused the event (its own kill, its own attack).",
    evaluate: (condition, ctx) => {
      const matches = ctx.event.sourceUnitId === ctx.reactorId;
      return condition.sourceIsReactor === false ? !matches : matches;
    }
  },

  /** The reactor is the unit the event happened to. */
  subjectIsReactor: {
    fields: ["subjectIsReactor"],
    summary: "The event happened to the reactor (it was hit, missed, moved).",
    evaluate: (condition, ctx) => {
      const matches = ctx.event.unitId === ctx.reactorId;
      return condition.subjectIsReactor === false ? !matches : matches;
    }
  },

  /** Was the movement voluntary, or did something put the unit there? */
  eventForced: {
    fields: ["eventForced"],
    summary: "The event was a forced displacement rather than a voluntary act.",
    evaluate: (condition, ctx) =>
      condition.eventForced === false ? !ctx.event.forced : !!ctx.event.forced
  },

  /**
   * The reactor can see the event's subject where it is now.
   *
   * Exposure is a relation, not a property: there is no global "in cover"
   * flag, because a unit behind a wall from the north is standing in the open
   * from the east. Asking the question from the reactor's own tile is both
   * cheaper and more honest than inventing a cover state to cache.
   */
  subjectInLineOfSight: {
    fields: ["subjectInLineOfSight"],
    summary: "The reactor has line of sight to where the event's subject is now.",
    evaluate: (condition, ctx) => {
      const visible = ctx.canSeeTile(ctx.eventTile("to"));
      return condition.subjectInLineOfSight === false ? !visible : visible;
    }
  },

  /**
   * The subject just moved from somewhere the reactor could not see into
   * somewhere it can.
   *
   * This is the displacement synergy in one condition. It does not care
   * whether the unit walked out of cover or was shoved out of it, which is
   * exactly the point — a prepared shooter reacts to the lane being crossed.
   */
  subjectBecameExposed: {
    fields: ["subjectBecameExposed"],
    summary: "The event moved its subject out of the reactor's blind side into its sight.",
    evaluate: (condition, ctx) => {
      const from = ctx.eventTile("from");
      const to = ctx.eventTile("to");
      if (!from || !to) return false;
      const became = !ctx.canSeeTile(from) && ctx.canSeeTile(to);
      return condition.subjectBecameExposed === false ? !became : became;
    }
  },

  /** Amount carried by the event — damage dealt, HP repaired. */
  amountAtLeast: {
    fields: ["amountAtLeast"],
    summary: "The event's amount is at least this large.",
    evaluate: (condition, ctx) => (ctx.event.amount || 0) >= condition.amountAtLeast
  }
};

export const REACTION_CONDITION_IDS = Object.keys(REACTION_CONDITION_REGISTRY);

export function reactionConditionKind(condition) {
  if (!condition || typeof condition !== "object") return null;
  for (const key of Object.keys(condition)) {
    if (REACTION_CONDITION_REGISTRY[key]) return key;
  }
  return null;
}

export function evaluateReactionCondition(condition, ctx) {
  if (condition == null) return true;
  if (Array.isArray(condition)) {
    return condition.every((entry) => evaluateReactionCondition(entry, ctx));
  }
  const kind = reactionConditionKind(condition);
  if (!kind) return false;
  return REACTION_CONDITION_REGISTRY[kind].evaluate(condition, ctx);
}

/** Static validation, shared by the content check and the editor. */
export function validateReactionCondition(condition, path) {
  const where = path || "condition";
  const problems = [];
  if (condition == null) return problems;
  if (Array.isArray(condition)) {
    condition.forEach((entry, index) => {
      problems.push(...validateReactionCondition(entry, where + "[" + index + "]"));
    });
    return problems;
  }
  if (typeof condition !== "object") return [where + " must be an object."];

  const kind = reactionConditionKind(condition);
  if (!kind) {
    return [
      where + " is not a known reaction condition (keys: " + Object.keys(condition).join(", ") + ")."
    ];
  }
  if (kind === "all" || kind === "any") {
    const list = condition[kind];
    if (!Array.isArray(list) || !list.length) return [where + "." + kind + " needs a non-empty list."];
    list.forEach((entry, index) => {
      problems.push(...validateReactionCondition(entry, where + "." + kind + "[" + index + "]"));
    });
    return problems;
  }
  if (kind === "not") return validateReactionCondition(condition.not, where + ".not");
  return problems;
}
