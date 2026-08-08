/* =========================================================================
 * MISSION RUNTIME
 *
 * The state machine that turns mission data into authoritative battle changes.
 *
 * It lives *inside* battle state (`state.mission`) rather than in React. That
 * is the single most important decision in this module and everything else
 * follows from it:
 *
 *   - a headless simulation runs the same scripted beats as the game
 *   - deterministic replay reproduces a scripted battle exactly
 *   - a save contains the phase, the fired-once set and any half-executed
 *     beat, so reloading never replays a cinematic that already happened
 *
 * Flow per tick:
 *
 *   simulation events -> inbox -> match beats -> queue -> execute actions
 *                                                          |
 *                                 blocking presentation ---+--> suspend
 *                                                          |
 *                                 simulation action -------+--> new events
 *
 * Actions can produce events that fire more beats. That is intended (a
 * scripted kill should be able to advance a phase) and it is also the obvious
 * way to write an infinite loop, so every path is bounded — see LIMITS.
 * =======================================================================*/

import { deriveMissionEvents, DEFAULT_HP_THRESHOLDS } from "./events.js";
import { matchTrigger, evaluateCondition } from "./conditions.js";
import { actionById, isBlockingAction } from "./actions.js";
import {
  createFactionState,
  setRelationship,
  relationshipBetween,
  ensureFaction
} from "./factions.js";

export const LIMITS = {
  /** Beats fired while draining one batch of events. */
  maxBeatsPerDrain: 64,
  /** How deep action -> event -> action recursion may go. */
  maxActionDepth: 8,
  /** Events processed in one drain before the runtime gives up and reports. */
  maxEventsPerDrain: 512,
  /** Total actions executed for a single beat. */
  maxActionsPerBeat: 64
};

/* ---------------------------------------------------------------
 * STATE
 * -------------------------------------------------------------*/

/**
 * @param script  compiled mission script: { phases, beats, objectives, groups,
 *                regions, scenes, factions, startPhaseId }
 */
export function createMissionRuntimeState(script) {
  const groups = {};
  for (const group of (script && script.groups) || []) {
    groups[group.id] = {
      active: group.startsActive !== false,
      spawned: group.deployment !== "reserve",
      teamId: group.teamId || null
    };
  }

  return {
    scriptId: (script && script.id) || null,
    phaseId: null,
    phaseHistory: [],
    phaseEnteredAt: 0,
    facts: {},
    firedCounts: {},
    groups,
    campaignFlagRequests: [],
    inbox: [],
    queue: [],
    pending: null,
    wait: null,
    presentation: [],
    presentationSeq: 0,
    errors: [],
    depth: 0,
    /** Set once the runtime has emitted battleStarted and entered phase one. */
    started: false
  };
}

/* ---------------------------------------------------------------
 * CONTEXT
 *
 * `deps` is supplied by the host (App.jsx) and carries the engine adapter plus
 * the compiled script. Everything else is derived here so the runtime has one
 * consistent view.
 * -------------------------------------------------------------*/

function buildContext(state, deps) {
  const runtime = state.mission;
  const script = deps.script;
  const engine = deps.engine;

  const unitByRef = (ref) => {
    if (!ref) return null;
    for (const id of state.unitOrder) {
      const unit = state.units[id];
      if (unit.ref === ref) return unit;
    }
    return null;
  };

  const resolveUnit = (ref) => {
    const unit = unitByRef(ref);
    return unit ? unit.id : null;
  };

  const regionTiles = (ref) => {
    const region = (script.regions || []).find((entry) => entry.id === ref);
    return region ? region.tiles : [];
  };

  const regionsContaining = (x, y) =>
    (script.regions || [])
      .filter((region) => region.tiles.some((tile) => tile.x === x && tile.y === y))
      .map((region) => region.id);

  const objectiveDefinition = (ref) =>
    (script.objectives || []).find((entry) => entry.id === ref) || null;

  const entries = () => {
    if (!state.objectiveState.entries) state.objectiveState.entries = [];
    return state.objectiveState.entries;
  };

  const log = (text, data) => engine.logLine(state, "missionScript", text, data || null);

  const ctx = {
    state,
    engine,
    script,
    runtime,
    resolveUnit,
    resolveRegionTiles: regionTiles,
    regionsContaining,
    log,

    emit(missionEvent) {
      runtime.inbox.push(missionEvent);
    },

    present(request, options) {
      runtime.presentationSeq += 1;
      const entry = {
        id: "p" + runtime.presentationSeq,
        ...request,
        blocking: !!(options && options.blocking)
      };
      runtime.presentation.push(entry);
      if (entry.blocking) runtime.wait = { token: entry.id, request: entry };
      return entry;
    },

    unitTile(ref) {
      const unit = unitByRef(ref);
      return unit && unit.alive ? { x: unit.x, y: unit.y } : null;
    },

    regionCenter(ref) {
      const tiles = regionTiles(ref);
      if (!tiles.length) return null;
      const sx = tiles.reduce((total, tile) => total + tile.x, 0);
      const sy = tiles.reduce((total, tile) => total + tile.y, 0);
      return { x: Math.round(sx / tiles.length), y: Math.round(sy / tiles.length) };
    },

    nearestFreeTileInRegion(regionRef, movingUnitId) {
      const tiles = regionTiles(regionRef);
      if (!tiles.length) return null;
      const mover = state.units[movingUnitId];
      const free = tiles.filter((tile) => {
        if (!engine.isWalkable(state, tile.x, tile.y)) return false;
        return !state.unitOrder.some((id) => {
          const unit = state.units[id];
          return unit.alive && id !== movingUnitId && unit.x === tile.x && unit.y === tile.y;
        });
      });
      if (!free.length) return null;
      if (!mover) return free[0];
      // Deterministic: closest, ties broken by coordinate order.
      return free
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.x - mover.x) + Math.abs(a.y - mover.y) -
              (Math.abs(b.x - mover.x) + Math.abs(b.y - mover.y)) ||
            a.y - b.y ||
            a.x - b.x
        )[0];
    },

    /* ---- phases ---- */
    startPhase(phaseId) {
      startPhase(state, deps, phaseId);
    },
    completePhase(phaseId) {
      completePhase(state, deps, phaseId);
    },

    /* ---- objectives ---- */
    objectives: {
      add(ref) {
        const definition = objectiveDefinition(ref);
        if (!definition) {
          runtime.errors.push('addObjective: unknown objective "' + ref + '".');
          return;
        }
        const list = entries();
        const existing = list.find((entry) => entry.ref === ref);
        if (existing) {
          if (existing.status !== "active") {
            existing.status = "active";
            existing.progress = {};
          }
          return;
        }
        list.push({
          ref,
          objectiveId: definition.objectiveId,
          params: JSON.parse(JSON.stringify(definition.params || {})),
          progress: {},
          status: "active",
          text: definition.text || "",
          required: definition.required !== false,
          hidden: definition.hidden === true
        });
        log("Objective added: " + (definition.text || ref), { objectiveRef: ref });
        ctx.emit({ type: "objectiveProgressed", objectiveRef: ref, status: "active" });
      },

      remove(ref) {
        const list = entries();
        const index = list.findIndex((entry) => entry.ref === ref);
        if (index < 0) return;
        list.splice(index, 1);
        log("Objective removed: " + ref, { objectiveRef: ref });
      },

      replace(refs) {
        const list = entries();
        list.length = 0;
        for (const ref of refs) ctx.objectives.add(ref);
        log("Objectives replaced", { objectiveRefs: refs });
      },

      setStatus(ref, status) {
        const list = entries();
        const entry = list.find((item) => item.ref === ref);
        if (!entry) {
          runtime.errors.push('objective "' + ref + '" is not active.');
          return;
        }
        if (entry.status === status) return;
        entry.status = status;
        log("Objective " + status + ": " + (entry.text || ref), { objectiveRef: ref, status });
        ctx.emit({
          type: status === "failed" ? "objectiveFailed" : "objectiveCompleted",
          objectiveRef: ref
        });
      },

      get(ref) {
        return entries().find((entry) => entry.ref === ref) || null;
      }
    },

    /* ---- groups ---- */
    groups: {
      setActive(ref, active) {
        const group = runtime.groups[ref];
        if (!group) {
          runtime.errors.push('group "' + ref + '" is not defined.');
          return;
        }
        if (group.active === active) return;
        group.active = active;
        for (const id of state.unitOrder) {
          const unit = state.units[id];
          if (unit.groupId !== ref) continue;
          unit.dormant = !active;
          // A group waking mid-battle must not get a free instant turn.
          if (active && unit.nextActionTime < state.currentTime) {
            unit.nextActionTime = state.currentTime;
          }
        }
        log((active ? "Group activated: " : "Group deactivated: ") + ref, { groupRef: ref });
        if (active) ctx.emit({ type: "groupAlerted", groupRef: ref });
      },

      spawn(ref, regionRef) {
        const group = runtime.groups[ref];
        if (!group) {
          runtime.errors.push('group "' + ref + '" is not defined.');
          return;
        }
        if (group.spawned) return; // never double-spawn a wave
        const reserve = (script.groups || []).find((entry) => entry.id === ref);
        const specs = (reserve && reserve.units) || [];
        const placed = [];
        for (const spec of specs) {
          const tile = regionRef
            ? ctx.nearestFreeTileInRegion(regionRef, null) || { x: spec.x, y: spec.y }
            : { x: spec.x, y: spec.y };
          const unitId = engine.spawnUnit(state, {
            ...spec,
            x: tile.x,
            y: tile.y,
            groupId: ref,
            dormant: false
          });
          if (unitId) placed.push(unitId);
        }
        group.spawned = true;
        group.active = true;
        log("Group spawned: " + ref + " (" + placed.length + " units)", { groupRef: ref, unitIds: placed });
        ctx.emit({ type: "groupSpawned", groupRef: ref, count: placed.length });
      }
    },

    /* ---- factions ---- */
    factions: {
      set(a, b, relationship, options) {
        const changes = setRelationship(state.factions, a, b, relationship, options);
        if (!changes.length) return; // idempotent: no duplicate events on a re-fire
        for (const change of changes) {
          log(
            "Faction " + change.a + " -> " + change.b + ": " + change.from + " becomes " + change.to,
            change
          );
        }
        ctx.emit({
          type: "factionChanged",
          teamId: a,
          otherTeamId: b,
          relationship: relationshipBetween(state.factions, a, b)
        });
      }
    },

    /* ---- condition context ---- */
    conditionContext() {
      return {
        phaseId: runtime.phaseId,
        facts: runtime.facts,
        flags: deps.campaignFlags || {},
        activationCount: state.activationCount,
        factionState: state.factions,
        teamIds: state.teams.map((team) => team.id),
        unit(ref) {
          const unit = unitByRef(ref);
          if (!unit) return null;
          const stats = engine.unitStats(state, unit.id);
          return {
            alive: unit.alive,
            teamId: unit.teamId,
            x: unit.x,
            y: unit.y,
            hpPercent: (unit.currentHp / Math.max(1, stats.maxHp)) * 100
          };
        },
        objective(ref) {
          return ctx.objectives.get(ref);
        },
        group(ref) {
          return runtime.groups[ref] || null;
        },
        region(ref) {
          const tiles = regionTiles(ref);
          return { contains: (x, y) => tiles.some((tile) => tile.x === x && tile.y === y) };
        },
        teamAliveCount(teamId) {
          return state.unitOrder.filter((id) => state.units[id].alive && state.units[id].teamId === teamId)
            .length;
        },
        firedCount(id) {
          return runtime.firedCounts[id] || 0;
        }
      };
    }
  };

  return ctx;
}

/* ---------------------------------------------------------------
 * EVENT INGESTION
 * -------------------------------------------------------------*/

/** Called by the engine for each simulation event it processes. */
export function ingestSimulationEvent(state, deps, simEvent) {
  if (!state.mission) return;
  const script = deps.script;
  const engine = deps.engine;

  const view = {
    unitRefById: (id) => {
      const unit = state.units[id];
      return unit ? unit.ref || id : id;
    },
    unitTeam: (id) => (state.units[id] ? state.units[id].teamId : null),
    unitTags: (id) => engine.unitTags(state, id),
    hpPercent: (id) => {
      const unit = state.units[id];
      if (!unit) return 100;
      const stats = engine.unitStats(state, id);
      return (unit.currentHp / Math.max(1, stats.maxHp)) * 100;
    },
    regionsContaining: (x, y) =>
      (script.regions || [])
        .filter((region) => region.tiles.some((tile) => tile.x === x && tile.y === y))
        .map((region) => region.id),
    thresholds: DEFAULT_HP_THRESHOLDS
  };

  for (const missionEvent of deriveMissionEvents(simEvent, view)) {
    state.mission.inbox.push(missionEvent);
  }
}

/* ---------------------------------------------------------------
 * PHASES
 * -------------------------------------------------------------*/

function phaseById(script, phaseId) {
  return (script.phases || []).find((phase) => phase.id === phaseId) || null;
}

function startPhase(state, deps, phaseId) {
  const runtime = state.mission;
  const phase = phaseById(deps.script, phaseId);
  if (!phase) {
    runtime.errors.push('startPhase: unknown phase "' + phaseId + '".');
    return;
  }
  if (runtime.phaseId === phaseId) return;

  const previous = runtime.phaseId;
  if (previous) runtime.phaseHistory.push(previous);
  runtime.phaseId = phaseId;
  runtime.phaseEnteredAt = state.activationCount;

  const ctx = buildContext(state, deps);
  ctx.log("Phase started: " + (phase.name || phase.id), { phaseRef: phase.id, from: previous || null });

  // Declarative phase setup runs before onEnter actions, so an onEnter beat
  // sees the objectives and groups its phase declares.
  if (phase.objectives && phase.objectives.length) {
    ctx.objectives.replace(phase.objectives);
  }
  for (const groupRef of phase.activateGroups || []) ctx.groups.setActive(groupRef, true);
  for (const groupRef of phase.deactivateGroups || []) ctx.groups.setActive(groupRef, false);

  ctx.emit({ type: "phaseStarted", phaseRef: phase.id });

  if ((phase.onEnter || []).length) {
    runtime.queue.push({ beatId: "phase:" + phase.id + ":onEnter", actions: phase.onEnter, index: 0 });
  }
}

function completePhase(state, deps, phaseId) {
  const runtime = state.mission;
  const phase = phaseById(deps.script, phaseId || runtime.phaseId);
  if (!phase) return;
  const ctx = buildContext(state, deps);
  ctx.log("Phase completed: " + (phase.name || phase.id), { phaseRef: phase.id });
  ctx.emit({ type: "phaseCompleted", phaseRef: phase.id });

  if ((phase.onExit || []).length) {
    runtime.queue.push({ beatId: "phase:" + phase.id + ":onExit", actions: phase.onExit, index: 0 });
  }
  if (phase.next) {
    runtime.queue.push({
      beatId: "phase:" + phase.id + ":next",
      actions: [{ type: "startPhase", phaseRef: phase.next }],
      index: 0
    });
  }
}

/* ---------------------------------------------------------------
 * BEAT MATCHING
 * -------------------------------------------------------------*/

function beatIsEligible(beat, runtime, ctx) {
  if (beat.once !== false && (runtime.firedCounts[beat.id] || 0) > 0) return false;
  if (beat.maxFires != null && (runtime.firedCounts[beat.id] || 0) >= beat.maxFires) return false;
  if (beat.phase) {
    const phases = Array.isArray(beat.phase) ? beat.phase : [beat.phase];
    if (!phases.includes(runtime.phaseId)) return false;
  }
  if (beat.when && !evaluateCondition(beat.when, ctx.conditionContext())) return false;
  return true;
}

function collectBeatsForEvent(state, deps, ctx, missionEvent) {
  const runtime = state.mission;
  const matched = [];

  for (const beat of deps.script.beats || []) {
    if (beat.trigger && !matchTrigger(beat.trigger, missionEvent)) continue;
    // A beat with no trigger is a pure state check, re-evaluated on every event.
    if (!beat.trigger && !beat.when) continue;
    if (!beatIsEligible(beat, runtime, ctx)) continue;
    matched.push(beat);
  }

  // Automatic phase transitions are just beats with a reserved shape.
  for (const phase of deps.script.phases || []) {
    if (phase.id === runtime.phaseId) continue;
    if (!phase.enterWhen) continue;
    const enterId = "phase:" + phase.id + ":enterWhen";
    if ((runtime.firedCounts[enterId] || 0) > 0) continue;
    const trigger = phase.enterWhen.trigger || phase.enterWhen.type ? phase.enterWhen : null;
    if (trigger && !matchTrigger(phase.enterWhen, missionEvent)) continue;
    if (phase.enterWhen.when && !evaluateCondition(phase.enterWhen.when, ctx.conditionContext())) continue;
    if (!trigger && !phase.enterWhen.when) continue;
    matched.push({
      id: enterId,
      priority: 1000,
      once: true,
      actions: [{ type: "startPhase", phaseRef: phase.id }]
    });
  }

  matched.sort((a, b) => (b.priority || 50) - (a.priority || 50) || String(a.id).localeCompare(String(b.id)));
  return matched;
}

/* ---------------------------------------------------------------
 * THE TICK
 * -------------------------------------------------------------*/

/**
 * Drains events and executes beats until the runtime is idle or suspended on a
 * blocking presentation request.
 *
 * @returns { waiting, presentation, errors }
 */
export function advanceMission(state, deps) {
  if (!state.mission) return { waiting: null, presentation: [], errors: [] };
  const runtime = state.mission;

  // Suspended on a scene: nothing may proceed until the renderer acknowledges.
  if (runtime.wait) {
    return { waiting: runtime.wait, presentation: runtime.presentation, errors: runtime.errors };
  }

  const ctx = buildContext(state, deps);
  let beatsFired = 0;
  let eventsProcessed = 0;

  for (;;) {
    /* 1. Finish any beat already in flight. */
    if (runtime.pending) {
      const done = executePendingBeat(state, deps, ctx);
      if (!done) {
        // Suspended mid-beat on a blocking action.
        return { waiting: runtime.wait, presentation: runtime.presentation, errors: runtime.errors };
      }
      continue;
    }

    /* 2. Promote the next queued beat. */
    if (runtime.queue.length) {
      beatsFired += 1;
      if (beatsFired > LIMITS.maxBeatsPerDrain) {
        runtime.errors.push(
          "Mission script fired more than " + LIMITS.maxBeatsPerDrain +
            " beats in one drain; the remaining queue was discarded to break a loop."
        );
        runtime.queue.length = 0;
        break;
      }
      runtime.pending = runtime.queue.shift();
      continue;
    }

    /* 3. Take the next event. */
    if (!runtime.inbox.length) break;
    eventsProcessed += 1;
    if (eventsProcessed > LIMITS.maxEventsPerDrain) {
      runtime.errors.push(
        "Mission script processed more than " + LIMITS.maxEventsPerDrain +
          " events in one drain; the inbox was cleared to break a loop."
      );
      runtime.inbox.length = 0;
      break;
    }

    const missionEvent = runtime.inbox.shift();
    for (const beat of collectBeatsForEvent(state, deps, ctx, missionEvent)) {
      runtime.firedCounts[beat.id] = (runtime.firedCounts[beat.id] || 0) + 1;
      runtime.queue.push({
        beatId: beat.id,
        actions: beat.actions || [],
        index: 0,
        event: missionEvent
      });
    }
  }

  return { waiting: runtime.wait, presentation: runtime.presentation, errors: runtime.errors };
}

/** Executes the in-flight beat from its saved index.
 *  @returns true when the beat finished, false when it suspended. */
function executePendingBeat(state, deps, ctx) {
  const runtime = state.mission;
  const pending = runtime.pending;

  if (pending.index >= (pending.actions || []).length) {
    runtime.pending = null;
    return true;
  }
  if (pending.index > LIMITS.maxActionsPerBeat) {
    runtime.errors.push('Beat "' + pending.beatId + '" exceeded the action limit.');
    runtime.pending = null;
    return true;
  }

  runtime.depth += 1;
  if (runtime.depth > LIMITS.maxActionDepth) {
    runtime.errors.push(
      'Beat "' + pending.beatId + '" recursed past depth ' + LIMITS.maxActionDepth + "; it was stopped."
    );
    runtime.depth -= 1;
    runtime.pending = null;
    return true;
  }

  try {
    while (pending.index < pending.actions.length) {
      const action = pending.actions[pending.index];
      pending.index += 1;

      const definition = actionById(action.type);
      if (!definition) {
        runtime.errors.push('Beat "' + pending.beatId + '": unknown action "' + action.type + '".');
        continue;
      }

      const result = definition.run(action, ctx);
      if (result && result.error) runtime.errors.push('Beat "' + pending.beatId + '": ' + result.error);

      // A simulation action may have queued engine events; drain them now so
      // the mission events they produce are seen in the right order.
      if (definition.authority === "simulation") {
        deps.engine.processEvents(state);
      }

      if (isBlockingAction(action) && runtime.wait) {
        return false; // resume here after the renderer acknowledges
      }
    }
    runtime.pending = null;
    return true;
  } finally {
    runtime.depth -= 1;
  }
}

/* ---------------------------------------------------------------
 * WAIT RESOLUTION
 * -------------------------------------------------------------*/

/**
 * Called by the renderer when a blocking request finishes, or immediately in a
 * headless run. `payload` carries anything the scene produced — a dialogue
 * choice, for example, which becomes a mission fact.
 */
export function resolveMissionWait(state, deps, token, payload) {
  const runtime = state.mission;
  if (!runtime || !runtime.wait) return false;
  if (token && runtime.wait.token !== token) return false;

  const request = runtime.wait.request;
  runtime.wait = null;

  if (request && request.type === "showScene") {
    const ctx = buildContext(state, deps);
    if (payload && payload.facts) {
      for (const key of Object.keys(payload.facts)) {
        runtime.facts[key] = payload.facts[key];
      }
    }
    ctx.emit({
      type: "sceneCompleted",
      sceneRef: request.sceneRef,
      choiceId: (payload && payload.choiceId) || null,
      optionId: (payload && payload.optionId) || null
    });
  }
  return true;
}

/** Drains presentation requests for the renderer. Blocking entries stay until
 *  resolved so a reload can re-show the scene that was on screen. */
export function takePresentationRequests(state) {
  const runtime = state.mission;
  if (!runtime) return [];
  const waitingToken = runtime.wait ? runtime.wait.token : null;
  const taken = runtime.presentation.filter((entry) => entry.id !== waitingToken);
  runtime.presentation = runtime.presentation.filter((entry) => entry.id === waitingToken);
  return taken;
}

/** Headless driver: resolve every blocking request with its authored default
 *  so a scripted battle runs to completion in a test or a soak. */
export function autoResolveWaits(state, deps, maxIterations) {
  const cap = maxIterations || 64;
  let iterations = 0;
  while (state.mission && state.mission.wait) {
    iterations += 1;
    if (iterations > cap) {
      state.mission.errors.push("autoResolveWaits exceeded its iteration cap.");
      break;
    }
    const request = state.mission.wait.request;
    const payload = defaultWaitPayload(deps, request);
    resolveMissionWait(state, deps, request.id, payload);
    advanceMission(state, deps);
  }
  return state;
}

/** The deterministic answer a headless run gives to a blocking request.
 *  For a scene with choices that is the authored default option, or the first
 *  one — never a random pick, because choices set facts and facts change the
 *  authoritative outcome. */
export function defaultWaitPayload(deps, request) {
  if (!request || request.type !== "showScene") return null;
  const scene = (deps.script.scenes || {})[request.sceneRef];
  if (!scene || !(scene.choices || []).length) return null;
  const choice = scene.choices[0];
  const option =
    choice.options.find((entry) => entry.id === choice.defaultOptionId) || choice.options[0];
  if (!option) return null;
  return {
    choiceId: choice.id,
    optionId: option.id,
    facts: option.fact ? { [option.fact]: option.factValue === undefined ? true : option.factValue } : {}
  };
}

/* ---------------------------------------------------------------
 * BOOTSTRAP
 * -------------------------------------------------------------*/

/** Enters the first phase and emits battleStarted. Idempotent. */
export function startMission(state, deps) {
  const runtime = state.mission;
  if (!runtime || runtime.started) return state;
  runtime.started = true;

  const first = deps.script.startPhaseId || ((deps.script.phases || [])[0] || {}).id || null;
  if (first) startPhase(state, deps, first);

  // Objectives flagged `startsActive` cover missions that use beats without a
  // phase declaring an objective set.
  const ctx = buildContext(state, deps);
  for (const objective of deps.script.objectives || []) {
    if (objective.startsActive) ctx.objectives.add(objective.id);
  }

  runtime.inbox.push({ type: "battleStarted" });
  advanceMission(state, deps);
  return state;
}

export { buildContext, phaseById, startPhase, completePhase, createFactionState, ensureFaction };
