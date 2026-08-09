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
    summary: "The reactor is within N tiles of the event's subject or source.",
    evaluate: (condition, ctx) => {
      const targetId = condition.of === "source" ? ctx.event.sourceUnitId : ctx.event.unitId;
      const distance = ctx.distanceTo(targetId);
      return distance != null && distance <= condition.withinRange;
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
