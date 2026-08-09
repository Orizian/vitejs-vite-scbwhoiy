/* =========================================================================
 * STATUS ZERO — MISSION FILE FORMAT
 *
 * One mission = one JSON file. The file owns its map, its unit placements,
 * its named regions, its objective, its story scenes and its mid-battle
 * triggers. Nothing about a mission lives in code.
 *
 * Three jobs live here, and both the game and the editor use all three:
 *
 *   normalizeMission()  fills defaults + migrates older files
 *   validateMission()   errors (won't load) and warnings (loads, but read them)
 *   compileMission()    mission file  ->  engine map + encounter + story script
 *
 * The compiler is what makes the format pleasant to author. In a mission file
 * you refer to things by name — unit "pumpGuardA", region "northYard". The
 * engine wants runtime ids ("u7") and raw tile arrays. The compiler does that
 * translation in one place so neither the editor nor the writer ever has to
 * think about it.
 * =======================================================================*/

import {
  TERRAIN_CATALOG,
  TERRAIN_IDS,
  DEFAULT_LEGEND,
  UNIT_IDS,
  ABILITY_IDS,
  STATUS_IDS,
  EQUIPMENT_IDS,
  EQUIPMENT_SLOTS,
  AI_PROFILE_IDS,
  FACINGS,
  SPEAKER_IDS,
  SCENE_KINDS,
  OBJECTIVE_TYPE_IDS,
  PHASE_OBJECTIVE_TYPE_IDS,
  objectiveTypeById,
  triggerTypeById,
  mapScaleById,
  terrainById
} from "./catalog.js";
import { validateAction } from "../mission/actions.js";
import { validateTrigger, validateCondition } from "../mission/conditions.js";
import { normalizeRelationship, RELATIONSHIPS } from "../mission/factions.js";
import { LINK_IDS } from "./reactions.js";
import { CHANNEL_IDS, KNOWLEDGE_STATES } from "../perception/channels.js";

export const FORMAT_ID = "statuszero.mission";
export const FORMAT_VERSION = 1;

/* ---------------------------------------------------------------
 * CONSTRUCTION
 * -------------------------------------------------------------*/

export function createEmptyMission(options) {
  const opts = options || {};
  const width = opts.width || 36;
  const height = opts.height || 48;
  const fill = opts.fillTerrainId || "plain";
  return normalizeMission({
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    id: opts.id || "untitled-mission",
    name: opts.name || "Untitled Mission",
    scale: opts.scale || "M",
    summary: "",
    map: {
      name: opts.name || "Untitled Map",
      width,
      height,
      terrain: makeGrid(width, height, fill),
      elevation: makeGrid(width, height, 0)
    },
    teams: null,
    units: [],
    regions: [],
    objective: { type: "defeatAllEnemies", text: "Defeat every hostile unit" },
    phases: [],
    scenes: {},
    sequences: { briefing: [], victory: [], defeat: [] },
    midBattle: []
  });
}

function makeGrid(width, height, value) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Array.from({ length: width }, () => value));
  }
  return rows;
}

/* ---------------------------------------------------------------
 * NORMALIZATION
 *
 * Accepts either the editor's native grid form (`terrain` as a 2D array of
 * terrain ids) or the compact row form the engine's MAPS table uses
 * (`rows` + `legend`), because hand-writing a small map as strings is nicer
 * than hand-writing a 2D array. Both round-trip.
 * -------------------------------------------------------------*/

export function normalizeMission(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const map = normalizeMap(source.map || {});

  const teams = Array.isArray(source.teams) && source.teams.length
    ? source.teams.map((team) => ({
        id: String(team.id),
        name: team.name || String(team.id),
        controller: team.controller === "human" ? "human" : "ai",
        marker: team.marker || "■",
        accent: team.accent || "rose"
      }))
    : [
        { id: "player", name: "Status:Zero", controller: "human", marker: "▲", accent: "emerald" },
        { id: "foe", name: "Hostiles", controller: "ai", marker: "■", accent: "rose" }
      ];

  const units = (Array.isArray(source.units) ? source.units : []).map((unit, index) =>
    normalizeUnit(unit, index)
  );

  const regions = (Array.isArray(source.regions) ? source.regions : []).map((region, index) =>
    normalizeRegion(region, index)
  );

  return {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    id: source.id || "untitled-mission",
    name: source.name || "Untitled Mission",
    scale: source.scale || inferScale(map.width, map.height),
    summary: source.summary || "",
    map,
    teams,
    units,
    regions,
    objective: normalizeObjective(source.objective),
    phases: Array.isArray(source.phases) ? source.phases.map(normalizePhase) : [],
    scenes: normalizeScenes(source.scenes),
    sequences: normalizeSequences(source.sequences),
    midBattle: (Array.isArray(source.midBattle) ? source.midBattle : []).map(normalizeMidBattle),
    campaign: source.campaign || null,

    /* ---- scripting layer ---- */
    factions: normalizeFactions(source.factions),
    // Units may name a group the author never declared; those become ordinary
    // field groups so `group` keeps working as a plain label.
    groups: withImplicitGroups(
      (Array.isArray(source.groups) ? source.groups : []).map(normalizeGroup),
      units
    ),
    objectives: (Array.isArray(source.objectives) ? source.objectives : []).map(normalizeObjectiveEntry),
    beats: (Array.isArray(source.beats) ? source.beats : []).map(normalizeBeat),
    startPhaseId: source.startPhaseId || null
  };
}

/* ---------------------------------------------------------------
 * SCRIPTING LAYER NORMALIZERS
 * -------------------------------------------------------------*/

function normalizeFactions(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    relationships: (Array.isArray(source.relationships) ? source.relationships : [])
      .map((entry) => ({
        a: entry.a,
        b: entry.b,
        relationship: normalizeRelationship(entry.relationship) || "hostile",
        symmetric: entry.symmetric !== false
      }))
      .filter((entry) => entry.a && entry.b)
  };
}

function withImplicitGroups(groups, units) {
  const declared = new Set(groups.map((group) => group.id));
  const out = groups.slice();
  for (const unit of units) {
    if (!unit.group || declared.has(unit.group)) continue;
    declared.add(unit.group);
    out.push({
      id: unit.group,
      name: unit.group,
      teamId: unit.teamId || null,
      startsActive: true,
      deployment: "field",
      implicit: true
    });
  }
  return out;
}

function normalizeGroup(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: source.id || "group" + (index + 1),
    name: source.name || source.id || "Group " + (index + 1),
    teamId: source.teamId || null,
    startsActive: source.startsActive !== false,
    // "field" units are placed at battle start; "reserve" units are held back
    // until a spawnGroup action puts them on the map.
    deployment: source.deployment === "reserve" ? "reserve" : "field"
  };
}

/** An entry in the mission's objective library. Objectives are declared once
 *  and then activated, completed, failed or replaced by script actions. */
function normalizeObjectiveEntry(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: source.id || "objective" + (index + 1),
    type: OBJECTIVE_TYPE_IDS.includes(source.type) ? source.type : "defeatAllEnemies",
    text: source.text || "",
    required: source.required !== false,
    hidden: source.hidden === true,
    startsActive: source.startsActive === true,
    teamId: source.teamId || "player",
    opposingTeamId: source.opposingTeamId || "foe",
    unitRefs: Array.isArray(source.unitRefs) ? source.unitRefs.slice() : [],
    regionRef: source.regionRef || null,
    activations: source.activations == null ? null : Number(source.activations),
    allowElimination: source.allowElimination !== false,
    phases: Array.isArray(source.phases) ? source.phases.map(normalizeObjectivePhase) : []
  };
}

function normalizeBeat(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: source.id || "beat" + (index + 1),
    name: source.name || "",
    trigger: normalizeTriggerSpec(source.trigger),
    when: source.when || null,
    phase: source.phase || null,
    once: source.once !== false,
    maxFires: source.maxFires == null ? null : Number(source.maxFires),
    priority: source.priority == null ? 50 : Number(source.priority),
    actions: (Array.isArray(source.actions) ? source.actions : []).map((action) => ({ ...action }))
  };
}

function normalizeTriggerSpec(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { trigger: raw };
  const spec = { ...raw };
  if (spec.type && !spec.trigger) {
    spec.trigger = spec.type;
    delete spec.type;
  }
  return spec.trigger ? spec : null;
}

function normalizeMap(raw) {
  const legend = raw.legend || DEFAULT_LEGEND;

  let terrain = null;
  if (Array.isArray(raw.terrain) && Array.isArray(raw.terrain[0])) {
    terrain = raw.terrain.map((row) => row.slice());
  } else if (Array.isArray(raw.rows)) {
    terrain = raw.rows.map((row) =>
      String(row).split("").map((char) => legend[char] || "plain")
    );
  }

  let elevation = null;
  if (Array.isArray(raw.elevation) && Array.isArray(raw.elevation[0])) {
    elevation = raw.elevation.map((row) => row.map((value) => Number(value) || 0));
  } else if (Array.isArray(raw.elevationRows)) {
    elevation = raw.elevationRows.map((row) =>
      String(row).split("").map((char) => {
        const value = parseInt(char, 36);
        return Number.isFinite(value) ? value : 0;
      })
    );
  }

  const height = raw.height || (terrain ? terrain.length : 8);
  const width = raw.width || (terrain && terrain[0] ? terrain[0].length : 8);

  if (!terrain) terrain = makeGrid(width, height, "plain");
  if (!elevation) elevation = makeGrid(width, height, 0);

  // Force both grids to the declared dimensions so a hand-edited file with a
  // short row can still be opened and repaired in the editor.
  terrain = conformGrid(terrain, width, height, "plain");
  elevation = conformGrid(elevation, width, height, 0);

  return {
    name: raw.name || "Untitled Map",
    width,
    height,
    terrain,
    elevation
  };
}

function conformGrid(grid, width, height, fill) {
  const out = [];
  for (let y = 0; y < height; y += 1) {
    const row = Array.isArray(grid[y]) ? grid[y] : [];
    const next = [];
    for (let x = 0; x < width; x += 1) {
      next.push(row[x] === undefined ? fill : row[x]);
    }
    out.push(next);
  }
  return out;
}

function normalizeUnit(raw, index) {
  return {
    ref: raw.ref || raw.id || "unit" + (index + 1),
    definitionId: raw.definitionId || "rifleGrunt",
    teamId: raw.teamId || "foe",
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    facing: FACINGS.includes(raw.facing) ? raw.facing : null,
    aiProfile: AI_PROFILE_IDS.includes(raw.aiProfile) ? raw.aiProfile : null,
    group: raw.group || null,
    // Per-unit loadout, keyed by slot. This is how a mission fields a garrison
    // with thermal optics rather than needing a bespoke chassis for it.
    equipment: raw.equipment && typeof raw.equipment === "object" ? { ...raw.equipment } : null,
    note: raw.note || ""
  };
}

function normalizeRegion(raw, index) {
  const region = {
    id: raw.id || "region" + (index + 1),
    name: raw.name || raw.id || "Region " + (index + 1),
    color: raw.color || "#38bdf8",
    kind: raw.kind || "generic",
    tiles: []
  };
  if (Array.isArray(raw.tiles) && raw.tiles.length) {
    region.tiles = raw.tiles.map((tile) => ({ x: Number(tile.x) || 0, y: Number(tile.y) || 0 }));
  } else if (raw.rect) {
    const { x = 0, y = 0, w = 1, h = 1 } = raw.rect;
    for (let ty = y; ty < y + h; ty += 1) {
      for (let tx = x; tx < x + w; tx += 1) region.tiles.push({ x: tx, y: ty });
    }
  }
  return region;
}

function normalizeObjective(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    type: OBJECTIVE_TYPE_IDS.includes(source.type) ? source.type : "defeatAllEnemies",
    text: source.text || "Complete the operation",
    teamId: source.teamId || "player",
    opposingTeamId: source.opposingTeamId || "foe",
    unitRefs: Array.isArray(source.unitRefs) ? source.unitRefs.slice() : [],
    regionRef: source.regionRef || null,
    activations: source.activations == null ? null : Number(source.activations),
    allowElimination: source.allowElimination !== false,
    phases: Array.isArray(source.phases) ? source.phases.map(normalizeObjectivePhase) : []
  };
}

function normalizeObjectivePhase(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: source.id || "phase" + (index + 1),
    type: PHASE_OBJECTIVE_TYPE_IDS.includes(source.type) ? source.type : "defeatAllEnemies",
    label: source.label || "",
    unitRefs: Array.isArray(source.unitRefs) ? source.unitRefs.slice() : [],
    regionRef: source.regionRef || null,
    activations: source.activations == null ? null : Number(source.activations),
    allowElimination: source.allowElimination === true
  };
}

/**
 * A runtime mission phase (GDD §2.2). Executed by src/mission/runtime.js.
 *
 * `enterWhen` is a trigger spec, a condition object, or both — `{ trigger,
 * when }`. On entry a phase declaratively replaces the active objectives and
 * wakes/sleeps groups, then runs its `onEnter` actions.
 */
function normalizePhase(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const enterWhen = source.enterWhen ? { ...source.enterWhen } : null;
  if (enterWhen && enterWhen.type && !enterWhen.trigger) {
    enterWhen.trigger = enterWhen.type;
    delete enterWhen.type;
  }

  // `actions` was the field name before phases were executable; keep reading it
  // so missions authored against the previous format still load.
  const legacyActions = Array.isArray(source.actions) ? source.actions : [];

  return {
    id: source.id || "phase" + (index + 1),
    name: source.name || source.id || "Phase " + (index + 1),
    enterWhen,
    next: source.next || null,
    objectives: Array.isArray(source.objectives)
      ? source.objectives.slice()
      : Array.isArray(source.objectiveIds)
      ? source.objectiveIds.slice()
      : [],
    activateGroups: Array.isArray(source.activateGroups)
      ? source.activateGroups.slice()
      : Array.isArray(source.activeGroups)
      ? source.activeGroups.slice()
      : [],
    deactivateGroups: Array.isArray(source.deactivateGroups) ? source.deactivateGroups.slice() : [],
    onEnter: (Array.isArray(source.onEnter) ? source.onEnter : legacyActions).map((a) => ({ ...a })),
    onExit: (Array.isArray(source.onExit) ? source.onExit : []).map((a) => ({ ...a })),
    music: source.music || null
  };
}

function normalizeScenes(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const sceneId of Object.keys(source)) {
    const scene = source[sceneId] || {};
    out[sceneId] = {
      title: scene.title || sceneId,
      location: scene.location || "",
      kind: SCENE_KINDS.includes(scene.kind) ? scene.kind : "dialogue",
      lines: (Array.isArray(scene.lines) ? scene.lines : []).map((line) => ({
        speaker: line.speaker || "narrator",
        text: line.text || ""
      })),
      choices: (Array.isArray(scene.choices) ? scene.choices : []).map((choice, index) => ({
        id: choice.id || sceneId + "Choice" + (index + 1),
        prompt: choice.prompt || "",
        // The option a headless run picks. Choices set facts, and facts change
        // authoritative outcomes, so this must never be random.
        defaultOptionId: choice.defaultOptionId || null,
        options: (Array.isArray(choice.options) ? choice.options : []).map((option, oIndex) => ({
          id: option.id || "option" + (oIndex + 1),
          text: option.text || "",
          flag: option.flag || "",
          // `fact` is the mission-local equivalent of `flag`; later triggers
          // read it through the missionFact condition.
          fact: option.fact || "",
          factValue: option.factValue === undefined ? true : option.factValue,
          detail: option.detail || ""
        }))
      }))
    };
  }
  return out;
}

function normalizeSequences(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const pick = (key) => (Array.isArray(source[key]) ? source[key].slice() : []);
  return {
    briefing: pick("briefing"),
    victory: pick("victory"),
    defeat: pick("defeat")
  };
}

function normalizeMidBattle(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const trigger = typeof source.trigger === "string" ? { type: source.trigger } : source.trigger || {};
  return {
    id: source.id || "beat" + (index + 1),
    trigger: { type: trigger.type || "battleStarted", ...trigger },
    speaker: source.speaker || "narrator",
    text: source.text || "",
    followUpLines: (Array.isArray(source.followUpLines) ? source.followUpLines : []).map((line) => ({
      speaker: line.speaker || "narrator",
      text: line.text || ""
    })),
    priority: source.priority == null ? 50 : Number(source.priority),
    pauseBattle: source.pauseBattle !== false,
    once: source.once !== false,
    when: source.when || null,
    actions: Array.isArray(source.actions) ? source.actions.map((a) => ({ ...a })) : []
  };
}

function inferScale(width, height) {
  const area = width * height;
  if (area <= 26 * 32 * 1.2) return "S";
  if (area <= 36 * 48 * 1.2) return "M";
  if (area <= 48 * 64 * 1.2) return "L";
  return "XL";
}

/* ---------------------------------------------------------------
 * VALIDATION
 *
 * Errors block loading. Warnings do not — but several of them are the
 * difference between "this mission works" and "this mission is unwinnable",
 * so the editor shows them just as loudly.
 * -------------------------------------------------------------*/

export function validateMission(mission, catalog) {
  const errors = [];
  const warnings = [];
  const m = normalizeMission(mission);
  const scriptRefs = buildScriptRefs(m, catalog);

  const push = (list, message) => list.push(message);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
    push(errors, 'Mission id "' + m.id + '" must be lowercase letters, numbers and hyphens.');
  }
  if (!m.name.trim()) push(errors, "Mission needs a name.");

  /* --- map --- */
  if (m.map.width < 4 || m.map.height < 4) {
    push(errors, "Map must be at least 4x4.");
  }
  if (m.map.width > 128 || m.map.height > 128) {
    push(errors, "Map larger than 128x128 is beyond the format's supported range.");
  }
  for (let y = 0; y < m.map.height; y += 1) {
    for (let x = 0; x < m.map.width; x += 1) {
      const id = m.map.terrain[y][x];
      if (!TERRAIN_IDS.includes(id)) {
        push(errors, "Tile " + x + "," + y + ' uses unknown terrain "' + id + '".');
      }
      const elevation = m.map.elevation[y][x];
      if (!Number.isInteger(elevation)) {
        push(errors, "Tile " + x + "," + y + " has a non-integer elevation.");
      } else if (elevation < 0) {
        push(errors, "Tile " + x + "," + y + " has a negative elevation; the engine forbids these.");
      }
    }
  }

  // Elevation legality: the engine's default maxClimb/maxDrop is 1, so a
  // 2-level step between orthogonal neighbours is an invisible wall.
  const cliffs = [];
  for (let y = 0; y < m.map.height; y += 1) {
    for (let x = 0; x < m.map.width; x += 1) {
      if (!isWalkableTerrain(m.map.terrain[y][x])) continue;
      const here = m.map.elevation[y][x];
      const neighbours = [[x + 1, y], [x, y + 1]];
      for (const [nx, ny] of neighbours) {
        if (nx >= m.map.width || ny >= m.map.height) continue;
        if (!isWalkableTerrain(m.map.terrain[ny][nx])) continue;
        if (Math.abs(m.map.elevation[ny][nx] - here) > 1) cliffs.push(x + "," + y + " → " + nx + "," + ny);
      }
    }
  }
  if (cliffs.length) {
    push(
      warnings,
      cliffs.length +
        " impassable elevation step(s) between walkable tiles (default climb/drop limit is 1). First: " +
        cliffs.slice(0, 3).join("; ") +
        ". These read as open ground but cannot be walked."
    );
  }

  const scale = mapScaleById(m.scale);
  if (scale) {
    const declared = scale.width * scale.height;
    const actual = m.map.width * m.map.height;
    if (actual < declared * 0.5 || actual > declared * 2) {
      push(
        warnings,
        "Map is " + m.map.width + "×" + m.map.height + " but declares scale " + m.scale +
          " (" + scale.width + "×" + scale.height + " target)."
      );
    }
  }

  /* --- teams --- */
  const teamIds = new Set(m.teams.map((team) => team.id));
  if (!teamIds.has(m.objective.teamId)) {
    push(errors, 'Objective player team "' + m.objective.teamId + '" is not one of the mission teams.');
  }
  if (!teamIds.has(m.objective.opposingTeamId)) {
    push(errors, 'Objective opposing team "' + m.objective.opposingTeamId + '" is not one of the mission teams.');
  }
  if (m.teams.filter((team) => team.controller === "human").length !== 1) {
    push(warnings, "Exactly one team should be human-controlled.");
  }

  /* --- units --- */
  const refs = new Set();
  const occupied = new Map();
  for (const unit of m.units) {
    const label = 'Unit "' + unit.ref + '"';
    if (refs.has(unit.ref)) push(errors, label + " has a duplicate ref.");
    refs.add(unit.ref);
    if (!UNIT_IDS.includes(unit.definitionId)) {
      push(errors, label + ' uses unknown chassis "' + unit.definitionId + '".');
    }
    if (!teamIds.has(unit.teamId)) {
      push(errors, label + ' is on unknown team "' + unit.teamId + '".');
    }
    for (const slot of Object.keys(unit.equipment || {})) {
      const equipmentId = unit.equipment[slot];
      if (!equipmentId) continue;
      if (!EQUIPMENT_SLOTS.includes(slot)) {
        push(errors, label + ' has equipment in unknown slot "' + slot + '".');
      } else if (!EQUIPMENT_IDS.includes(equipmentId)) {
        push(errors, label + ' equips unknown part "' + equipmentId + '".');
      }
    }
    if (unit.x < 0 || unit.y < 0 || unit.x >= m.map.width || unit.y >= m.map.height) {
      push(errors, label + " is placed outside the map.");
      continue;
    }
    if (!isWalkableTerrain(m.map.terrain[unit.y][unit.x])) {
      push(errors, label + " starts on an unwalkable tile (" + unit.x + "," + unit.y + ").");
    }
    const key = unit.x + "," + unit.y;
    if (occupied.has(key)) {
      push(errors, label + " shares tile " + key + " with \"" + occupied.get(key) + '".');
    } else {
      occupied.set(key, unit.ref);
    }
  }

  const playerUnits = m.units.filter((unit) => unit.teamId === m.objective.teamId);
  if (!playerUnits.length) {
    push(errors, "Mission has no starting positions for the player team.");
  }
  const enemyUnits = m.units.filter((unit) => unit.teamId !== m.objective.teamId);
  if (!enemyUnits.length && m.objective.type === "defeatAllEnemies") {
    push(errors, "Objective is 'defeat all enemies' but the mission has no enemies.");
  }
  if (enemyUnits.length > 25) {
    push(
      warnings,
      enemyUnits.length +
        " hostile units. Every unit thinks every activation today (finding R-06) — expect AI turn times to climb past ~25."
    );
  }

  /* --- regions --- */
  const regionIds = new Set();
  for (const region of m.regions) {
    if (regionIds.has(region.id)) push(errors, 'Duplicate region id "' + region.id + '".');
    regionIds.add(region.id);
    if (!region.tiles.length) push(warnings, 'Region "' + region.id + '" has no tiles.');
    for (const tile of region.tiles) {
      if (tile.x < 0 || tile.y < 0 || tile.x >= m.map.width || tile.y >= m.map.height) {
        push(errors, 'Region "' + region.id + '" contains a tile outside the map.');
        break;
      }
    }
    if (!isRectangular(region.tiles)) {
      push(
        warnings,
        'Region "' + region.id +
          '" is not rectangular. Objectives use its exact tiles, but the unitEnteredZone trigger only tests its bounding box.'
      );
    }
  }

  /* --- objective --- */
  validateObjectiveShape(m.objective, m, refs, regionIds, errors, warnings, "Objective");
  for (const phase of m.objective.phases) {
    validateObjectiveShape(phase, m, refs, regionIds, errors, warnings, 'Objective phase "' + phase.id + '"');
  }
  if (m.objective.type === "phasedObjective" && !m.objective.phases.length) {
    push(errors, "Phased objective has no phases.");
  }

  /* --- scenes and sequences --- */
  const sceneIds = new Set(Object.keys(m.scenes));
  for (const sceneId of sceneIds) {
    const scene = m.scenes[sceneId];
    if (!scene.lines.length) push(warnings, 'Scene "' + sceneId + '" has no lines.');
    scene.lines.forEach((line, index) => {
      if (!SPEAKER_IDS.includes(line.speaker)) {
        push(warnings, 'Scene "' + sceneId + '" line ' + (index + 1) + ' uses unknown speaker "' + line.speaker + '".');
      }
      if (!line.text.trim()) {
        push(warnings, 'Scene "' + sceneId + '" line ' + (index + 1) + " is empty.");
      }
    });
    for (const choice of scene.choices) {
      if (choice.options.length < 2) {
        push(warnings, 'Choice "' + choice.id + '" needs at least two options.');
      }
      for (const option of choice.options) {
        // An option is useful if it sets either a campaign flag (persists past
        // the mission) or a mission fact (readable by this mission's triggers).
        if (!option.flag && !option.fact) {
          push(warnings, 'Choice option "' + option.id + '" sets neither a campaign flag nor a mission fact, so nothing can react to it.');
        }
      }
    }
  }
  for (const key of ["briefing", "victory", "defeat"]) {
    for (const sceneId of m.sequences[key]) {
      if (!sceneIds.has(sceneId)) {
        push(errors, 'Sequence "' + key + '" references missing scene "' + sceneId + '".');
      }
    }
  }
  if (!m.sequences.briefing.length) push(warnings, "Mission has no briefing sequence.");
  if (!m.sequences.victory.length) push(warnings, "Mission has no victory sequence.");

  /* --- mid-battle beats --- */
  const beatIds = new Set();
  for (const beat of m.midBattle) {
    const label = 'Beat "' + beat.id + '"';
    if (beatIds.has(beat.id)) push(errors, label + " has a duplicate id.");
    beatIds.add(beat.id);
    const type = triggerTypeById(beat.trigger.type);
    if (!type) {
      push(errors, label + ' uses unknown trigger "' + beat.trigger.type + '".');
    } else if (!type.supported) {
      push(
        warnings,
        label + ' uses trigger "' + beat.trigger.type + '", which the engine does not implement yet — it will never fire.'
      );
    }
    if (beat.trigger.regionRef && !regionIds.has(beat.trigger.regionRef)) {
      push(errors, label + ' references missing region "' + beat.trigger.regionRef + '".');
    }
    for (const ref of beat.trigger.unitRefs || []) {
      if (!refs.has(ref)) push(errors, label + ' references missing unit "' + ref + '".');
    }
    if (!beat.text.trim() && !beat.actions.length) {
      push(warnings, label + " has no text and no actions.");
    }
    if (!SPEAKER_IDS.includes(beat.speaker)) {
      push(warnings, label + ' uses unknown speaker "' + beat.speaker + '".');
    }
    // Legacy `midBattle` beats may now carry real actions too, validated
    // against the same registry the runtime executes.
    for (let index = 0; index < beat.actions.length; index += 1) {
      for (const problem of validateAction(beat.actions[index], scriptRefs, label + " action " + (index + 1))) {
        push(errors, problem);
      }
    }
  }

  /* --- scripting layer --- */
  validateScriptLayer(m, scriptRefs, errors, warnings);

  /* --- legacy authored phase shell (pre-runtime missions) --- */
  return { errors, warnings, mission: m, ok: errors.length === 0 };
}

/* ---------------------------------------------------------------
 * SCRIPTING LAYER VALIDATION
 *
 * Everything here is validated against the same registries the runtime
 * executes, so the editor cannot let an author write a beat the engine will
 * silently ignore.
 * -------------------------------------------------------------*/

function buildScriptRefs(mission, catalog) {
  return {
    units: new Set(mission.units.map((unit) => unit.ref)),
    regions: new Set(mission.regions.map((region) => region.id)),
    objectives: new Set(mission.objectives.map((objective) => objective.id)),
    groups: new Set(mission.groups.map((group) => group.id)),
    phases: new Set(mission.phases.map((phase) => phase.id)),
    scenes: new Set(Object.keys(mission.scenes)),
    teams: new Set(mission.teams.map((team) => team.id)),
    terrains: new Set(TERRAIN_IDS),
    links: new Set((catalog && catalog.links) || LINK_IDS),
    channels: new Set(CHANNEL_IDS),
    knowledgeStates: new Set(KNOWLEDGE_STATES),
    abilities: new Set((catalog && catalog.abilities) || ABILITY_IDS),
    statuses: new Set((catalog && catalog.statuses) || STATUS_IDS)
  };
}

function validateScriptLayer(mission, refs, errors, warnings) {
  const push = (list, message) => list.push(message);

  /* factions */
  for (const entry of mission.factions.relationships) {
    if (!refs.teams.has(entry.a)) push(errors, 'Faction relationship references unknown team "' + entry.a + '".');
    if (!refs.teams.has(entry.b)) push(errors, 'Faction relationship references unknown team "' + entry.b + '".');
    if (!RELATIONSHIPS.includes(entry.relationship)) {
      push(errors, 'Faction relationship "' + entry.relationship + '" is not one of ' + RELATIONSHIPS.join(", ") + ".");
    }
  }

  /* groups */
  const groupIds = new Set();
  const usedGroups = new Set(mission.units.map((unit) => unit.group).filter(Boolean));
  for (const group of mission.groups) {
    if (groupIds.has(group.id)) push(errors, 'Duplicate group id "' + group.id + '".');
    groupIds.add(group.id);
    if (group.teamId && !refs.teams.has(group.teamId)) {
      push(errors, 'Group "' + group.id + '" references unknown team "' + group.teamId + '".');
    }
    if (!usedGroups.has(group.id)) {
      push(warnings, 'Group "' + group.id + '" has no units assigned to it.');
    }
  }

  /* objective library */
  const objectiveIds = new Set();
  for (const objective of mission.objectives) {
    const label = 'Objective "' + objective.id + '"';
    if (objectiveIds.has(objective.id)) push(errors, "Duplicate objective id " + objective.id + ".");
    objectiveIds.add(objective.id);
    if (!objective.text.trim()) push(warnings, label + " has no display text.");
    validateObjectiveShape(objective, mission, refs.units, refs.regions, errors, warnings, label);
    for (const phase of objective.phases) {
      validateObjectiveShape(phase, mission, refs.units, refs.regions, errors, warnings, label + ' phase "' + phase.id + '"');
    }
  }

  /* phases */
  const phaseIds = new Set();
  for (const phase of mission.phases) {
    const label = 'Phase "' + phase.id + '"';
    if (phaseIds.has(phase.id)) push(errors, "Duplicate phase id " + phase.id + ".");
    phaseIds.add(phase.id);

    if (phase.enterWhen) {
      if (phase.enterWhen.trigger) {
        for (const problem of validateTrigger(phase.enterWhen, refs, label + " enterWhen")) push(errors, problem);
      }
      if (phase.enterWhen.when) {
        for (const problem of validateCondition(phase.enterWhen.when, refs, label + " enterWhen.when")) push(errors, problem);
      }
      if (!phase.enterWhen.trigger && !phase.enterWhen.when) {
        push(errors, label + " has an enterWhen with neither a trigger nor a condition, so it can never be entered automatically.");
      }
    }
    if (phase.next && !refs.phases.has(phase.next)) {
      push(errors, label + ' points at unknown next phase "' + phase.next + '".');
    }
    for (const ref of phase.objectives) {
      if (!refs.objectives.has(ref)) push(errors, label + ' activates unknown objective "' + ref + '".');
    }
    for (const ref of phase.activateGroups.concat(phase.deactivateGroups)) {
      if (!refs.groups.has(ref)) push(errors, label + ' references unknown group "' + ref + '".');
    }
    phase.onEnter.forEach((action, index) => {
      for (const problem of validateAction(action, refs, label + " onEnter[" + (index + 1) + "]")) push(errors, problem);
    });
    phase.onExit.forEach((action, index) => {
      for (const problem of validateAction(action, refs, label + " onExit[" + (index + 1) + "]")) push(errors, problem);
    });
  }

  if (mission.startPhaseId && !phaseIds.has(mission.startPhaseId)) {
    push(errors, 'startPhaseId "' + mission.startPhaseId + '" is not a declared phase.');
  }

  // A phase after the first that nothing can ever enter is a dead branch.
  if (mission.phases.length > 1) {
    const reachable = new Set([mission.startPhaseId || mission.phases[0].id]);
    for (const phase of mission.phases) {
      if (phase.next) reachable.add(phase.next);
      if (phase.enterWhen) reachable.add(phase.id);
      for (const action of phase.onEnter.concat(phase.onExit)) {
        if (action.type === "startPhase" && action.phaseRef) reachable.add(action.phaseRef);
      }
    }
    for (const beat of mission.beats) {
      for (const action of beat.actions) {
        if (action.type === "startPhase" && action.phaseRef) reachable.add(action.phaseRef);
      }
    }
    for (const phase of mission.phases) {
      if (!reachable.has(phase.id)) {
        push(warnings, 'Phase "' + phase.id + '" is unreachable: nothing enters it and no phase leads to it.');
      }
    }
  }

  /* beats */
  const beatIds = new Set();
  for (const beat of mission.beats) {
    const label = 'Beat "' + beat.id + '"';
    if (beatIds.has(beat.id)) push(errors, "Duplicate beat id " + beat.id + ".");
    beatIds.add(beat.id);

    if (!beat.trigger && !beat.when) {
      push(errors, label + " has neither a trigger nor a condition, so it can never fire.");
    }
    if (beat.trigger) {
      for (const problem of validateTrigger(beat.trigger, refs, label + " trigger")) push(errors, problem);
    }
    if (beat.when) {
      for (const problem of validateCondition(beat.when, refs, label + " when")) push(errors, problem);
    }
    if (beat.phase) {
      const phases = Array.isArray(beat.phase) ? beat.phase : [beat.phase];
      for (const ref of phases) {
        if (!refs.phases.has(ref)) push(errors, label + ' is scoped to unknown phase "' + ref + '".');
      }
    }
    if (!beat.actions.length) {
      push(warnings, label + " has no actions, so firing it does nothing.");
    }
    beat.actions.forEach((action, index) => {
      for (const problem of validateAction(action, refs, label + " action " + (index + 1))) push(errors, problem);
    });

    // A beat that can fire repeatedly and re-triggers its own trigger type is
    // the classic runaway; the runtime bounds it, but say so at author time.
    if (beat.once === false && beat.actions.some((action) => action.type === "startPhase")) {
      push(warnings, label + " is repeatable and starts a phase. Consider `once: true` to avoid re-entering it.");
    }
  }

  if (mission.phases.length && !mission.objectives.length) {
    push(warnings, "This mission uses phases but declares no objectives, so phases cannot change what the player is doing.");
  }
}

function validateObjectiveShape(objective, mission, unitRefs, regionIds, errors, warnings, label) {
  const type = objectiveTypeById(objective.type);
  if (!type) {
    errors.push(label + ' uses unknown objective type "' + objective.type + '".');
    return;
  }
  const needs = type.params;

  if (needs.includes("unitRefs")) {
    if (!objective.unitRefs.length) {
      // reachExtraction defaults to "any player unit", so an empty list is fine there.
      if (objective.type !== "reachExtraction" && objective.type !== "surviveActivations") {
        errors.push(label + " (" + type.name + ") needs at least one target unit.");
      }
    }
    for (const ref of objective.unitRefs) {
      if (!unitRefs.has(ref)) errors.push(label + ' references missing unit "' + ref + '".');
    }
  }

  if (needs.includes("regionRef")) {
    if (!objective.regionRef) {
      errors.push(label + " (" + type.name + ") needs a region.");
    } else if (!regionIds.has(objective.regionRef)) {
      errors.push(label + ' references missing region "' + objective.regionRef + '".');
    } else {
      const region = mission.regions.find((entry) => entry.id === objective.regionRef);
      const reachable = region.tiles.filter(
        (tile) =>
          tile.y < mission.map.height &&
          tile.x < mission.map.width &&
          isWalkableTerrain(mission.map.terrain[tile.y][tile.x])
      );
      if (!reachable.length) {
        errors.push(label + ' region "' + objective.regionRef + '" has no walkable tiles, so it can never be satisfied.');
      }
    }
  }

  if (needs.includes("activations")) {
    if (!objective.activations || objective.activations < 1) {
      errors.push(label + " (" + type.name + ") needs a positive activation count.");
    } else if (objective.activations > 200) {
      warnings.push(label + " waits " + objective.activations + " activations, which is a very long battle.");
    }
  }

  if (objective.type === "protectUnits") {
    for (const ref of objective.unitRefs) {
      const unit = mission.units.find((entry) => entry.ref === ref);
      if (unit && unit.teamId === mission.objective.opposingTeamId) {
        warnings.push(label + ' protects "' + ref + '", which is on the hostile team.');
      }
    }
  }

  if (objective.type === "destroyTargets") {
    for (const ref of objective.unitRefs) {
      const unit = mission.units.find((entry) => entry.ref === ref);
      if (unit && unit.teamId === mission.objective.teamId) {
        warnings.push(label + ' asks you to destroy "' + ref + '", which is on your own team.');
      }
    }
  }
}

function isWalkableTerrain(id) {
  const terrain = terrainById(id);
  return !!terrain && terrain.walkable;
}

function isRectangular(tiles) {
  if (!tiles.length) return true;
  const xs = tiles.map((tile) => tile.x);
  const ys = tiles.map((tile) => tile.y);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  return w * h === tiles.length;
}

/* ---------------------------------------------------------------
 * COMPILATION
 *
 * mission file  ->  { map, encounter, script } shaped exactly like the
 * hand-written MAPS / ENCOUNTERS / CAMPAIGN.dialogue entries in App.jsx.
 * -------------------------------------------------------------*/

export function compileMission(rawMission) {
  const mission = normalizeMission(rawMission);

  const legend = buildLegend(mission);
  const charByTerrain = Object.fromEntries(
    Object.entries(legend).map(([char, terrainId]) => [terrainId, char])
  );

  const map = {
    name: mission.map.name || mission.name,
    width: mission.map.width,
    height: mission.map.height,
    legend,
    rows: mission.map.terrain.map((row) => row.map((id) => charByTerrain[id] || ".").join("")),
    elevationRows: mission.map.elevation.map((row) => row.map((value) => encodeElevation(value)).join(""))
  };

  // Reserve groups are held off the map until a spawnGroup action places them.
  const reserveGroupIds = new Set(
    mission.groups.filter((group) => group.deployment === "reserve").map((group) => group.id)
  );
  const fieldUnits = mission.units.filter((unit) => !reserveGroupIds.has(unit.group));
  const reserveUnits = mission.units.filter((unit) => reserveGroupIds.has(unit.group));

  // Runtime ids are assigned by createBattle() as u1..uN in encounter order,
  // so the compiler owns that mapping and every reference resolves through it.
  // Units also carry their authored `ref` into battle state, which is what
  // lets the mission runtime address spawned units that have no fixed index.
  const runtimeIdByRef = {};
  const toSpawnSpec = (unit) => {
    const entry = {
      ref: unit.ref,
      definitionId: unit.definitionId,
      teamId: unit.teamId,
      x: unit.x,
      y: unit.y
    };
    if (unit.facing) entry.facing = unit.facing;
    if (unit.aiProfile) entry.aiProfile = unit.aiProfile;
    if (unit.group) entry.groupId = unit.group;
    if (unit.equipment) entry.equipment = { ...unit.equipment };
    return entry;
  };
  const encounterUnits = fieldUnits.map((unit, index) => {
    runtimeIdByRef[unit.ref] = "u" + (index + 1);
    return toSpawnSpec(unit);
  });

  const regionTiles = {};
  for (const region of mission.regions) {
    regionTiles[region.id] = region.tiles.map((tile) => ({ x: tile.x, y: tile.y }));
  }

  const resolveUnits = (refs) =>
    (refs || []).map((ref) => runtimeIdByRef[ref]).filter(Boolean);
  const resolveRegion = (regionRef) => (regionRef && regionTiles[regionRef]) || [];

  const encounter = {
    name: mission.name,
    mapId: mapIdFor(mission.id),
    objectiveText: mission.objective.text,
    objective: mission.objective.type,
    objectiveParams: compileObjectiveParams(mission.objective, resolveUnits, resolveRegion),
    teams: mission.teams.map((team) => ({ ...team })),
    units: encounterUnits
  };

  const script = {
    sequences: {
      briefing: mission.sequences.briefing.slice(),
      victory: mission.sequences.victory.slice(),
      defeat: mission.sequences.defeat.slice()
    },
    scenes: Object.fromEntries(
      Object.entries(mission.scenes).map(([sceneId, scene]) => [
        sceneId,
        {
          title: scene.title,
          location: scene.location,
          kind: scene.kind,
          lines: scene.lines.map((line) => ({ speaker: line.speaker, text: line.text })),
          ...(scene.choices.length ? { choices: scene.choices.map(cloneChoice) } : {})
        }
      ])
    ),
    midBattle: mission.midBattle.map((beat) => compileMidBattle(beat, resolveUnits, regionTiles)),

    /* ---- runtime scripting layer ----
     * Passed straight to src/mission/runtime.js. References stay symbolic
     * (unit refs, region ids) because the runtime resolves them against live
     * battle state — a unit spawned mid-battle has no compile-time index. */
    id: mission.id,
    startPhaseId: mission.startPhaseId || (mission.phases[0] ? mission.phases[0].id : null),
    factions: {
      relationships: mission.factions.relationships.map((entry) => ({ ...entry }))
    },
    regions: mission.regions.map((region) => ({
      id: region.id,
      name: region.name,
      tiles: region.tiles.map((tile) => ({ x: tile.x, y: tile.y }))
    })),
    groups: mission.groups.map((group) => ({
      id: group.id,
      name: group.name,
      teamId: group.teamId,
      startsActive: group.startsActive,
      deployment: group.deployment,
      units: reserveUnits.filter((unit) => unit.group === group.id).map(toSpawnSpec)
    })),
    objectives: mission.objectives.map((objective) => ({
      id: objective.id,
      objectiveId: objective.type,
      text: objective.text,
      required: objective.required,
      hidden: objective.hidden,
      startsActive: objective.startsActive,
      params: compileObjectiveParams(objective, resolveUnits, resolveRegion, { symbolic: true })
    })),
    phases: mission.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      enterWhen: phase.enterWhen ? { ...phase.enterWhen } : null,
      next: phase.next,
      objectives: phase.objectives.slice(),
      activateGroups: phase.activateGroups.slice(),
      deactivateGroups: phase.deactivateGroups.slice(),
      onEnter: phase.onEnter.map((action) => ({ ...action })),
      onExit: phase.onExit.map((action) => ({ ...action })),
      music: phase.music
    })),
    beats: mission.beats.map((beat) => ({
      id: beat.id,
      name: beat.name,
      trigger: beat.trigger ? { ...beat.trigger } : null,
      when: beat.when ? JSON.parse(JSON.stringify(beat.when)) : null,
      phase: beat.phase,
      once: beat.once,
      maxFires: beat.maxFires,
      priority: beat.priority,
      actions: beat.actions.map((action) => ({ ...action }))
    }))
  };

  return {
    missionId: mission.id,
    mapId: encounter.mapId,
    encounterId: encounterIdFor(mission.id),
    map,
    encounter,
    script,
    runtimeIdByRef,
    campaign: mission.campaign,
    mission
  };
}

export function mapIdFor(missionId) {
  return "file:" + missionId + ":map";
}

export function encounterIdFor(missionId) {
  return "file:" + missionId;
}

function cloneChoice(choice) {
  return {
    id: choice.id,
    prompt: choice.prompt,
    options: choice.options.map((option) => ({
      id: option.id,
      text: option.text,
      flag: option.flag,
      detail: option.detail
    }))
  };
}

function compileObjectiveParams(objective, resolveUnits, resolveRegion, options) {
  const base = {
    teamId: objective.teamId,
    opposingTeamId: objective.opposingTeamId
  };

  if (objective.type === "phasedObjective") {
    return {
      ...base,
      phases: objective.phases.map((phase) => ({
        id: phase.id,
        type: phase.type,
        params: singleObjectiveParams(phase, resolveUnits, resolveRegion, options)
      }))
    };
  }

  return { ...base, ...singleObjectiveParams(objective, resolveUnits, resolveRegion, options) };
}

function singleObjectiveParams(objective, resolveUnits, resolveRegion, options) {
  const params = {};
  const refs = objective.unitRefs || [];
  if (refs.length) {
    if (options && options.symbolic) {
      // Script-owned objectives keep authored refs; the engine resolves them
      // against live state so units spawned mid-battle can be targets.
      params.unitRefs = refs.slice();
    } else {
      const units = resolveUnits(refs);
      if (units.length) params.unitIds = units;
    }
  }
  if (objective.regionRef) params.tiles = resolveRegion(objective.regionRef);
  if (objective.activations != null) params.activations = objective.activations;
  if (objective.type === "reachExtraction" && objective.allowElimination) params.allowElimination = true;
  return params;
}

function compileMidBattle(beat, resolveUnits, regionTiles) {
  const trigger = { ...beat.trigger };

  if (trigger.regionRef) {
    const tiles = regionTiles[trigger.regionRef] || [];
    if (trigger.type === "extractionReached") {
      trigger.tiles = tiles;
    } else {
      trigger.zone = boundingBox(tiles);
    }
    delete trigger.regionRef;
  }
  if (trigger.unitRefs) {
    trigger.unitIds = resolveUnits(trigger.unitRefs);
    delete trigger.unitRefs;
  }

  const compiled = {
    id: beat.id,
    trigger,
    speaker: beat.speaker,
    text: beat.text,
    priority: beat.priority,
    pauseBattle: beat.pauseBattle,
    once: beat.once
  };
  if (beat.followUpLines.length) compiled.followUpLines = beat.followUpLines.map((line) => ({ ...line }));
  if (beat.when) compiled.when = beat.when;
  return compiled;
}

function boundingBox(tiles) {
  if (!tiles.length) return { xMin: 0, xMax: -1, yMin: 0, yMax: -1 };
  const xs = tiles.map((tile) => tile.x);
  const ys = tiles.map((tile) => tile.y);
  return {
    xMin: Math.min(...xs),
    xMax: Math.max(...xs),
    yMin: Math.min(...ys),
    yMax: Math.max(...ys)
  };
}

function buildLegend(mission) {
  const used = new Set();
  for (const row of mission.map.terrain) for (const id of row) used.add(id);
  const legend = {};
  for (const terrain of TERRAIN_CATALOG) {
    if (used.has(terrain.id)) legend[terrain.char] = terrain.id;
  }
  if (!Object.keys(legend).length) legend["."] = "plain";
  return legend;
}

/** Elevations are written as base-36 digits so a 12-level map still reads as
 *  one character per tile in the exported file. */
function encodeElevation(value) {
  const level = Math.max(0, Math.min(35, Math.round(Number(value) || 0)));
  return level.toString(36);
}

/* ---------------------------------------------------------------
 * DRIFT CHECK
 *
 * Called by the game's own test suite with the live CONTENT registry, so the
 * hand-mirrored catalog.js can never silently fall out of date.
 * -------------------------------------------------------------*/

export function catalogDriftIssues(content) {
  const issues = [];
  const check = (label, catalogIds, liveIds) => {
    for (const id of catalogIds) {
      if (!liveIds.includes(id)) issues.push(label + ' "' + id + '" is in catalog.js but not in the game.');
    }
  };
  check("Terrain", TERRAIN_IDS, Object.keys(content.terrains));
  check("Chassis", UNIT_IDS, Object.keys(content.units));
  check("AI profile", AI_PROFILE_IDS, Object.keys(content.aiProfiles));
  check("Ability", ABILITY_IDS, Object.keys(content.abilities));
  check("Status", STATUS_IDS, Object.keys(content.statuses));
  check("Equipment", EQUIPMENT_IDS, Object.keys(content.equipment));

  // The reverse direction is a warning, not an error: not every internal test
  // fixture needs to be placeable in the editor.
  return issues;
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 * -------------------------------------------------------------*/

export function serializeMission(mission) {
  const m = normalizeMission(mission);
  const legend = buildLegend(m);
  const charByTerrain = Object.fromEntries(
    Object.entries(legend).map(([char, terrainId]) => [terrainId, char])
  );

  // Exported in the compact row form: reviewable in a diff, hand-editable,
  // and re-openable by the editor because normalizeMap() reads both forms.
  return JSON.stringify(
    {
      format: FORMAT_ID,
      formatVersion: FORMAT_VERSION,
      id: m.id,
      name: m.name,
      scale: m.scale,
      summary: m.summary,
      map: {
        name: m.map.name,
        width: m.map.width,
        height: m.map.height,
        legend,
        rows: m.map.terrain.map((row) => row.map((id) => charByTerrain[id] || ".").join("")),
        elevationRows: m.map.elevation.map((row) => row.map(encodeElevation).join(""))
      },
      teams: m.teams,
      units: m.units,
      regions: m.regions.map((region) => ({
        id: region.id,
        name: region.name,
        color: region.color,
        kind: region.kind,
        tiles: region.tiles
      })),
      objective: m.objective,
      scenes: m.scenes,
      sequences: m.sequences,
      midBattle: m.midBattle,

      /* scripting layer */
      factions: m.factions,
      groups: m.groups,
      objectives: m.objectives,
      phases: m.phases,
      beats: m.beats,
      ...(m.startPhaseId ? { startPhaseId: m.startPhaseId } : {}),
      ...(m.campaign ? { campaign: m.campaign } : {})
    },
    null,
    2
  );
}

export function parseMission(text) {
  const parsed = JSON.parse(text);
  if (parsed && parsed.format && parsed.format !== FORMAT_ID) {
    throw new Error('Not a Status Zero mission file (format: "' + parsed.format + '").');
  }
  return normalizeMission(parsed);
}
