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
  AI_PROFILE_IDS,
  FACINGS,
  SPEAKER_IDS,
  SCENE_KINDS,
  OBJECTIVE_TYPE_IDS,
  PHASE_OBJECTIVE_TYPE_IDS,
  objectiveTypeById,
  triggerTypeById,
  phaseActionTypeById,
  mapScaleById,
  terrainById
} from "./catalog.js";

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
    campaign: source.campaign || null
  };
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

/** Authored mission phases (GDD §2.2). Stored, validated and exported; the
 *  engine cannot run them yet — see finding R-01. */
function normalizePhase(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: source.id || "phase" + (index + 1),
    name: source.name || source.id || "Phase " + (index + 1),
    enterWhen: source.enterWhen || null,
    activeGroups: Array.isArray(source.activeGroups) ? source.activeGroups.slice() : [],
    objectiveIds: Array.isArray(source.objectiveIds) ? source.objectiveIds.slice() : [],
    music: source.music || null,
    actions: Array.isArray(source.actions)
      ? source.actions.map((action) => ({ ...action, type: action.type || "queueBark" }))
      : []
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
        options: (Array.isArray(choice.options) ? choice.options : []).map((option, oIndex) => ({
          id: option.id || "option" + (oIndex + 1),
          text: option.text || "",
          flag: option.flag || "",
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

export function validateMission(mission) {
  const errors = [];
  const warnings = [];
  const m = normalizeMission(mission);

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
        if (!option.flag) push(warnings, 'Choice option "' + option.id + '" sets no campaign flag, so nothing can react to it.');
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
    for (const action of beat.actions) {
      const actionType = phaseActionTypeById(action.type);
      if (!actionType) {
        push(errors, label + ' uses unknown action "' + action.type + '".');
      } else if (!actionType.supported) {
        push(
          warnings,
          label + ' queues action "' + action.type + '". The mid-battle layer can only queue dialogue today (finding R-01), so this is authored but inert.'
        );
      }
    }
  }

  /* --- authored mission phases --- */
  for (const phase of m.phases) {
    push(
      warnings,
      'Mission phase "' + phase.id + '" is stored but not executed — the phase state machine (SCR-01) is not built yet.'
    );
    for (const action of phase.actions) {
      if (!phaseActionTypeById(action.type)) {
        push(errors, 'Mission phase "' + phase.id + '" uses unknown action "' + action.type + '".');
      }
    }
  }

  return { errors, warnings, mission: m, ok: errors.length === 0 };
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

  // Runtime ids are assigned by createBattle() as u1..uN in encounter order,
  // so the compiler owns that mapping and every reference resolves through it.
  const runtimeIdByRef = {};
  const encounterUnits = mission.units.map((unit, index) => {
    runtimeIdByRef[unit.ref] = "u" + (index + 1);
    const entry = {
      definitionId: unit.definitionId,
      teamId: unit.teamId,
      x: unit.x,
      y: unit.y
    };
    if (unit.facing) entry.facing = unit.facing;
    if (unit.aiProfile) entry.aiProfile = unit.aiProfile;
    return entry;
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
    midBattle: mission.midBattle.map((beat) => compileMidBattle(beat, resolveUnits, regionTiles))
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

function compileObjectiveParams(objective, resolveUnits, resolveRegion) {
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
        params: singleObjectiveParams(phase, resolveUnits, resolveRegion)
      }))
    };
  }

  return { ...base, ...singleObjectiveParams(objective, resolveUnits, resolveRegion) };
}

function singleObjectiveParams(objective, resolveUnits, resolveRegion) {
  const params = {};
  const units = resolveUnits(objective.unitRefs);
  if (units.length) params.unitIds = units;
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
      phases: m.phases,
      scenes: m.scenes,
      sequences: m.sequences,
      midBattle: m.midBattle,
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
