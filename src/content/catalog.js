/* =========================================================================
 * SHARED CONTENT CATALOG
 *
 * A thin, dependency-free description of the content vocabulary the mission
 * format is allowed to reference. Both the game and the standalone editor
 * import this file, so the editor never has to load the 29k-line App.jsx to
 * know what a "rifleGrunt" is.
 *
 * This file is a MIRROR of the real definitions inside App.jsx. It is kept
 * honest by `catalogDriftIssues()` (see mission-format.js), which the game's
 * own test suite runs against the live CONTENT registry — if someone adds a
 * unit or terrain and forgets this file, the test suite fails.
 *
 * When App.jsx is eventually split into modules (see docs/ENGINE_ANALYSIS.md,
 * finding E-01) this file should be deleted and the real registries imported
 * directly.
 * =======================================================================*/

/** Terrain palette. `paint` is the editor swatch colour, matching the
 *  engine's own fallback colours so the editor looks like the game. */
export const TERRAIN_CATALOG = [
  {
    id: "plain",
    name: "Open Ground",
    char: ".",
    paint: "#1e293b",
    walkable: true,
    movementCost: 1,
    blocksLineOfSight: false
  },
  {
    id: "rough",
    name: "Rubble",
    char: "~",
    paint: "#334155",
    walkable: true,
    movementCost: 2,
    blocksLineOfSight: false
  },
  {
    id: "wall",
    name: "Wall",
    char: "#",
    paint: "#475569",
    walkable: false,
    movementCost: Infinity,
    blocksLineOfSight: true
  },
  {
    id: "burningGround",
    name: "Burning Ground",
    char: "!",
    paint: "#7c2d12",
    walkable: true,
    movementCost: 2,
    blocksLineOfSight: false
  }
];

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

/** Unit chassis available for placement. `deployable` marks the chassis the
 *  campaign roster can fly — those slots get overwritten by the player's
 *  actual loadout at deploy time, so in the editor they are placeholders
 *  that define *where* the squad starts, not who. */
export const UNIT_CATALOG = [
  { id: "assaultMech", name: "Assault Mech", glyph: "A", aiProfile: "aggressive", tags: ["mech", "deployable"] },
  { id: "supportMech", name: "Support Mech", glyph: "R", aiProfile: "support", tags: ["mech", "deployable"] },
  { id: "sniperMech", name: "Sniper Mech", glyph: "P", aiProfile: "cautious", tags: ["mech", "deployable"] },
  { id: "stealthMech", name: "Stealth Mech", glyph: "S", aiProfile: "aggressive", tags: ["mech", "deployable"] },
  { id: "rifleGrunt", name: "Rifle Grunt", glyph: "g", aiProfile: "aggressive", tags: ["mech", "government"] },
  { id: "lightPursuit", name: "Light Pursuit Mech", glyph: "p", aiProfile: "aggressive", tags: ["mech", "government"] },
  { id: "heavyEnforcer", name: "Heavy Enforcer", glyph: "E", aiProfile: "aggressive", tags: ["mech", "government"] },
  { id: "missileCarrier", name: "Missile Carrier", glyph: "M", aiProfile: "cautious", tags: ["mech", "government"] },
  { id: "securityTurret", name: "Security Turret", glyph: "T", aiProfile: "cautious", tags: ["mech", "government", "emplacement"] },
  { id: "governmentDrone", name: "Repair Drone", glyph: "d", aiProfile: "support", tags: ["mech", "government"] },
  { id: "governmentCommander", name: "Government Commander", glyph: "C", aiProfile: "aggressive", tags: ["mech", "government", "elite"] },
  { id: "civilianTransport", name: "Civilian Transport", glyph: "c", aiProfile: "cautious", tags: ["civilian"] },
  { id: "supplyDepot", name: "Supply Container", glyph: "▪", aiProfile: "cautious", tags: ["structure"] },
  { id: "repairDroneMech", name: "Repair Drone (summon)", glyph: "d", aiProfile: "support", tags: ["mech", "drone", "summoned"] }
];

export const UNIT_IDS = UNIT_CATALOG.map((entry) => entry.id);

export function unitById(id) {
  return UNIT_CATALOG.find((entry) => entry.id === id) || null;
}

export const AI_PROFILE_IDS = ["aggressive", "cautious", "support"];

/** Abilities and statuses a mission script may name (scripted attacks, repairs
 *  and applyStatus). Mirrors App.jsx; `catalogDriftIssues()` keeps it honest. */
export const ABILITY_IDS = [
  "quickStrike", "heavyBlow", "basicHeal", "poisonDart", "delayStrike", "shieldAlly", "forcePush",
  "blink", "hasteAlly", "cleanseAlly", "raiseTestSkeleton", "execution", "tripleShot", "emberField",
  "lineBlast", "ringNova", "guardAura", "scatterShot", "coverAlly", "stabilize", "burstFire",
  "bladeStrike", "cloak", "tacticalWithdrawal", "arcWelder", "fieldRepair", "reinforce", "repairDrone",
  "handCannon", "precisionShot", "brace", "targetMark", "overwatch", "droneWeld", "holdPosition"
];

export const STATUS_IDS = [
  "poison", "haste", "slow", "surefooted", "cloaked", "braced", "marked", "reinforced",
  "systemsFault", "overwatching", "stun"
];

/** Loadout parts a mission may bolt onto a unit, and the slots they go in.
 *  Mirrors App.jsx; `catalogDriftIssues()` keeps it honest. */
export const EQUIPMENT_SLOTS = ["primaryWeapon", "armor", "utilitySystem", "coreSystem"];

export const EQUIPMENT_IDS = [
  "closeShotgun", "breacherShotgun", "autogun", "silencedSmg", "arcWelderRig", "pulseWelder",
  "longRifle", "railBarrel", "plateArmor", "reactiveArmor", "lightPlating", "targetingSuite",
  "thermalOptics", "signalScanner", "jumpJets", "repairKit", "standardCore", "overclockCore",
  "bulwarkCore"
];

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
