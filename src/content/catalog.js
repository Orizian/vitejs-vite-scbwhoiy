/* =========================================================================
 * SHARED CONTENT CATALOG
 *
 * The content vocabulary the mission format is allowed to reference. Both the
 * game and the standalone editor import this file, so the editor never has to
 * load App.jsx to know what a "rifleGrunt" is.
 *
 * This used to be a hand-maintained mirror of the literals inside App.jsx,
 * kept honest by `catalogDriftIssues()`. It no longer is: everything a Studio
 * author can create is now DERIVED from `src/content/gameplay/*.json`, the
 * same files the game loads. Adding a unit in the Gameplay Data Studio makes
 * it placeable in the mission editor with no second edit, which is the whole
 * point of having one source of truth.
 *
 * What remains hand-written here is what is not authored gameplay data yet:
 * terrain (still a literal in App.jsx), and the editor's own presentation
 * vocabulary — paint swatches, map characters, speakers, backgrounds. Those
 * are listed as remaining debt in docs/GAMEPLAY_DATA.md.
 * =======================================================================*/

import { GAMEPLAY_CONTENT } from "./gameplay/registry.js";

/**
 * Terrain palette, derived from the authored terrain file.
 *
 * `char` is the character the exported map uses for this tile and `paint` is
 * the editor swatch — both authored beside the rules, so a new terrain type
 * created in the Studio is immediately paintable here and looks the same in
 * the game. `movementCost` is `null` in the file for an impassable tile
 * (JSON has no Infinity) and is restored to Infinity for the editor's own
 * arithmetic, exactly as the engine does.
 */
export const TERRAIN_CATALOG = Object.keys(GAMEPLAY_CONTENT.terrain)
  .sort()
  .map((id) => {
    const entry = GAMEPLAY_CONTENT.terrain[id];
    return {
      id,
      name: entry.name || id,
      char: entry.char || id.charAt(0),
      paint: entry.paint || "#1e293b",
      walkable: entry.walkable !== false,
      movementCost: entry.movementCost == null ? Infinity : entry.movementCost,
      blocksLineOfSight: !!entry.blocksLineOfSight
    };
  });

export const TERRAIN_IDS = TERRAIN_CATALOG.map((entry) => entry.id);

/** Default legend written into every exported map. Keeps hand-editing a
 *  mission file in a text editor readable. */
export const DEFAULT_LEGEND = Object.fromEntries(
  TERRAIN_CATALOG.map((entry) => [entry.char, entry.id])
);

export function terrainByChar(char) {
  return TERRAIN_CATALOG.find((entry) => entry.char === char) || null;
}

export function terrainById(id) {
  return TERRAIN_CATALOG.find((entry) => entry.id === id) || null;
}

/**
 * Unit chassis available for placement, derived from the authored units file.
 *
 * `deployable` in a unit's tags marks the chassis the campaign roster can fly —
 * those slots get overwritten by the player's actual loadout at deploy time, so
 * in the editor they are placeholders that define *where* the squad starts,
 * not who.
 */
export const UNIT_CATALOG = Object.keys(GAMEPLAY_CONTENT.units)
  .sort()
  .map((id) => {
    const unit = GAMEPLAY_CONTENT.units[id];
    return {
      id,
      name: unit.name || id,
      glyph: unit.glyph || "?",
      aiProfile: unit.aiProfile || null,
      tags: unit.tags || []
    };
  });

export const UNIT_IDS = UNIT_CATALOG.map((entry) => entry.id);

export function unitById(id) {
  return UNIT_CATALOG.find((entry) => entry.id === id) || null;
}

export const AI_PROFILE_IDS = Object.keys(GAMEPLAY_CONTENT.aiProfiles).sort();

/** Abilities and statuses a mission script may name (scripted attacks, repairs
 *  and applyStatus). */
export const ABILITY_IDS = Object.keys(GAMEPLAY_CONTENT.abilities).sort();

export const STATUS_IDS = Object.keys(GAMEPLAY_CONTENT.statuses).sort();

/** Loadout parts a mission may bolt onto a unit, and the slots they go in.
 *  The slot list is engine configuration (GAME_CONFIG.equipment.slots) and is
 *  the one thing here an author cannot add to from the Studio. */
export const EQUIPMENT_SLOTS = ["primaryWeapon", "armor", "utilitySystem", "coreSystem"];

export const EQUIPMENT_IDS = Object.keys(GAMEPLAY_CONTENT.equipment).sort();

export const FACINGS = ["northeast", "southeast", "southwest", "northwest"];

/** Team presets. The engine treats `teamId` as the whole hostility model
 *  today (see finding R-04); these three cover everything currently
 *  authorable. `neutral` exists so mission files can already be written
 *  against a faction matrix once FAC-01 lands. */
export const TEAM_PRESETS = [
  { id: "player", name: "Status:Zero", controller: "human", marker: "▲", accent: "emerald" },
  { id: "foe", name: "Hostiles", controller: "ai", marker: "■", accent: "rose" },
  { id: "neutral", name: "Neutral", controller: "ai", marker: "●", accent: "amber" }
];

export const SPEAKER_CATALOG = [
  { id: "commander", name: "Commander Vale", glyph: "🧑‍🚀" },
  { id: "reyes", name: "Reyes", glyph: "👩‍🚀" },
  { id: "kell", name: "Kell", glyph: "🧔‍♂️" },
  { id: "nyx", name: "Nyx", glyph: "🥷" },
  { id: "chancellor", name: "Chancellor Aldric", glyph: "🤵" },
  { id: "ferris", name: "Quartermaster Ferris", glyph: "🧑‍🔧" },
  { id: "saldana", name: "Doctor Saldaña", glyph: "🧑‍⚕️" },
  { id: "broadcast", name: "State Broadcast", glyph: "📡" },
  { id: "narrator", name: "Narration", glyph: "▣" },
  { id: "civilian", name: "Civilian", glyph: "🧑‍🌾" },
  { id: "government", name: "Government Command", glyph: "◆" }
];

export const SPEAKER_IDS = SPEAKER_CATALOG.map((entry) => entry.id);

export function speakerById(id) {
  return SPEAKER_CATALOG.find((entry) => entry.id === id) || null;
}

export const SCENE_KINDS = ["briefing", "dialogue", "propaganda", "aftermath", "interlude"];

/* ---------------------------------------------------------------
 * SCENE VOCABULARY
 *
 * Portrait states and backgrounds an authored scene may name. Both are
 * convention-based rather than files that must exist: the asset layer renders
 * a readable placeholder for anything missing, so writing can run ahead of
 * art. The editor offers these as a dropdown and still accepts a new id typed
 * by hand — validation warns rather than blocks, because "this art does not
 * exist yet" is a normal state for a scene in progress.
 * -------------------------------------------------------------*/

export const EXPRESSION_CATALOG = [
  { id: "neutral", label: "Neutral" },
  { id: "concerned", label: "Concerned" },
  { id: "resolute", label: "Resolute" },
  { id: "angry", label: "Angry" },
  { id: "shaken", label: "Shaken" },
  { id: "wry", label: "Wry" },
  { id: "exhausted", label: "Exhausted" }
];

export const EXPRESSION_IDS = EXPRESSION_CATALOG.map((entry) => entry.id);

export const BACKGROUND_CATALOG = [
  { id: "resistance-base", label: "Resistance Base" },
  { id: "quarry-hangar", label: "Quarry Hangar" },
  { id: "warner-road", label: "Warner Road" },
  { id: "warner-collapse", label: "Warner Collapse" },
  { id: "bellview-pump-station", label: "Bellview Pump Station" },
  { id: "hollowmere-perimeter", label: "Hollowmere Perimeter" },
  { id: "grayfield-yard", label: "Grayfield Yard" },
  { id: "command-room", label: "Government Command Room" },
  { id: "hale-office", label: "Hale's Office" },
  { id: "broadcast-studio", label: "State Broadcast Studio" },
  { id: "night-approach", label: "Night Approach" }
];

export const BACKGROUND_IDS = BACKGROUND_CATALOG.map((entry) => entry.id);

/** Music contexts a scene may request. Mirrors App.jsx's context table. */
export const MUSIC_CONTEXT_IDS = [
  "base",
  "missions",
  "briefing",
  "deployment",
  "battle",
  "results",
  "ending"
];

/** Objective types the engine can actually resolve today. Anything not on
 *  this list is a validation error, not a silent no-op. */
export const OBJECTIVE_TYPES = [
  {
    id: "defeatAllEnemies",
    name: "Defeat all enemies",
    params: [],
    summary: "Wins when the opposing team is wiped out."
  },
  {
    id: "destroyTargets",
    name: "Destroy specific targets",
    params: ["unitRefs"],
    summary: "Wins when every listed unit is destroyed. Losing your team loses."
  },
  {
    id: "protectUnits",
    name: "Protect units",
    params: ["unitRefs"],
    summary: "Fails the instant a protected unit dies; wins on elimination."
  },
  {
    id: "reachExtraction",
    name: "Reach extraction",
    params: ["regionRef", "unitRefs"],
    summary: "Wins when any listed unit stands on an extraction tile. Elimination also wins."
  },
  {
    id: "surviveActivations",
    name: "Survive N activations",
    params: ["activations", "unitRefs"],
    summary: "Wins at the activation count. Optional units must stay alive."
  },
  {
    id: "holdPosition",
    name: "Hold position",
    params: ["regionRef", "activations"],
    summary: "At the activation count, you must be standing in the region."
  },
  {
    id: "phasedObjective",
    name: "Phased objective",
    params: ["phases"],
    summary: "Runs a list of the above in sequence. The only multi-stage objective the engine supports."
  }
];

export const OBJECTIVE_TYPE_IDS = OBJECTIVE_TYPES.map((entry) => entry.id);
export const PHASE_OBJECTIVE_TYPE_IDS = OBJECTIVE_TYPE_IDS.filter((id) => id !== "phasedObjective");

export function objectiveTypeById(id) {
  return OBJECTIVE_TYPES.find((entry) => entry.id === id) || null;
}

/**
 * Mid-battle trigger vocabulary.
 *
 * `supported: true`  — evaluateMidBattleTriggers() in App.jsx handles it today.
 * `supported: false` — named in the GDD (§5.2) but NOT implemented. The editor
 *                      lets you author it and flags it, so writers can see the
 *                      engine backlog from inside the tool instead of
 *                      discovering it when the trigger silently never fires.
 */
export const TRIGGER_TYPES = [
  { id: "battleStarted", name: "Battle started", supported: true, fields: [] },
  { id: "activationCountReached", name: "After N activations", supported: true, fields: ["count"] },
  { id: "firstEnemyDefeated", name: "First enemy defeated", supported: true, fields: [] },
  { id: "halfEnemiesRemaining", name: "Half the enemies remain", supported: true, fields: [] },
  { id: "enemyCountThreshold", name: "Enemies remaining at most N", supported: true, fields: ["remainingAtMost"] },
  { id: "unitEnteredZone", name: "Unit entered region", supported: true, fields: ["regionRef", "teamId"] },
  { id: "unitOfTagSpotted", name: "Unit type present", supported: true, fields: ["definitionIds", "tag", "teamId", "afterActivations"] },
  { id: "eliteUnitSpotted", name: "Elite spotted", supported: true, fields: ["teamId"] },
  { id: "specificObjectiveTargetDamaged", name: "Target damaged", supported: true, fields: ["unitRefs", "occurrence"] },
  { id: "specificObjectiveTargetDestroyed", name: "Target destroyed", supported: true, fields: ["unitRefs", "occurrence"] },
  { id: "objectiveProgressReached", name: "Objective progress", supported: true, fields: ["unitRefs", "destroyed", "percent"] },
  { id: "objectivePhaseChanged", name: "Objective phase changed", supported: true, fields: ["toId"] },
  { id: "extractionActivated", name: "Extraction phase opened", supported: true, fields: [] },
  { id: "extractionReached", name: "Extraction reached", supported: true, fields: ["regionRef", "teamId"] },
  { id: "alliedUnitHpBelowPercent", name: "Ally HP below %", supported: true, fields: ["unitRefs", "percent"] },
  { id: "protectedUnitHpBelowPercent", name: "Protected unit HP below %", supported: true, fields: ["unitRefs", "percent"] },
  { id: "civilianAttacked", name: "Civilian attacked", supported: true, fields: ["teamId"] },
  { id: "civilianDamaged", name: "Civilian damaged", supported: true, fields: ["teamId"] },
  { id: "civilianDestroyed", name: "Civilian destroyed", supported: true, fields: ["teamId"] },
  { id: "civilianSpotted", name: "Civilian spotted", supported: true, fields: [] },
  { id: "abilityUsed", name: "Ability used", supported: true, fields: ["abilityId", "teamId"] },
  { id: "statusApplied", name: "Status applied", supported: true, fields: ["statusId"] },
  { id: "statusRemoved", name: "Status removed", supported: true, fields: ["statusId"] },
  { id: "reinforcementSpawned", name: "Reinforcement spawned", supported: true, fields: [] },
  { id: "battleVictoryConditionMet", name: "Victory condition met", supported: true, fields: ["teamId"] },
  { id: "crossedHalfway", name: "Squad crossed halfway", supported: true, fields: [] },

  // GDD §5.2 vocabulary the engine does not implement yet.
  { id: "phaseStarted", name: "Phase started", supported: false, fields: ["phaseId"] },
  { id: "phaseCompleted", name: "Phase completed", supported: false, fields: ["phaseId"] },
  { id: "timelineTime", name: "Timeline time reached", supported: false, fields: ["time"] },
  { id: "unitLeftRegion", name: "Unit left region", supported: false, fields: ["regionRef", "teamId"] },
  { id: "unitSpotted", name: "Unit spotted (real LOS)", supported: false, fields: ["unitRefs"] },
  { id: "contactStateChanged", name: "Contact state changed", supported: false, fields: ["unitRefs", "to"] },
  { id: "unitSurrendered", name: "Unit surrendered", supported: false, fields: ["unitRefs"] },
  { id: "unitDisabled", name: "Unit disabled (not killed)", supported: false, fields: ["unitRefs"] },
  { id: "objectiveFailed", name: "Objective failed", supported: false, fields: ["objectiveId"] },
  { id: "groupAlerted", name: "Group alerted", supported: false, fields: ["group"] },
  { id: "resourceBelow", name: "Resource below", supported: false, fields: ["unitRefs", "resourceId", "value"] },
  { id: "resourceAbove", name: "Resource above", supported: false, fields: ["unitRefs", "resourceId", "value"] },
  { id: "terrainDestroyed", name: "Terrain destroyed", supported: false, fields: ["regionRef"] },
  { id: "interactableUsed", name: "Interactable used", supported: false, fields: ["interactableId"] },
  { id: "wreckCreated", name: "Wreck created", supported: false, fields: ["regionRef"] },
  { id: "campaignFlag", name: "Campaign flag set", supported: false, fields: ["flag"] }
];

export const SUPPORTED_TRIGGER_IDS = TRIGGER_TYPES.filter((entry) => entry.supported).map((entry) => entry.id);

export function triggerTypeById(id) {
  return TRIGGER_TYPES.find((entry) => entry.id === id) || null;
}

/**
 * Phase action vocabulary (GDD §5.3).
 *
 * NOTHING here is supported yet — the engine's mid-battle layer can queue
 * dialogue and nothing else (finding R-01). The editor still lets you author
 * actions so that Grayfield and Warner Collapse can be *written* while the
 * engine work happens, and so the backlog is visible in the tool.
 */
export const PHASE_ACTION_TYPES = [
  { id: "cinematic", name: "Play cinematic scene", supported: false, fields: ["sceneRef"] },
  { id: "queueBark", name: "Queue non-blocking bark", supported: false, fields: ["speaker", "text"] },
  { id: "spawnGroup", name: "Spawn unit group", supported: false, fields: ["group", "regionRef"] },
  { id: "activateGroup", name: "Wake dormant group", supported: false, fields: ["group"] },
  { id: "despawnGroup", name: "Remove group", supported: false, fields: ["group"] },
  { id: "changeFaction", name: "Change faction / hostility", supported: false, fields: ["unitRefs", "toTeamId"] },
  { id: "replaceObjectives", name: "Replace objectives", supported: false, fields: ["objectiveIds"] },
  { id: "addObjective", name: "Add objective", supported: false, fields: ["objectiveId"] },
  { id: "failObjective", name: "Fail objective", supported: false, fields: ["objectiveId"] },
  { id: "scriptedAttack", name: "Scripted attack", supported: false, fields: ["sourceRef", "targetRef", "abilityId"] },
  { id: "scriptedRepair", name: "Scripted repair", supported: false, fields: ["sourceRef", "targetRef", "amount"] },
  { id: "forceMove", name: "Force reposition", supported: false, fields: ["unitRefs", "regionRef"] },
  { id: "applyStatus", name: "Apply status", supported: false, fields: ["unitRefs", "statusId"] },
  { id: "setTerrain", name: "Replace terrain", supported: false, fields: ["regionRef", "terrainId"] },
  { id: "setAiProfile", name: "Change AI profile", supported: false, fields: ["unitRefs", "aiProfile"] },
  { id: "enableLink", name: "Enable relationship link", supported: false, fields: ["linkId"] },
  { id: "setMissionFact", name: "Set mission fact / flag", supported: false, fields: ["flag"] },
  { id: "focusCamera", name: "Focus camera", supported: false, fields: ["regionRef", "unitRefs"] },
  { id: "setMusic", name: "Change music", supported: false, fields: ["track"] }
];

export function phaseActionTypeById(id) {
  return PHASE_ACTION_TYPES.find((entry) => entry.id === id) || null;
}

/** Map scale bands from the GDD §3 table, used by the editor to warn when a
 *  map is far outside the size its mission format claims. */
export const MAP_SCALES = [
  { id: "S", name: "S — Compact", width: 26, height: 32, players: "3–5", enemies: "10–16", minutes: "20–35" },
  { id: "M", name: "M — Standard", width: 36, height: 48, players: "4–7", enemies: "16–28", minutes: "35–60" },
  { id: "L", name: "L — Large", width: 48, height: 64, players: "6–9", enemies: "24–40", minutes: "55–90" },
  { id: "XL", name: "XL — Set piece", width: 64, height: 80, players: "8–11", enemies: "40–70", minutes: "90–150" }
];

export function mapScaleById(id) {
  return MAP_SCALES.find((entry) => entry.id === id) || null;
}
