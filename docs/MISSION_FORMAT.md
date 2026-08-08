# Mission file format & authoring workflow

One mission is one JSON file. It carries its own map, unit placements, named regions, objective, story scenes and mid-battle beats. Nothing about a mission lives in code.

- Format module: `src/content/mission-format.js`
- Loader: `src/content/mission-registry.js`
- Editor: `editor.html` → `src/editor/`
- Reference mission: `src/content/missions/act1-02-bellview-pump-station.json`

---

## The workflow

```
npm run editor          opens the editor at /editor.html
  paint the map
  place units, draw regions
  set the objective
  write scenes and mid-battle beats
  watch the validation panel  (errors block loading, warnings are usually design bugs)
  ▶ Playtest               opens the game on this mission in a new tab
  Export…                  saves <mission-id>.json

drop the file in src/content/missions/   →  it is in the game on the next reload
```

`npm run dev` serves both: the game at `/`, the editor at `/editor.html`.
`npm test` runs the full suite headlessly, including a check that every mission file loads, compiles and reaches a terminal result.

### Playtest vs. export

**Playtest** writes the mission into a browser storage slot that the loader reads at start-up. It overrides a checked-in file with the same id, so iterating on a shipped mission works. The game shows a `PLAYTEST` banner with an **Exit playtest** button that clears the slot.

**Export** produces the real artifact. In Chrome the file picker can write directly into `src/content/missions/`; elsewhere it downloads and you move it.

### Editor shortcuts

| | |
|---|---|
| `B` `E` `U` `R` `X` `V` | paint / elevation / unit / region / erase / select |
| `[` `]` | brush smaller / larger |
| `Ctrl+Z`, `Ctrl+Shift+Z` | undo / redo |
| right- or middle-drag | pan |
| wheel | zoom |

The editor autosaves your draft to local storage, so a refresh never loses work. Export is still the real save.

---

## File shape

```jsonc
{
  "format": "statuszero.mission",
  "formatVersion": 1,

  "id": "act1-02-bellview-pump-station",   // lowercase, digits, hyphens. Becomes the filename and encounter id.
  "name": "Bellview Pump Station",
  "scale": "M",                            // S | M | L | XL — GDD production target, used for a size warning only
  "summary": "…",

  "map": {
    "name": "Bellview Pump Station",
    "width": 34,
    "height": 44,
    "legend": { ".": "plain", "~": "rough", "#": "wall" },
    "rows": ["..#..#…", …],                // one string per row, one char per tile
    "elevationRows": ["0011…", …]          // base-36 digit per tile, so level 12 is "c"
  },

  "teams": [
    { "id": "player", "name": "Section Seven", "controller": "human", "marker": "▲", "accent": "emerald" },
    { "id": "foe",    "name": "Raiders",       "controller": "ai",    "marker": "■", "accent": "rose" }
  ],

  "units": [
    { "ref": "pumpWest", "definitionId": "supplyDepot", "teamId": "player",
      "x": 11, "y": 29, "facing": null, "aiProfile": null, "group": null, "note": "" }
  ],

  "regions": [
    { "id": "westLane", "name": "West Lane", "color": "#f59e0b", "kind": "trigger",
      "tiles": [{ "x": 2, "y": 10 }, …] }
  ],

  "objective": {
    "type": "protectUnits",
    "text": "Keep both pumps and the work crew intact",
    "teamId": "player",
    "opposingTeamId": "foe",
    "unitRefs": ["pumpWest", "pumpEast", "workerCrew"],
    "regionRef": null,
    "activations": null,
    "allowElimination": true,
    "phases": []
  },

  "scenes":    { "briefing": { "title": …, "location": …, "kind": …, "lines": [ { "speaker": …, "text": … } ], "choices": [] } },
  "sequences": { "briefing": ["briefing"], "victory": ["aftermath"], "defeat": ["defeat"] },

  "midBattle": [
    { "id": "westLaneContact",
      "trigger": { "type": "unitEnteredZone", "regionRef": "westLane", "teamId": "foe" },
      "speaker": "kell", "text": "West lane is moving.",
      "followUpLines": [], "priority": 75, "pauseBattle": false, "once": true }
  ],

  "phases": []      // authored mission phases — stored and validated, NOT executed yet (SCR-01)
}
```

The editor also reads a `terrain` / `elevation` form (2D arrays of ids and numbers) if you prefer generating files from a script. Both round-trip; export always writes the compact row form because it diffs and hand-edits better.

---

## Names, not ids

You refer to things by the names you gave them. The compiler resolves them:

| You write | The engine gets |
|---|---|
| `unitRefs: ["pumpWest"]` | `unitIds: ["u5"]` — position in the encounter's unit list |
| `regionRef: "evacZone"` on an extraction objective | `tiles: [{x,y}, …]` — the region's exact tiles |
| `regionRef: "westLane"` on a `unitEnteredZone` trigger | `zone: {xMin,xMax,yMin,yMax}` — the **bounding box** |

That last row is why the editor warns when a trigger region is not rectangular: objectives use exact tiles, but the engine's zone test is a bounding box. An L-shaped trigger region fires in the notch.

Renaming a unit or region in the editor rewrites every reference to it.

---

## Objectives

Only these exist in the engine. Anything else is a validation error, not a silent no-op.

| Type | Parameters | Behaviour |
|---|---|---|
| `defeatAllEnemies` | — | Wins when the opposing team is wiped out. |
| `destroyTargets` | units | Wins when every listed unit is destroyed. Losing your team loses. |
| `protectUnits` | units | Fails the instant **any** protected unit dies; wins on elimination. |
| `reachExtraction` | region, units | Wins when any listed unit stands on a region tile. Elimination optionally also wins. |
| `surviveActivations` | activations, units | Wins at the activation count. |
| `holdPosition` | region, activations | At the activation count you must be standing in the region. |
| `phasedObjective` | phases | Runs the above in sequence. Advances forward only. |

An activation is **one unit taking its turn**, not a round.

**Known limits** (see `docs/ENGINE_ANALYSIS.md`): one objective at a time, no objective stack, no partial failure, no mid-battle mutation beyond linear phase advance. The GDD's "losing one pump is survivable, losing all of them fails" cannot currently be expressed — the reference mission uses the strict version and says so in its summary.

---

## Triggers

The editor lists every trigger in the GDD's §5.2 vocabulary. Supported ones show a green dot; unimplemented ones show `⚠`, and the validator warns that the beat will never fire.

**Supported today:** `battleStarted`, `activationCountReached`, `firstEnemyDefeated`, `halfEnemiesRemaining`, `enemyCountThreshold`, `unitEnteredZone`, `unitOfTagSpotted`, `eliteUnitSpotted`, `specificObjectiveTargetDamaged`, `specificObjectiveTargetDestroyed`, `objectiveProgressReached`, `objectivePhaseChanged`, `extractionActivated`, `extractionReached`, `alliedUnitHpBelowPercent`, `protectedUnitHpBelowPercent`, `civilianAttacked`, `civilianDamaged`, `civilianDestroyed`, `civilianSpotted`, `abilityUsed`, `statusApplied`, `statusRemoved`, `reinforcementSpawned`, `battleVictoryConditionMet`, `crossedHalfway`.

**Authored but inert** (engine backlog): `phaseStarted`, `phaseCompleted`, `timelineTime`, `unitLeftRegion`, `unitSpotted`, `contactStateChanged`, `unitSurrendered`, `unitDisabled`, `objectiveFailed`, `groupAlerted`, `resourceAbove`/`Below`, `terrainDestroyed`, `interactableUsed`, `wreckCreated`, `campaignFlag`.

**Beats can only produce dialogue.** The action vocabulary (spawn, change faction, replace objective, scripted attack…) is authorable in the format and flagged as inert, because the mid-battle layer cannot act yet. This is the top engine finding.

---

## Things the format deliberately does not hide

- **Player-team unit placements are start positions, not characters.** The campaign roster overwrites the chassis at deploy time, filling player-team slots in order. Place them where you want the squad to begin.
- **Protected assets and civilians have to be on the player team**, because hostility is currently `teamId !== teamId`. There is no neutral faction yet.
- **`group` on a unit is a label.** There is no spawn-group or dormancy system, so it does nothing at runtime. It is there so waves can be authored now and wired up when SPN-01 lands.
- **`phases` are stored, validated and exported, but not executed.** The phase state machine does not exist yet. The validator says so for every phase you author.

These are documented rather than smoothed over so that a mission written today is honest about which parts of it are live.

---

## Extending the vocabulary

`src/content/catalog.js` mirrors the terrain, chassis, AI profiles and speakers that the editor is allowed to place. It is a hand-maintained mirror of the definitions in `App.jsx`, kept honest by a drift test in the game's own suite — add a unit to the game and forget the catalog, and `npm test` fails.

When `App.jsx` is split into modules (analysis finding E-01) this file should be deleted and the real registries imported directly.
