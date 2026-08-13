/* =========================================================================
 * MISSION REGISTRY
 *
 * Collects every mission file that should exist in this build and compiles it
 * into engine-shaped map / encounter / story-script entries.
 *
 * Two sources, in this order:
 *
 *   1. src/content/missions/*.json — checked in, shipped, part of the game.
 *   2. The playtest slot in sessionStorage — written by the editor's
 *      "Playtest" button. Lets you go from painting a tile to standing on it
 *      without a rebuild, and disappears when the tab closes.
 *
 * This module runs at import time, before App.jsx builds its frozen CONTENT
 * registry, which is the only window in which new maps can be added today.
 * See docs/ENGINE_ANALYSIS.md finding E-02 for why that restriction exists
 * and what removing it would buy.
 * =======================================================================*/

import { compileMission, normalizeMission, validateMission } from "./mission-format.js";
import { allSceneIds } from "./scene-registry.js";

export const PLAYTEST_STORAGE_KEY = "statuszero.playtest.mission";

const files = import.meta.glob("./missions/*.json", { eager: true });

/* localStorage rather than sessionStorage: the editor opens the game in a new
 * tab, and sessionStorage does not reliably survive that hop. The slot is
 * cleared explicitly by the in-game "Exit playtest" button. */
function readPlaytestMission() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(PLAYTEST_STORAGE_KEY);
    if (!raw) return null;
    return normalizeMission(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writePlaytestMission(mission) {
  if (typeof localStorage === "undefined") return false;
  localStorage.setItem(PLAYTEST_STORAGE_KEY, JSON.stringify(mission));
  return true;
}

function collect() {
  const maps = {};
  const encounters = {};
  const scripts = {};
  const scriptsByEncounter = {};
  const missions = {};
  const errors = [];
  const warnings = [];
  let playtestEncounterId = null;
  let playtestMissionId = null;

  const add = (raw, origin, options) => {
    const replaceExisting = !!(options && options.replaceExisting);
    let mission;
    try {
      mission = normalizeMission(raw);
    } catch (error) {
      errors.push(origin + ": could not be read (" + error.message + ")");
      return null;
    }

    // Scene ids are part of the vocabulary a mission may reference, so a
    // mission naming a scene that does not exist fails here rather than at
    // the moment a player would have watched it.
    const report = validateMission(mission, { sceneIds: allSceneIds() });
    for (const message of report.errors) errors.push(origin + ": " + message);
    for (const message of report.warnings) warnings.push(origin + ": " + message);
    if (!report.ok) return null;

    const compiled = compileMission(report.mission);
    if (encounters[compiled.encounterId]) {
      // Iterating on a mission that already ships is the common playtest case,
      // so the edited copy replaces the checked-in one instead of colliding.
      if (!replaceExisting) {
        errors.push(origin + ': duplicate mission id "' + compiled.missionId + '".');
        return null;
      }
      delete maps[compiled.mapId];
      delete encounters[compiled.encounterId];
      delete scripts[compiled.missionId];
      delete scriptsByEncounter[compiled.encounterId];
      delete missions[compiled.missionId];
    }
    maps[compiled.mapId] = compiled.map;
    encounters[compiled.encounterId] = compiled.encounter;
    scripts[compiled.missionId] = compiled.script;
    scriptsByEncounter[compiled.encounterId] = compiled.script;
    missions[compiled.missionId] = {
      missionId: compiled.missionId,
      encounterId: compiled.encounterId,
      mapId: compiled.mapId,
      name: compiled.encounter.name,
      origin,
      campaign: compiled.campaign,
      runtimeIdByRef: compiled.runtimeIdByRef,
      preMissionScene: compiled.mission.preMissionScene || null,
      postMissionScene: compiled.mission.postMissionScene || null,
      // What clearing this operation is worth, and which placements are worth
      // something of their own. A projection rather than the whole mission:
      // the reward layer needs exactly these two answers and nothing else
      // about the map, the script or the terrain.
      rewards: compiled.mission.rewards || { clear: null, firstClear: null },
      dropTableByRef: Object.fromEntries(
        (compiled.mission.units || [])
          .filter((unit) => unit.dropTableId)
          .map((unit) => [unit.ref, unit.dropTableId])
      )
    };
    return compiled;
  };

  for (const path of Object.keys(files).sort()) {
    const module = files[path];
    add(module && module.default ? module.default : module, path);
  }

  const playtest = readPlaytestMission();
  if (playtest) {
    const compiled = add(playtest, "playtest slot", { replaceExisting: true });
    if (compiled) {
      playtestEncounterId = compiled.encounterId;
      playtestMissionId = compiled.missionId;
    }
  }

  return {
    maps,
    encounters,
    scripts,
    scriptsByEncounter,
    missions,
    errors,
    warnings,
    playtestEncounterId,
    playtestMissionId
  };
}

export const MISSION_CONTENT = collect();

/** Story script for a file-authored mission, or null. App.jsx's storyScript()
 *  consults this before falling back to the built-in CAMPAIGN.dialogue table. */
export function missionFileScript(missionId) {
  return MISSION_CONTENT.scripts[missionId] || null;
}

export function clearPlaytestMission() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PLAYTEST_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
