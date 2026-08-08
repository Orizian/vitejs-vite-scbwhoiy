/* =========================================================================
 * TRIGGERS AND CONDITIONS
 *
 * Deliberately not a scripting language. Two small vocabularies:
 *
 *   TRIGGERS    match against a single mission event as it arrives.
 *               { "trigger": "unitEnteredRegion", "unitRef": "vale",
 *                 "regionRef": "westernKillZone" }
 *
 *   CONDITIONS  are asked about the *current* state, and compose.
 *               { "all": [ { "phase": "engagement" },
 *                          { "missionFact": "sawTheTrap" } ] }
 *
 * A beat may have a trigger, conditions, or both. With no trigger it is
 * evaluated on every event as a pure state check, which is how "HP below X"
 * style beats work without a dedicated event.
 *
 * Both registries are pure functions of (data, context). No engine imports,
 * so the editor validates against exactly what the runtime will execute.
 * =======================================================================*/

import { MISSION_EVENT_TYPES, missionEventTypeById } from "./events.js";
import { relationshipBetween } from "./factions.js";

/* ---------------------------------------------------------------
 * TRIGGERS
 *
 * Every mission event type is automatically a trigger that matches on field
 * equality. That is the whole point: adding an event type adds a trigger with
 * no extra code, which is what "data-driven" has to mean here.
 * -------------------------------------------------------------*/

/** Fields that never participate in equality matching. */
const NON_MATCH_KEYS = new Set(["trigger", "type", "conditions", "when", "once", "count"]);

export function triggerFieldsFor(triggerId) {
  const type = missionEventTypeById(triggerId);
  return type ? type.fields : [];
}

export const TRIGGER_IDS = MISSION_EVENT_TYPES.map((entry) => entry.id);

/**
 * Matches a trigger spec against one mission event.
 *
 * Equality is generic: every key on the spec that is not structural must equal
 * the same key on the event. Arrays on the spec mean "any of".
 *
 * The one special case is numeric thresholds — `percent` on a trigger means
 * "at or below", because that is what every author means by it and the
 * alternative is making them enumerate thresholds.
 */
export function matchTrigger(trigger, event) {
  if (!trigger) return false;
  const wanted = typeof trigger === "string" ? { trigger } : trigger;
  const type = wanted.trigger || wanted.type;
  if (!type || type !== event.type) return false;

  for (const key of Object.keys(wanted)) {
    if (NON_MATCH_KEYS.has(key)) continue;
    const expected = wanted[key];
    if (expected == null) continue;
    const actual = event[key];

    if (key === "percent") {
      if (typeof actual !== "number" || actual > expected) return false;
      continue;
    }
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    // `targetRefs` style array fields on the event: the spec names one member.
    if (Array.isArray(actual)) {
      if (!actual.includes(expected)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

/* ---------------------------------------------------------------
 * CONDITIONS
 *
 * ctx = {
 *   phaseId, facts, flags, counters,
 *   unit(ref)            -> { alive, hpPercent, teamId, x, y } | null
 *   objective(ref)       -> { status } | null
 *   group(ref)           -> { active, spawned } | null
 *   region(ref)          -> { contains(x, y) } | null
 *   factionState, teamIds,
 *   firedCount(id)       -> number
 * }
 * -------------------------------------------------------------*/

export const CONDITION_REGISTRY = {
  all: {
    fields: ["all"],
    summary: "Every listed condition is true.",
    evaluate(condition, ctx) {
      return (condition.all || []).every((entry) => evaluateCondition(entry, ctx));
    }
  },

  any: {
    fields: ["any"],
    summary: "At least one listed condition is true.",
    evaluate(condition, ctx) {
      return (condition.any || []).some((entry) => evaluateCondition(entry, ctx));
    }
  },

  not: {
    fields: ["not"],
    summary: "The listed condition is false.",
    evaluate(condition, ctx) {
      return !evaluateCondition(condition.not, ctx);
    }
  },

  phase: {
    fields: ["phase"],
    summary: "The mission is currently in this phase.",
    evaluate(condition, ctx) {
      const wanted = condition.phase;
      return Array.isArray(wanted) ? wanted.includes(ctx.phaseId) : ctx.phaseId === wanted;
    }
  },

  missionFact: {
    fields: ["missionFact", "equals"],
    summary: "A mission-local fact is set (or equals a value).",
    evaluate(condition, ctx) {
      const value = ctx.facts[condition.missionFact];
      if (condition.equals !== undefined) return value === condition.equals;
      return value !== undefined && value !== false && value !== null;
    }
  },

  campaignFlag: {
    fields: ["campaignFlag", "equals"],
    summary: "A campaign flag is set.",
    evaluate(condition, ctx) {
      const value = ctx.flags[condition.campaignFlag];
      if (condition.equals !== undefined) return value === condition.equals;
      return !!value;
    }
  },

  unitAlive: {
    fields: ["unitAlive"],
    summary: "A unit is still alive.",
    evaluate(condition, ctx) {
      const unit = ctx.unit(condition.unitAlive);
      return !!unit && unit.alive;
    }
  },

  unitHpBelow: {
    fields: ["unitHpBelow", "percent"],
    summary: "A living unit's HP is at or below a percentage.",
    evaluate(condition, ctx) {
      const unit = ctx.unit(condition.unitHpBelow);
      if (!unit || !unit.alive) return false;
      return unit.hpPercent <= (condition.percent == null ? 50 : condition.percent);
    }
  },

  unitInRegion: {
    fields: ["unitInRegion", "regionRef"],
    summary: "A living unit is standing inside a region.",
    evaluate(condition, ctx) {
      const unit = ctx.unit(condition.unitInRegion);
      const region = ctx.region(condition.regionRef);
      if (!unit || !unit.alive || !region) return false;
      return region.contains(unit.x, unit.y);
    }
  },

  teamUnitsAlive: {
    fields: ["teamUnitsAlive", "atMost", "atLeast"],
    summary: "How many units a team still has on the field.",
    evaluate(condition, ctx) {
      const count = ctx.teamAliveCount(condition.teamUnitsAlive);
      if (condition.atMost != null && count > condition.atMost) return false;
      if (condition.atLeast != null && count < condition.atLeast) return false;
      return true;
    }
  },

  objectiveStatus: {
    fields: ["objectiveStatus", "status"],
    summary: "An objective is active, complete or failed.",
    evaluate(condition, ctx) {
      const objective = ctx.objective(condition.objectiveStatus);
      if (!objective) return false;
      return objective.status === (condition.status || "complete");
    }
  },

  groupActive: {
    fields: ["groupActive"],
    summary: "A spawn/activation group is awake.",
    evaluate(condition, ctx) {
      const group = ctx.group(condition.groupActive);
      return !!group && group.active;
    }
  },

  factionRelationship: {
    fields: ["factionRelationship", "otherTeamId", "is"],
    summary: "Two factions currently stand in a given relationship.",
    evaluate(condition, ctx) {
      const relationship = relationshipBetween(
        ctx.factionState,
        condition.factionRelationship,
        condition.otherTeamId
      );
      return relationship === (condition.is || "hostile");
    }
  },

  activationCount: {
    fields: ["activationCount", "atLeast", "atMost"],
    summary: "Total activations elapsed in this battle.",
    evaluate(condition, ctx) {
      const count = ctx.activationCount;
      const spec = condition.activationCount;
      if (typeof spec === "number") return count >= spec;
      if (condition.atLeast != null && count < condition.atLeast) return false;
      if (condition.atMost != null && count > condition.atMost) return false;
      return true;
    }
  },

  once: {
    fields: ["once"],
    summary: "This beat has never fired before. Usually set via the beat's own `once` field.",
    evaluate(condition, ctx) {
      return ctx.firedCount(condition.once) === 0;
    }
  }
};

export const CONDITION_IDS = Object.keys(CONDITION_REGISTRY);

/** The key that identifies which handler a condition object wants. */
export function conditionKind(condition) {
  if (!condition || typeof condition !== "object") return null;
  for (const key of Object.keys(condition)) {
    if (CONDITION_REGISTRY[key]) return key;
  }
  return null;
}

export function evaluateCondition(condition, ctx) {
  if (condition == null) return true;
  if (Array.isArray(condition)) return condition.every((entry) => evaluateCondition(entry, ctx));
  const kind = conditionKind(condition);
  if (!kind) return false;
  return CONDITION_REGISTRY[kind].evaluate(condition, ctx);
}

/** Static validation used by both the editor and the mission compiler.
 *  Returns human-readable problems, not booleans. */
export function validateCondition(condition, refs, path) {
  const where = path || "condition";
  const problems = [];
  if (condition == null) return problems;
  if (Array.isArray(condition)) {
    condition.forEach((entry, index) => {
      problems.push(...validateCondition(entry, refs, where + "[" + index + "]"));
    });
    return problems;
  }
  if (typeof condition !== "object") {
    problems.push(where + " must be an object.");
    return problems;
  }

  const kind = conditionKind(condition);
  if (!kind) {
    problems.push(where + ' is not a known condition (got keys: ' + Object.keys(condition).join(", ") + ").");
    return problems;
  }

  if (kind === "all" || kind === "any") {
    const list = condition[kind];
    if (!Array.isArray(list) || !list.length) {
      problems.push(where + "." + kind + " needs a non-empty list.");
    } else {
      list.forEach((entry, index) => {
        problems.push(...validateCondition(entry, refs, where + "." + kind + "[" + index + "]"));
      });
    }
    return problems;
  }
  if (kind === "not") {
    return validateCondition(condition.not, refs, where + ".not");
  }

  const check = (value, pool, label) => {
    if (value == null) return;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!pool.has(entry)) problems.push(where + ' references unknown ' + label + ' "' + entry + '".');
    }
  };

  if (kind === "phase") check(condition.phase, refs.phases, "phase");
  if (kind === "unitAlive") check(condition.unitAlive, refs.units, "unit");
  if (kind === "unitHpBelow") check(condition.unitHpBelow, refs.units, "unit");
  if (kind === "unitInRegion") {
    check(condition.unitInRegion, refs.units, "unit");
    check(condition.regionRef, refs.regions, "region");
  }
  if (kind === "objectiveStatus") check(condition.objectiveStatus, refs.objectives, "objective");
  if (kind === "groupActive") check(condition.groupActive, refs.groups, "group");
  if (kind === "teamUnitsAlive") check(condition.teamUnitsAlive, refs.teams, "team");
  if (kind === "factionRelationship") {
    check(condition.factionRelationship, refs.teams, "team");
    check(condition.otherTeamId, refs.teams, "team");
  }

  return problems;
}

/** Static validation for a trigger spec. */
export function validateTrigger(trigger, refs, path) {
  const where = path || "trigger";
  const problems = [];
  if (trigger == null) return problems;
  const spec = typeof trigger === "string" ? { trigger } : trigger;
  const type = spec.trigger || spec.type;
  if (!type) {
    problems.push(where + " has no trigger type.");
    return problems;
  }
  const definition = missionEventTypeById(type);
  if (!definition) {
    problems.push(where + ' uses unknown trigger "' + type + '".');
    return problems;
  }

  const allowed = new Set(definition.fields.concat(["trigger", "type"]));
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) {
      problems.push(
        where + ' sets "' + key + '", which the ' + type + " event does not carry. Available: " +
          (definition.fields.join(", ") || "none")
      );
    }
  }

  const check = (value, pool, label) => {
    if (value == null) return;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!pool.has(entry)) problems.push(where + ' references unknown ' + label + ' "' + entry + '".');
    }
  };
  check(spec.unitRef, refs.units, "unit");
  check(spec.sourceRef, refs.units, "unit");
  check(spec.regionRef, refs.regions, "region");
  check(spec.objectiveRef, refs.objectives, "objective");
  check(spec.groupRef, refs.groups, "group");
  check(spec.phaseRef, refs.phases, "phase");
  check(spec.sceneRef, refs.scenes, "scene");
  check(spec.teamId, refs.teams, "team");
  check(spec.otherTeamId, refs.teams, "team");

  return problems;
}
