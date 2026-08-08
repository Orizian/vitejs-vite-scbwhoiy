/* =========================================================================
 * MISSION ACTION REGISTRY
 *
 * What a mission script is allowed to *do*. Every action is one entry here,
 * and adding a capability means adding an entry — never a branch inside the
 * simulation or the renderer.
 *
 * Each action declares its `authority`:
 *
 *   "simulation"    changes authoritative battle state. Goes through the
 *                   engine adapter, which routes to the same effect/command
 *                   machinery ordinary gameplay uses. Produces real events,
 *                   real log lines, and shows up in a save.
 *
 *   "presentation"  camera, music, scenes. Queued for the renderer to drain.
 *                   Never touches battle state. In a headless run these
 *                   resolve instantly, and the authoritative outcome is
 *                   identical — that property is what makes a scripted battle
 *                   deterministically replayable.
 *
 * `blocking: true` means the runtime suspends after queuing it and waits for
 * the renderer to acknowledge. That is how a cinematic pauses the battle
 * without the simulation running ahead of the dialogue.
 *
 * The engine adapter (`ctx.engine`) is injected by App.jsx. This module has no
 * engine imports, so the editor can load the registry to build its forms and
 * validate a mission without pulling in the game.
 * =======================================================================*/

import { RELATIONSHIPS } from "./factions.js";

/**
 * ctx = {
 *   state,                       authoritative battle state
 *   engine,                      adapter, see ENGINE_ADAPTER_CONTRACT below
 *   runtime,                     mission runtime state (facts, phases, groups)
 *   emit(missionEvent),          push a mission event back into the stream
 *   resolveUnit(ref) -> unitId,
 *   resolveRegionTiles(ref) -> [{x,y}],
 *   log(message, data)
 * }
 *
 * A handler returns nothing on success, or { error } to record a problem.
 * Handlers must be idempotent-safe: the runtime guarantees once-only beats,
 * but an author can legitimately fire the same action twice and it must not
 * corrupt state.
 */

export const ENGINE_ADAPTER_CONTRACT = [
  "resolveEffects",     // (state, { sourceUnitId, targetUnitIds, effects, abilityId }) -> void
  "processEvents",      // (state) -> void   drains the resolution queue
  "findPath",           // (state, unitId, {x,y}) -> path | null
  "teleportUnit",       // (state, unitId, {x,y}) -> bool
  "moveUnitAlongPath",  // (state, unitId, path) -> bool
  "spawnUnit",          // (state, spec) -> unitId | null
  "setTerrain",         // (state, x, y, terrainId) -> bool
  "unitStats",          // (state, unitId) -> stats
  "setUnitTeam",        // (state, unitId, teamId) -> void
  "queueEvent",         // (state, event) -> void
  "logLine"             // (state, type, text, data) -> void
];

/* ---------------------------------------------------------------
 * SIMULATION ACTIONS
 * -------------------------------------------------------------*/

const simulationActions = {
  setMissionFact: {
    authority: "simulation",
    name: "Set mission fact",
    fields: ["fact", "value"],
    summary: "Records a mission-local fact that later conditions can read.",
    validate(action) {
      return action.fact ? [] : ["setMissionFact needs a `fact` name."];
    },
    run(action, ctx) {
      const value = action.value === undefined ? true : action.value;
      if (ctx.runtime.facts[action.fact] === value) return;
      ctx.runtime.facts[action.fact] = value;
      ctx.log("Mission fact set: " + action.fact + " = " + JSON.stringify(value), { fact: action.fact, value });
      ctx.emit({ type: "missionFactSet", fact: action.fact, value });
    }
  },

  setCampaignFlag: {
    authority: "simulation",
    name: "Set campaign flag",
    fields: ["flag", "value"],
    summary:
      "Queues a campaign flag. The campaign layer lives outside the battle, so this is recorded on the battle result and applied when the mission resolves — which keeps it correct across save/reload.",
    validate(action) {
      return action.flag ? [] : ["setCampaignFlag needs a `flag` name."];
    },
    run(action, ctx) {
      const value = action.value === undefined ? true : action.value;
      // Deduplicated so a re-entered phase cannot grant a reward twice.
      const existing = ctx.runtime.campaignFlagRequests.find((entry) => entry.flag === action.flag);
      if (existing) {
        existing.value = value;
        return;
      }
      ctx.runtime.campaignFlagRequests.push({ flag: action.flag, value });
      ctx.log("Campaign flag queued: " + action.flag, { flag: action.flag, value });
    }
  },

  startPhase: {
    authority: "simulation",
    name: "Start phase",
    fields: ["phaseRef"],
    summary: "Moves the mission into a named phase.",
    validate(action, refs) {
      if (!action.phaseRef) return ["startPhase needs a `phaseRef`."];
      return refs.phases.has(action.phaseRef) ? [] : ['startPhase references unknown phase "' + action.phaseRef + '".'];
    },
    run(action, ctx) {
      ctx.startPhase(action.phaseRef);
    }
  },

  completePhase: {
    authority: "simulation",
    name: "Complete phase",
    fields: ["phaseRef"],
    summary: "Marks the current (or named) phase complete and advances to its `next` phase if it has one.",
    run(action, ctx) {
      ctx.completePhase(action.phaseRef || ctx.runtime.phaseId);
    }
  },

  addObjective: {
    authority: "simulation",
    name: "Add objective",
    fields: ["objectiveRef"],
    summary: "Activates an objective defined in the mission's objective list.",
    validate(action, refs) {
      if (!action.objectiveRef) return ["addObjective needs an `objectiveRef`."];
      return refs.objectives.has(action.objectiveRef)
        ? []
        : ['addObjective references unknown objective "' + action.objectiveRef + '".'];
    },
    run(action, ctx) {
      ctx.objectives.add(action.objectiveRef);
    }
  },

  removeObjective: {
    authority: "simulation",
    name: "Remove objective",
    fields: ["objectiveRef"],
    summary: "Drops an objective without completing or failing it.",
    run(action, ctx) {
      ctx.objectives.remove(action.objectiveRef);
    }
  },

  replaceObjectives: {
    authority: "simulation",
    name: "Replace objectives",
    fields: ["objectiveRefs"],
    summary: "Clears every active objective and activates the listed ones. The Grayfield turn.",
    validate(action, refs) {
      const list = action.objectiveRefs || [];
      if (!list.length) return ["replaceObjectives needs at least one objective."];
      return list
        .filter((ref) => !refs.objectives.has(ref))
        .map((ref) => 'replaceObjectives references unknown objective "' + ref + '".');
    },
    run(action, ctx) {
      ctx.objectives.replace(action.objectiveRefs || []);
    }
  },

  completeObjective: {
    authority: "simulation",
    name: "Complete objective",
    fields: ["objectiveRef"],
    summary: "Forces an objective to succeed.",
    run(action, ctx) {
      ctx.objectives.setStatus(action.objectiveRef, "complete");
    }
  },

  failObjective: {
    authority: "simulation",
    name: "Fail objective",
    fields: ["objectiveRef"],
    summary: "Forces an objective to fail. A required failed objective loses the mission.",
    run(action, ctx) {
      ctx.objectives.setStatus(action.objectiveRef, "failed");
    }
  },

  activateGroup: {
    authority: "simulation",
    name: "Activate group",
    fields: ["groupRef"],
    summary: "Wakes a dormant group so its units join the timeline.",
    validate(action, refs) {
      if (!action.groupRef) return ["activateGroup needs a `groupRef`."];
      return refs.groups.has(action.groupRef) ? [] : ['activateGroup references unknown group "' + action.groupRef + '".'];
    },
    run(action, ctx) {
      ctx.groups.setActive(action.groupRef, true);
    }
  },

  deactivateGroup: {
    authority: "simulation",
    name: "Deactivate group",
    fields: ["groupRef"],
    summary: "Puts a group to sleep. Its units stay on the map but stop taking turns.",
    run(action, ctx) {
      ctx.groups.setActive(action.groupRef, false);
    }
  },

  spawnGroup: {
    authority: "simulation",
    name: "Spawn group",
    fields: ["groupRef", "regionRef"],
    summary: "Places a reserve group on the map, optionally inside a region.",
    validate(action, refs) {
      if (!action.groupRef) return ["spawnGroup needs a `groupRef`."];
      const problems = [];
      if (!refs.groups.has(action.groupRef)) {
        problems.push('spawnGroup references unknown group "' + action.groupRef + '".');
      }
      if (action.regionRef && !refs.regions.has(action.regionRef)) {
        problems.push('spawnGroup references unknown region "' + action.regionRef + '".');
      }
      return problems;
    },
    run(action, ctx) {
      ctx.groups.spawn(action.groupRef, action.regionRef || null);
    }
  },

  changeFaction: {
    authority: "simulation",
    name: "Change faction relationship",
    fields: ["teamId", "otherTeamId", "relationship", "symmetric"],
    summary: "Rewrites how two factions regard each other. Units are never recreated.",
    validate(action, refs) {
      const problems = [];
      if (!action.teamId || !action.otherTeamId) {
        problems.push("changeFaction needs `teamId` and `otherTeamId`.");
      }
      if (action.teamId && !refs.teams.has(action.teamId)) {
        problems.push('changeFaction references unknown team "' + action.teamId + '".');
      }
      if (action.otherTeamId && !refs.teams.has(action.otherTeamId)) {
        problems.push('changeFaction references unknown team "' + action.otherTeamId + '".');
      }
      if (!RELATIONSHIPS.includes(action.relationship) && action.relationship !== "protected") {
        problems.push(
          'changeFaction needs a relationship of ' + RELATIONSHIPS.join(" / ") + " (got " + action.relationship + ")."
        );
      }
      return problems;
    },
    run(action, ctx) {
      ctx.factions.set(action.teamId, action.otherTeamId, action.relationship, {
        symmetric: action.symmetric !== false
      });
    }
  },

  changeUnitTeam: {
    authority: "simulation",
    name: "Move unit to another team",
    fields: ["unitRefs", "toTeamId"],
    summary:
      "Reassigns units to a different team in place — no despawn, no replacement. Their HP, statuses, position and timeline slot are preserved.",
    validate(action, refs) {
      const problems = [];
      if (!action.toTeamId) problems.push("changeUnitTeam needs `toTeamId`.");
      else if (!refs.teams.has(action.toTeamId)) {
        problems.push('changeUnitTeam references unknown team "' + action.toTeamId + '".');
      }
      for (const ref of action.unitRefs || []) {
        if (!refs.units.has(ref)) problems.push('changeUnitTeam references unknown unit "' + ref + '".');
      }
      if (!(action.unitRefs || []).length) problems.push("changeUnitTeam needs at least one unit.");
      return problems;
    },
    run(action, ctx) {
      for (const ref of action.unitRefs || []) {
        const unitId = ctx.resolveUnit(ref);
        if (!unitId) continue;
        ctx.engine.setUnitTeam(ctx.state, unitId, action.toTeamId);
      }
    }
  },

  moveUnit: {
    authority: "simulation",
    name: "Move unit",
    fields: ["unitRef", "to", "regionRef", "mode"],
    summary:
      "Walks a unit to a tile through the real pathfinder (mode 'path', the default) or places it directly (mode 'teleport'). Emits a genuine unitMoved event either way.",
    validate(action, refs) {
      const problems = [];
      if (!action.unitRef) problems.push("moveUnit needs a `unitRef`.");
      else if (!refs.units.has(action.unitRef)) {
        problems.push('moveUnit references unknown unit "' + action.unitRef + '".');
      }
      if (!action.to && !action.regionRef) problems.push("moveUnit needs either `to` or `regionRef`.");
      if (action.regionRef && !refs.regions.has(action.regionRef)) {
        problems.push('moveUnit references unknown region "' + action.regionRef + '".');
      }
      return problems;
    },
    run(action, ctx) {
      const unitId = ctx.resolveUnit(action.unitRef);
      if (!unitId) return { error: 'moveUnit: unit "' + action.unitRef + '" is not on the field.' };
      const destination = action.to || ctx.nearestFreeTileInRegion(action.regionRef, unitId);
      if (!destination) return { error: "moveUnit: no reachable destination." };

      if (action.mode === "teleport") {
        ctx.engine.teleportUnit(ctx.state, unitId, destination);
        return;
      }
      const path = ctx.engine.findPath(ctx.state, unitId, destination);
      if (!path || path.length < 2) {
        // Falling back rather than failing: a scripted beat must not stall
        // because a unit drifted somewhere the pathfinder cannot solve.
        ctx.engine.teleportUnit(ctx.state, unitId, destination);
        return;
      }
      ctx.engine.moveUnitAlongPath(ctx.state, unitId, path);
    }
  },

  performAttack: {
    authority: "simulation",
    name: "Scripted attack",
    fields: ["sourceRef", "targetRefs", "abilityId", "power", "formula", "lethal"],
    summary:
      "Resolves a real attack through the combat system. Damage, defeat, wrecks and log lines are authoritative — this is not a visual effect.",
    validate(action, refs) {
      const problems = [];
      if (!action.sourceRef) problems.push("performAttack needs a `sourceRef`.");
      else if (!refs.units.has(action.sourceRef)) {
        problems.push('performAttack references unknown unit "' + action.sourceRef + '".');
      }
      if (!(action.targetRefs || []).length) problems.push("performAttack needs at least one target.");
      for (const ref of action.targetRefs || []) {
        if (!refs.units.has(ref)) problems.push('performAttack references unknown unit "' + ref + '".');
      }
      if (action.abilityId && refs.abilities.size && !refs.abilities.has(action.abilityId)) {
        problems.push('performAttack references unknown ability "' + action.abilityId + '".');
      }
      return problems;
    },
    run(action, ctx) {
      const sourceUnitId = ctx.resolveUnit(action.sourceRef);
      const targetUnitIds = (action.targetRefs || []).map(ctx.resolveUnit).filter(Boolean);
      if (!sourceUnitId || !targetUnitIds.length) {
        return { error: "performAttack: source or targets are not on the field." };
      }
      ctx.engine.scriptedAttack(ctx.state, {
        sourceUnitId,
        targetUnitIds,
        abilityId: action.abilityId || null,
        power: action.power,
        formula: action.formula,
        lethal: action.lethal !== false
      });
    }
  },

  performRepair: {
    authority: "simulation",
    name: "Scripted repair",
    fields: ["sourceRef", "targetRefs", "amount", "abilityId"],
    summary: "Resolves a real repair through the heal path, producing an authoritative repairCompleted event.",
    validate(action, refs) {
      const problems = [];
      if (!action.sourceRef) problems.push("performRepair needs a `sourceRef`.");
      else if (!refs.units.has(action.sourceRef)) {
        problems.push('performRepair references unknown unit "' + action.sourceRef + '".');
      }
      for (const ref of action.targetRefs || []) {
        if (!refs.units.has(ref)) problems.push('performRepair references unknown unit "' + ref + '".');
      }
      if (!(action.targetRefs || []).length) problems.push("performRepair needs at least one target.");
      return problems;
    },
    run(action, ctx) {
      const sourceUnitId = ctx.resolveUnit(action.sourceRef);
      const targetUnitIds = (action.targetRefs || []).map(ctx.resolveUnit).filter(Boolean);
      if (!sourceUnitId || !targetUnitIds.length) {
        return { error: "performRepair: source or targets are not on the field." };
      }
      ctx.engine.scriptedRepair(ctx.state, {
        sourceUnitId,
        targetUnitIds,
        amount: action.amount == null ? 40 : action.amount,
        abilityId: action.abilityId || null
      });
    }
  },

  modifyTerrain: {
    authority: "simulation",
    name: "Modify terrain",
    fields: ["regionRef", "tiles", "terrainId"],
    summary: "Replaces terrain across a region or tile list. Collapses, breaches, opened gates.",
    validate(action, refs) {
      const problems = [];
      if (!action.terrainId) problems.push("modifyTerrain needs a `terrainId`.");
      else if (refs.terrains.size && !refs.terrains.has(action.terrainId)) {
        problems.push('modifyTerrain references unknown terrain "' + action.terrainId + '".');
      }
      if (!action.regionRef && !(action.tiles || []).length) {
        problems.push("modifyTerrain needs a `regionRef` or a `tiles` list.");
      }
      if (action.regionRef && !refs.regions.has(action.regionRef)) {
        problems.push('modifyTerrain references unknown region "' + action.regionRef + '".');
      }
      return problems;
    },
    run(action, ctx) {
      const tiles = action.tiles && action.tiles.length
        ? action.tiles
        : ctx.resolveRegionTiles(action.regionRef);
      for (const tile of tiles) {
        ctx.engine.setTerrain(ctx.state, tile.x, tile.y, action.terrainId);
      }
    }
  },

  applyStatus: {
    authority: "simulation",
    name: "Apply status",
    fields: ["unitRefs", "statusId"],
    summary: "Applies a status through the normal effect pipeline.",
    validate(action, refs) {
      const problems = [];
      if (!action.statusId) problems.push("applyStatus needs a `statusId`.");
      else if (refs.statuses.size && !refs.statuses.has(action.statusId)) {
        problems.push('applyStatus references unknown status "' + action.statusId + '".');
      }
      for (const ref of action.unitRefs || []) {
        if (!refs.units.has(ref)) problems.push('applyStatus references unknown unit "' + ref + '".');
      }
      return problems;
    },
    run(action, ctx) {
      const targetUnitIds = (action.unitRefs || []).map(ctx.resolveUnit).filter(Boolean);
      if (!targetUnitIds.length) return;
      ctx.engine.resolveEffects(ctx.state, {
        sourceUnitId: targetUnitIds[0],
        targetUnitIds,
        effects: [{ type: "applyStatus", statusId: action.statusId, chance: 1 }]
      });
      ctx.engine.processEvents(ctx.state);
    }
  }
};

/* ---------------------------------------------------------------
 * PRESENTATION ACTIONS
 *
 * These never touch battle state. In a headless run they resolve instantly
 * and the authoritative result is unchanged — that is the property that keeps
 * scripted battles deterministically replayable.
 * -------------------------------------------------------------*/

const presentationActions = {
  showScene: {
    authority: "presentation",
    name: "Show scene",
    fields: ["sceneRef"],
    blocking: true,
    summary: "Hard-pauses the battle for a portrait dialogue scene. Choices in the scene set mission facts.",
    validate(action, refs) {
      if (!action.sceneRef) return ["showScene needs a `sceneRef`."];
      return refs.scenes.has(action.sceneRef) ? [] : ['showScene references unknown scene "' + action.sceneRef + '".'];
    },
    run(action, ctx) {
      ctx.present({ type: "showScene", sceneRef: action.sceneRef }, { blocking: true });
    }
  },

  focusCamera: {
    authority: "presentation",
    name: "Focus camera",
    fields: ["unitRef", "regionRef", "tile", "hold"],
    blocking: false,
    summary: "Pans the camera to a unit, region or tile.",
    validate(action, refs) {
      const problems = [];
      if (!action.unitRef && !action.regionRef && !action.tile) {
        problems.push("focusCamera needs a `unitRef`, `regionRef` or `tile`.");
      }
      if (action.unitRef && !refs.units.has(action.unitRef)) {
        problems.push('focusCamera references unknown unit "' + action.unitRef + '".');
      }
      if (action.regionRef && !refs.regions.has(action.regionRef)) {
        problems.push('focusCamera references unknown region "' + action.regionRef + '".');
      }
      return problems;
    },
    run(action, ctx) {
      const tile =
        action.tile ||
        (action.unitRef ? ctx.unitTile(action.unitRef) : null) ||
        (action.regionRef ? ctx.regionCenter(action.regionRef) : null);
      if (!tile) return;
      ctx.present({ type: "focusCamera", tile, hold: action.hold || 0 }, { blocking: false });
    }
  },

  requestMusicState: {
    authority: "presentation",
    name: "Request music state",
    fields: ["track", "context"],
    blocking: false,
    summary: "Asks the audio layer for a track or context change. Never blocks.",
    validate(action) {
      return action.track || action.context ? [] : ["requestMusicState needs a `track` or `context`."];
    },
    run(action, ctx) {
      ctx.present(
        { type: "requestMusicState", track: action.track || null, context: action.context || null },
        { blocking: false }
      );
    }
  },

  queueBark: {
    authority: "presentation",
    name: "Queue bark",
    fields: ["speaker", "text"],
    blocking: false,
    summary: "A one- or two-line callout that does not pause the battle.",
    validate(action) {
      return action.text ? [] : ["queueBark needs `text`."];
    },
    run(action, ctx) {
      ctx.present(
        { type: "queueBark", speaker: action.speaker || "narrator", text: action.text },
        { blocking: false }
      );
    }
  }
};

export const ACTION_REGISTRY = { ...simulationActions, ...presentationActions };

export const ACTION_IDS = Object.keys(ACTION_REGISTRY);

export const SIMULATION_ACTION_IDS = Object.keys(simulationActions);
export const PRESENTATION_ACTION_IDS = Object.keys(presentationActions);

export function actionById(id) {
  return ACTION_REGISTRY[id] || null;
}

export function isBlockingAction(action) {
  const definition = actionById(action && action.type);
  return !!definition && definition.blocking === true;
}

/** Static validation used by the compiler and the editor.
 *  `refs` carries Sets of every id the mission declares. */
export function validateAction(action, refs, path) {
  const where = path || "action";
  if (!action || typeof action !== "object") return [where + " must be an object."];
  const definition = actionById(action.type);
  if (!definition) {
    return [
      where + ' uses unknown action "' + action.type + '". Available: ' + ACTION_IDS.join(", ")
    ];
  }
  const problems = definition.validate ? definition.validate(action, refs) || [] : [];
  return problems.map((message) => where + ": " + message);
}
