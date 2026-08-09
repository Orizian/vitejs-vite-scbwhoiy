/* =========================================================================
 * THE BELIEVED WORLD
 *
 * The only interface AI decision-making is permitted to use when it asks
 * "where is that unit?".
 *
 * Everything above this line reads `state.units[id].x`. Everything below it
 * reads a faction's knowledge record. The split is the entire point: an AI
 * that calls `believedPositionOf` cannot cheat, because the true coordinate is
 * not reachable from what it is handed.
 *
 * Scope of the gate: knowledge is required for units the acting faction is
 * *hostile* toward. Own-team, allied and neutral units are treated as known —
 * a medic knowing where the friendly civilians are is not an exploit, and
 * hostility is the relationship the acceptance criterion is about. A neutral
 * that turns hostile is gated from that moment, using the record the sweep has
 * been keeping all along.
 * =======================================================================*/

import { knowledgeOf, believedPosition } from "./knowledge.js";
import { rankOf } from "./channels.js";

function perceptionOf(state) {
  const perception = state && state.perception;
  if (!perception || !perception.enabled) return null;
  return perception;
}

/**
 * True when knowledge gating applies to this pair at all.
 *
 * Deliberately narrow so the answer to "why can this AI see that unit?" is
 * always one of two short reasons: it is not hostile, or the faction knows it.
 */
export function isGated(state, deps, actorTeamId, subjectId) {
  if (!perceptionOf(state)) return false;
  return deps.engine.teamRelationship(state, actorTeamId, subjectId) === "hostile";
}

/**
 * The position `actorTeamId` may act on for `subjectId`, or null.
 *
 * `requireExact` is what separates shooting from searching: a firing solution
 * needs an ACQUIRED contact, while movement and threat avoidance may use a
 * SUSPECTED last-known tile.
 */
export function believedPositionOf(state, deps, actorTeamId, subjectId, options) {
  const engine = deps.engine;
  const subject = engine.unit(state, subjectId);
  if (!subject) return null;

  if (!isGated(state, deps, actorTeamId, subjectId)) {
    return { x: subject.x, y: subject.y, accuracy: "exact", state: "acquired", known: true };
  }

  const perception = perceptionOf(state);
  const position = believedPosition(perception, actorTeamId, subjectId);
  if (!position) return null;
  const minimum = (options && options.minimumState) || "suspected";
  if (rankOf(position.state) < rankOf(minimum)) return null;
  return { ...position, known: position.state === "acquired" };
}

/** Can this faction legitimately take an action against this unit right now? */
export function canActOn(state, deps, actorTeamId, subjectId) {
  if (!isGated(state, deps, actorTeamId, subjectId)) return true;
  const perception = perceptionOf(state);
  const record = knowledgeOf(perception, actorTeamId, subjectId);
  return !!record && record.state === "acquired";
}

/**
 * Every unit the acting faction may reason about, with the position it is
 * entitled to use.
 *
 * Returns entries, not unit objects, precisely so a caller cannot reach
 * through to the real coordinates by accident.
 *
 * @returns {{unitId:string,x:number,y:number,state:string,accuracy:string,
 *            teamId:string,alive:boolean,targetable:boolean}[]}
 */
export function perceivedUnits(state, deps, actorTeamId, options) {
  const engine = deps.engine;
  const includeSuspected = !(options && options.includeSuspected === false);
  const out = [];

  for (const unitId of engine.unitIds(state)) {
    const unit = engine.unit(state, unitId);
    if (!unit) continue;
    if (!unit.alive && !(options && options.includeDefeated)) continue;

    if (!isGated(state, deps, actorTeamId, unitId)) {
      out.push({
        unitId,
        x: unit.x,
        y: unit.y,
        state: "acquired",
        accuracy: "exact",
        teamId: unit.teamId,
        alive: unit.alive,
        targetable: true
      });
      continue;
    }

    const position = believedPositionOf(state, deps, actorTeamId, unitId);
    if (!position) continue;
    if (position.state === "suspected" && !includeSuspected) continue;
    out.push({
      unitId,
      x: position.x,
      y: position.y,
      state: position.state,
      accuracy: position.accuracy,
      teamId: unit.teamId,
      alive: unit.alive,
      targetable: position.state === "acquired"
    });
  }
  return out;
}

/**
 * Hostiles the acting faction is aware of, believed positions only.
 *
 * `threat` weights an unconfirmed contact lower than a live one: a searching
 * unit should respect a last-known position without treating it as gospel.
 */
export function perceivedThreats(state, deps, actorTeamId) {
  const out = [];
  for (const entry of perceivedUnits(state, deps, actorTeamId)) {
    if (deps.engine.teamRelationship(state, actorTeamId, entry.unitId) !== "hostile") continue;
    out.push({ ...entry, threat: entry.state === "acquired" ? 1 : 0.5 });
  }
  return out;
}
