/* =========================================================================
 * SENSOR SWEEP
 *
 * Turns the physical state of the battlefield into observations. The only
 * place in the system that is allowed to look at a unit's true coordinates.
 *
 * Everything it needs from the simulation arrives through an adapter, so this
 * file imports nothing from the engine and can be unit-tested on a fake board.
 * It reuses the engine's existing line-of-sight rather than inventing a second
 * visibility model — two disagreeing definitions of "can see" is a bug factory.
 *
 * Cost model: one pass per observing faction, pairs skipped on cheap distance
 * before anything walks a line, and at most one LOS walk per observer/subject
 * pair regardless of how many channels want it.
 * =======================================================================*/

import {
  OBSERVATION_CHANNELS,
  CHANNEL_ORDER,
  DEFAULT_SENSOR_PROFILE,
  DEFAULT_EMISSION_PROFILE,
  rankOf
} from "./channels.js";

/**
 * @typedef {Object} PerceptionEngine
 * @property {(state:any) => string[]} factionIds
 * @property {(state:any) => string[]} unitIds           Deterministic order.
 * @property {(state:any, unitId:string) => any} unit    { teamId, alive, x, y, actionable }
 * @property {(state:any, a:string, b:string) => string} teamRelationship
 * @property {(state:any, from:any, to:any) => boolean} lineOfSight
 * @property {(a:any, b:any) => number} distance
 * @property {(state:any, unitId:string) => any} sensorProfile
 * @property {(state:any, unitId:string) => any} emissionProfile
 * @property {(state:any) => number} activationIndex
 */

/** Merges an authored partial profile over the default. */
export function resolveSensorProfile(authored) {
  const channels = { ...DEFAULT_SENSOR_PROFILE.channels };
  for (const channelId of Object.keys((authored && authored.channels) || {})) {
    channels[channelId] = { ...(channels[channelId] || {}), ...authored.channels[channelId] };
  }
  return { channels };
}

export function resolveEmissionProfile(authored) {
  return { ...DEFAULT_EMISSION_PROFILE, ...(authored || {}) };
}

/* ---------------------------------------------------------------
 * TRANSIENT SIGNATURES
 *
 * A unit that fires, shouts or lights up an EM band is loud for a while and
 * then is not. Signatures are stored on perception state with an expiry
 * measured in activations, so they serialize and replay exactly.
 * -------------------------------------------------------------*/

export function emitSignature(perception, unitId, channel, options) {
  if (!OBSERVATION_CHANNELS[channel]) return false;
  if (!perception.signatures) perception.signatures = {};
  const activation = (options && options.activation) || 0;
  const duration = options && options.duration != null ? options.duration : 1;
  const strength = options && options.strength != null ? options.strength : 1;
  const bucket = perception.signatures[unitId] || (perception.signatures[unitId] = {});
  const existing = bucket[channel];
  const until = activation + duration;
  // A louder or longer signature wins; a quieter one never masks a loud one.
  if (existing && existing.until >= until && existing.strength >= strength) return false;
  bucket[channel] = {
    strength: Math.max(strength, (existing && existing.strength) || 0),
    until: Math.max(until, (existing && existing.until) || 0)
  };
  perception.revision += 1;
  return true;
}

export function signatureStrength(perception, unitId, channel, activation) {
  const bucket = perception.signatures && perception.signatures[unitId];
  if (!bucket || !bucket[channel]) return 0;
  return bucket[channel].until >= activation ? bucket[channel].strength : 0;
}

/** Drops expired signatures so a long battle does not accumulate dead entries. */
export function pruneSignatures(perception, activation) {
  if (!perception.signatures) return;
  for (const unitId of Object.keys(perception.signatures)) {
    const bucket = perception.signatures[unitId];
    for (const channel of Object.keys(bucket)) {
      if (bucket[channel].until < activation) delete bucket[channel];
    }
    if (!Object.keys(bucket).length) delete perception.signatures[unitId];
  }
}

/* ---------------------------------------------------------------
 * THE SWEEP
 * -------------------------------------------------------------*/

/**
 * Best observation of `subject` available to `observer`, or null.
 *
 * "Best" is the highest knowledge state any single channel can justify; ties
 * break on channel order so the result is stable. Channels are not additive:
 * two suspicions do not make a firing solution. That is a deliberate design
 * statement — an acquired contact must come from a channel good enough to
 * produce one, which is what keeps a stealth build meaningful.
 *
 * An `approximate` channel still reports the tile the subject occupied at the
 * moment it fired, flagged as approximate. The imprecision that matters
 * mechanically is that it cannot produce a firing solution and that it goes
 * stale the instant the subject moves. Spatial jitter is a balance decision
 * that belongs with the detection maths, and plugs into this same field.
 */
export function observeUnit(state, deps, perception, observerId, subjectId) {
  const engine = deps.engine;
  const observer = engine.unit(state, observerId);
  const subject = engine.unit(state, subjectId);
  if (!observer || !subject || !observer.alive || !subject.alive) return null;

  const activation = engine.activationIndex(state);
  const sensors = resolveSensorProfile(engine.sensorProfile(state, observerId));
  const emissions = resolveEmissionProfile(engine.emissionProfile(state, subjectId));
  const distance = engine.distance(observer, subject);
  const concealedFrom = engine.concealedFrom(state, subjectId, observer.teamId);

  let best = null;
  let losKnown = false;
  let los = false;

  for (const channelId of CHANNEL_ORDER) {
    const channel = OBSERVATION_CHANNELS[channelId];
    const sensor = sensors.channels[channelId];
    if (!channel || !sensor || !(sensor.range > 0)) continue;
    if (concealedFrom && !channel.piercesConcealment) continue;

    const emission =
      (emissions[channelId] == null ? 0 : emissions[channelId]) +
      signatureStrength(perception, subjectId, channelId, activation);
    if (emission <= 0) continue;

    const reach = sensor.range * emission;
    if (distance > reach) continue;

    if (channel.requiresLineOfSight) {
      if (!losKnown) {
        los = engine.lineOfSight(state, observer, subject);
        losKnown = true;
      }
      if (!los) continue;
    }

    const candidate = {
      unitId: subjectId,
      observerId,
      channel: channelId,
      state: channel.maxState,
      accuracy: channel.accuracy,
      x: subject.x,
      y: subject.y,
      source: "sensor"
    };
    if (!best || rankOf(candidate.state) > rankOf(best.state)) best = candidate;
    if (best && best.state === "acquired") break;
  }

  return best;
}

/**
 * Every observation one faction can currently make.
 *
 * Returns a map of subject id to the best observation across all of that
 * faction's living units, plus the set of subjects observed at all — decay
 * needs the second to know what it must *not* touch.
 */
export function sweepFaction(state, deps, perception, factionId) {
  const engine = deps.engine;
  const unitIds = engine.unitIds(state);
  const observers = [];
  const subjects = [];

  for (const unitId of unitIds) {
    const unit = engine.unit(state, unitId);
    if (!unit || !unit.alive) continue;
    if (unit.teamId === factionId) {
      // A faction always knows its own people; they need no record and they
      // are not subjects of their own sweep.
      if (unit.actionable !== false) observers.push(unitId);
      continue;
    }
    subjects.push(unitId);
  }

  const best = {};
  const observed = new Set();
  if (!observers.length || !subjects.length) return { best, observed };

  for (const subjectId of subjects) {
    for (const observerId of observers) {
      const observation = observeUnit(state, deps, perception, observerId, subjectId);
      if (!observation) continue;
      const current = best[subjectId];
      if (!current || rankOf(observation.state) > rankOf(current.state)) {
        best[subjectId] = observation;
      }
      observed.add(subjectId);
      if (best[subjectId].state === "acquired") break;
    }
  }

  return { best, observed };
}

/** Factions that can hold knowledge: every team with at least one unit. */
export function observingFactions(state, deps) {
  const engine = deps.engine;
  const seen = [];
  for (const unitId of engine.unitIds(state)) {
    const unit = engine.unit(state, unitId);
    if (!unit) continue;
    if (!seen.includes(unit.teamId)) seen.push(unit.teamId);
  }
  return seen.sort();
}
