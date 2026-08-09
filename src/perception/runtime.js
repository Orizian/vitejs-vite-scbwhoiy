/* =========================================================================
 * PERCEPTION RUNTIME
 *
 * Drives the knowledge model off the authoritative event queue: the same
 * events the mission scripting layer and the reaction framework consume. No
 * polling, no log rescanning, no wall clock — decay is counted in activations,
 * so a replay from the same seed produces the same beliefs at the same moments.
 *
 * The runtime is a *consumer* of simulation events and a *producer* of
 * `knowledgeChanged` records. It never mutates units.
 * =======================================================================*/

import {
  createPerceptionState,
  ensureFactionKnowledge,
  applyObservation,
  decayFaction,
  knowledgeOf,
  knowledgeStateOf,
  markInvestigated,
  describeFactionKnowledge,
  countKnowledge,
  factionClock,
  advanceFactionClock,
  factionIsBlind,
  factionHasSolution,
  setKnowledge,
  setSearchAnchor,
  searchAnchorOf
} from "./knowledge.js";
import { sweepFaction, observingFactions, emitSignature, pruneSignatures } from "./sensors.js";
import { rankOf } from "./channels.js";

export const PERCEPTION_LIMITS = {
  /** Sweeps allowed inside one command. A refresh is idempotent, so more than
   *  this means something is looping rather than resolving. */
  maxSweepsPerCommand: 256
};

/**
 * Simulation events that can change what is visible.
 *
 * Kept as an explicit list rather than "refresh on everything" because a sweep
 * is the expensive operation in this system and most events (cooldowns,
 * resources, logging) cannot possibly move a sightline.
 */
export const PERCEPTION_TICK_EVENTS = [
  "unitActivated",
  "unitMoved",
  "unitForcedMove",
  "unitTeleported",
  "unitsSwapped",
  "unitDefeated",
  "unitDeployed",
  "unitSpawned",
  "unitDespawned",
  "unitRevived",
  "unitTransformed",
  "unitChangedTeam",
  "statusApplied",
  "statusRemoved",
  "statusExpired",
  "terrainCreated",
  "terrainRemoved",
  "turnEnded"
];

const TICK_EVENT_SET = new Set(PERCEPTION_TICK_EVENTS);

/**
 * Events that make a unit loud.
 *
 * Data, not branches: an entry says which field of the event names the unit
 * that made the noise, and what it emits on which channel for how long.
 * Keraunos's firing signature is this table plus a chassis that emits harder;
 * nothing about it is special-cased.
 *
 * `actor` is spelled out per event because the simulation is not uniform about
 * it — an attack names its actor `sourceUnitId` while a defeat names its
 * subject `unitId`. Guessing is how a signature silently never fires.
 */
export const DEFAULT_EVENT_SIGNATURES = {
  abilityUsed: {
    actor: "sourceUnitId",
    emits: [
      { channel: "acoustic", strength: 1, duration: 1 },
      { channel: "signal", strength: 1, duration: 1 }
    ]
  },
  attackMissed: {
    actor: "sourceUnitId",
    emits: [{ channel: "acoustic", strength: 1, duration: 1 }]
  },
  unitDefeated: {
    actor: "unitId",
    emits: [{ channel: "acoustic", strength: 1, duration: 1 }]
  }
};

export function createPerception(factionIds, options) {
  const perception = createPerceptionState(factionIds, options);
  perception.signatures = {};
  perception.changes = [];
  perception.sweeps = 0;
  return perception;
}

export function perceptionEnabled(state) {
  return !!(state && state.perception && state.perception.enabled);
}

/* ---------------------------------------------------------------
 * THE TICK
 * -------------------------------------------------------------*/

/**
 * Recomputes every faction's knowledge from the current board.
 *
 * Order of operations matters and is deliberate:
 *   1. sweep    — what can be seen right now
 *   2. apply    — observations upgrade records
 *   3. decay    — anything *not* observed slips a step, on its own schedule
 *
 * Decaying after applying is what makes "he was right there" work: the record
 * still holds the tile from the last sweep that saw him when it demotes.
 */
export function refreshPerception(state, deps, options) {
  const perception = state.perception;
  if (!perception || !perception.enabled) return [];
  const engine = deps.engine;
  const activation = engine.activationIndex(state);
  const changes = [];

  // A sweep is the expensive operation here and it is idempotent, so a board
  // that has not moved since the last one has nothing to recompute. One O(n)
  // stamp replaces an O(n²) pass over observer/subject pairs.
  const stamp = boardStamp(state, deps, perception);
  if (perception.stamp === stamp && !(options && options.force)) return [];
  perception.stamp = stamp;

  perception.sweeps += 1;
  const losCache = new Map();
  const factions = observingFactions(state, deps);
  for (const factionId of factions) {
    ensureFactionKnowledge(perception, factionId);
    // Records are dated on the believing faction's own clock, so "four
    // activations ago" means four of its turns rather than four of anyone's.
    const clock = factionClock(perception, factionId);
    const { best, observed } = sweepFaction(state, deps, perception, factionId, losCache);

    for (const subjectId of Object.keys(best).sort()) {
      const change = applyObservation(perception, factionId, best[subjectId], clock);
      if (change) changes.push(change);
    }

    if (!options || options.decay !== false) {
      for (const change of decayFaction(perception, factionId, clock, observed)) {
        // A contact that finally goes cold leaves behind the place it went
        // cold in. That is the difference between forgetting and giving up.
        if (change.to === "unseen" && change.lastKnown) {
          setSearchAnchor(perception, factionId, change.lastKnown);
        }
        changes.push(change);
      }
    }

    for (const change of reconSweep(state, deps, perception, factionId, clock)) {
      changes.push(change);
    }
  }

  pruneSignatures(perception, activation);
  // The opening sweep is setup, not news: emitting a hundred `knowledgeChanged`
  // events before the first activation would drown the log and the trigger
  // stream in the one moment nothing has actually changed yet.
  if (changes.length && !(options && options.emit === false)) {
    emitKnowledgeChanges(state, deps, changes);
  }
  return changes;
}

/**
 * Everything a sweep's answer depends on, in one cheap string.
 *
 * Positions, who is alive, what conceals or reveals them, the terrain
 * overrides that make and break sightlines, and the activation counter that
 * ages signatures and drives decay. Anything that could change an observation
 * has to be in here, so this is deliberately generous rather than clever.
 */
function boardStamp(state, deps, perception) {
  const engine = deps.engine;
  let stamp = engine.activationIndex(state) + "|" + Object.keys(state.terrainOverrides || {}).length;
  for (const unitId of engine.unitIds(state)) {
    const unit = engine.unit(state, unitId);
    if (!unit) continue;
    stamp += ";" + unitId + "," + unit.x + "," + unit.y + "," + (unit.alive ? 1 : 0) +
      "," + unit.teamId + "," + (unit.statuses ? unit.statuses.length : 0) +
      "," + Object.values(unit.equipment || {}).join("+");
  }
  for (const factionId of Object.keys(perception.factions)) {
    stamp += "/" + (perception.factions[factionId].clock || 0);
  }
  // Signatures are inputs too: a vent opening changes what is observable
  // without moving anybody.
  for (const unitId of Object.keys(perception.signatures || {})) {
    const bucket = perception.signatures[unitId];
    for (const channel of Object.keys(bucket)) {
      stamp += "!" + unitId + channel + bucket[channel].strength + "@" + bucket[channel].until;
    }
  }
  return stamp;
}

/**
 * Reconnaissance sweep: the escalation that breaks a total loss of contact.
 *
 * Fires only for a faction that has held *no* contact of any kind for a
 * configured number of its own activations. It hands out SUSPECTED contacts —
 * a direction to go, never a firing solution — and they decay like anything
 * else, so within a few activations the faction is back on its own sensors.
 *
 * This is the one place outside the sensor sweep that reads a true position,
 * and it is deliberate: without it, two sides that lose each other in a maze
 * stand still until the activation cap, which reads as a broken AI rather than
 * a cautious one. Set `reconSweepActivations: 0` to turn it off for a mission
 * whose design wants the standoff.
 */
function reconSweep(state, deps, perception, factionId, clock) {
  const limit = perception.config.reconSweepActivations;
  const faction = perception.factions[factionId];
  if (!limit || !faction || faction.withoutSolutionFor < limit) return [];
  if (factionHasSolution(perception, factionId)) {
    faction.withoutSolutionFor = 0;
    return [];
  }

  // Stage one hands out directions to a faction that has lost the enemy
  // entirely. Stage two paints a trace the faction has been sitting on
  // without ever resolving it. Stage two never invents a contact.
  const blind = factionIsBlind(perception, factionId);
  const next = blind ? "suspected" : "acquired";
  const engine = deps.engine;
  const changes = [];

  for (const unitId of engine.unitIds(state)) {
    const unit = engine.unit(state, unitId);
    if (!unit || !unit.alive) continue;
    if (engine.teamRelationship(state, factionId, unitId) !== "hostile") continue;
    if (!blind) {
      const record = knowledgeOf(perception, factionId, unitId);
      if (!record || record.state === "unseen") continue;
    }
    const change = setKnowledge(perception, factionId, unitId, next, {
      activation: clock,
      x: unit.x,
      y: unit.y,
      accuracy: next === "acquired" ? "exact" : "approximate",
      channels: ["intel"],
      hold: perception.config.reconHoldActivations,
      source: "recon"
    });
    if (change) {
      change.reason = "recon";
      changes.push(change);
    }
  }
  faction.withoutSolutionFor = 0;
  return changes;
}

/**
 * Emits one `knowledgeChanged` simulation event per transition.
 *
 * These go on the authoritative queue, which means mission triggers and
 * reactions can key off "the enemy has spotted you" without either layer
 * knowing the perception system exists.
 */
function emitKnowledgeChanges(state, deps, changes) {
  const engine = deps.engine;
  if (!engine.queueEvent) return;
  for (const change of changes) {
    engine.queueEvent(state, {
      type: "knowledgeChanged",
      factionId: change.factionId,
      unitId: change.unitId,
      from: change.from,
      to: change.to,
      reason: change.reason || "observed",
      x: change.record.x,
      y: change.record.y
    });
  }
}

/**
 * Consumes one authoritative event.
 *
 * Signatures are raised *before* the sweep so the shot that gave a unit away
 * is audible in the same tick it was fired, rather than a beat later.
 */
export function ingestPerceptionEvent(state, deps, event) {
  const perception = state.perception;
  if (!perception || !perception.enabled || !event) return null;
  const engine = deps.engine;
  const activation = engine.activationIndex(state);

  // A faction's clock ticks when one of *its* units takes a turn. Every decay
  // duration is measured on it, so a stealth window is the same length whether
  // the battle has four units in it or forty.
  if (event.type === "unitActivated" && event.unitId) {
    const actor = engine.unit(state, event.unitId);
    if (actor) {
      advanceFactionClock(perception, actor.teamId);
      const faction = perception.factions[actor.teamId];
      faction.withoutSolutionFor = factionHasSolution(perception, actor.teamId)
        ? 0
        : faction.withoutSolutionFor + 1;
    }
  }

  const signature = (deps.signatures || DEFAULT_EVENT_SIGNATURES)[event.type];
  const actorId = signature ? event[signature.actor] : null;
  let loud = false;
  if (actorId) {
    const scale = engine.signatureScale ? engine.signatureScale(state, actorId, event) : 1;
    for (const entry of signature.emits) {
      const strength = entry.strength * (scale == null ? 1 : scale);
      if (strength <= 0) continue;
      if (emitSignature(perception, actorId, entry.channel, { activation, strength, duration: entry.duration })) {
        loud = true;
      }
    }
  }

  if (!loud && !TICK_EVENT_SET.has(event.type)) return null;
  const changes = refreshPerception(state, deps);

  // A unit that starts its turn standing on a lead has searched it. Doing this
  // on activation rather than inside the AI keeps it true for player units
  // too, and keeps the AI's decision function free of side effects.
  if (event.type === "unitActivated" && event.unitId) {
    searchTargetFor(state, deps, event.unitId);
  }
  return changes;
}

/* ---------------------------------------------------------------
 * SEARCH
 * -------------------------------------------------------------*/

/**
 * The contact a searching unit should investigate, or null.
 *
 * Reads only the acting faction's records — the real position of the unit it
 * is hunting is never consulted, which is the whole point. When the searcher
 * reaches the last-known tile the lead is marked investigated, and decay
 * retires it quickly rather than leaving the unit orbiting an empty corner.
 */
export function searchTargetFor(state, deps, unitId) {
  const best = searchLeadFor(state, deps, unitId);
  if (!best) return null;
  const unit = deps.engine.unit(state, unitId);
  const perception = state.perception;
  if (best.distance <= perception.config.searchArrivalRadius) {
    markInvestigated(perception, unit.teamId, best.unitId, factionClock(perception, unit.teamId));
  }
  return best;
}

/** The same lead, without the side effect. Safe to call inside a scorer. */
export function searchLeadFor(state, deps, unitId) {
  const perception = state.perception;
  if (!perception || !perception.enabled) return null;
  const engine = deps.engine;
  const unit = engine.unit(state, unitId);
  if (!unit || !unit.alive) return null;
  const faction = perception.factions[unit.teamId];
  if (!faction) return null;

  let best = null;
  for (const subjectId of Object.keys(faction.units).sort()) {
    const record = faction.units[subjectId];
    if (record.state !== "suspected") continue;
    if (record.x == null || record.y == null) continue;
    const subject = engine.unit(state, subjectId);
    // Nobody hunts a corpse. A record can outlive its unit by a sweep or two.
    if (!subject || !subject.alive) continue;
    if (engine.teamRelationship(state, unit.teamId, subjectId) !== "hostile") continue;
    const distance = engine.distance(unit, { x: record.x, y: record.y });
    // Freshest lead first, nearest as the tie-break: a searcher chases the
    // newest information, not the closest ghost.
    if (
      !best ||
      record.positionActivation > best.record.positionActivation ||
      (record.positionActivation === best.record.positionActivation && distance < best.distance) ||
      (record.positionActivation === best.record.positionActivation &&
        distance === best.distance &&
        subjectId < best.unitId)
    ) {
      best = { unitId: subjectId, record, distance, x: record.x, y: record.y };
    }
  }
  return best;
}

/**
 * Where a unit that knows nothing should be heading.
 *
 * Never a unit and never a live position — an area the faction has a
 * legitimate reason to be interested in. Without this a blind faction has a
 * completely flat scoring surface and simply stands still, which reads as a
 * broken AI rather than a cautious one.
 */
export function searchAnchorFor(state, deps, unitId) {
  const perception = state.perception;
  if (!perception || !perception.enabled) return null;
  const unit = deps.engine.unit(state, unitId);
  if (!unit) return null;
  return searchAnchorOf(perception, unit.teamId);
}

export { setSearchAnchor, searchAnchorOf, factionClock };

/* ---------------------------------------------------------------
 * INSPECTION
 * -------------------------------------------------------------*/

export function describePerception(state, deps, factionId) {
  const perception = state.perception;
  if (!perception) return null;
  const factions = factionId ? [factionId] : Object.keys(perception.factions).sort();
  const out = {};
  for (const id of factions) {
    out[id] = {
      acquired: countKnowledge(perception, id, "acquired"),
      suspected: countKnowledge(perception, id, "suspected"),
      contacts: describeFactionKnowledge(perception, id)
    };
  }
  return { enabled: perception.enabled, revision: perception.revision, factions: out };
}

export { knowledgeOf, knowledgeStateOf, rankOf };
