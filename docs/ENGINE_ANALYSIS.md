# STATUS ZERO — ENGINE ANALYSIS

**Audit of `src/App.jsx` against the Gameplay, Mission & Engine Design v1.0 and the four character documents.**
Written to answer one question: *what has to be built before it is worth authoring assets, dialogue and 72 operations?*

Line references are to `src/App.jsx` as of this commit.

---

## 0. The short version

The engine is in much better shape than the repository makes it look. It is a **real, deterministic, data-driven tactical simulator** with a clean engine/presentation split, 314 self-tests and an architecture audit that enforces the split automatically. That is genuinely rare and it is worth a lot. Nothing in this document argues for a rewrite.

But there is a single structural fact that dominates everything else:

> **Every map in the game is 8×8.** All eleven campaign maps, both fixtures, without exception. The GDD's *smallest* battlefield is 26×32 — 13× larger — and its set pieces are 64×80, or **80× larger**.

Almost every gap below is downstream of that. The engine has never been asked to do the thing the design is about, and a number of systems that look "done" are done at a scale that will not survive contact with a real mission.

The second dominant fact:

> **There is no mission data pipeline.** Maps are string literals in a 29,000-line file. Encounters hardcode `x`/`y`. The mid-battle layer can queue dialogue and nothing else — it cannot spawn, flip a faction, change an objective or alter terrain. Grayfield, as specified, cannot be authored at all.

So the honest ordering is:

1. **Make missions data.** (Started in this pass — see §6.)
2. **Make the mid-battle layer able to do things, not just say things.** This is the single highest-value engine change in the project.
3. **Retune movement and the timeline for maps 20× bigger.**
4. Then factions, reactions, stealth states, mid-mission save.
5. Only then: assets, dialogue, 72 operations.

Writing dialogue now is not wasted — the story layer is real and works. Writing *mission* content now is wasted, because the container it goes into does not exist yet.

---

## 1. What is already good

Do not rebuild these. They are the reason this project is worth continuing.

| | |
|---|---|
| **Engine / renderer split** | The engine below the "EDITABLE CONTENT ABOVE / ENGINE BELOW" divider never touches React or the DOM, and `auditArchitecture()` (line 8931) *proves* it on every run by regexing function sources for `React`, `document.`, `window.` and every concrete content id. This is enforced, not aspirational. It is the SIM-01 requirement, already met. |
| **Determinism** | Seeded RNG threaded through battle state; `deterministicReplayCheck()` exists and passes. A battle is a pure function of (encounter, seed, commands). |
| **Data-driven effects** | 30+ effect handlers behind `EFFECT_HANDLERS`, resolved generically. Abilities, statuses and equipment are data. Adding a new ability is a data edit. |
| **Content validation** | `collectContentIssues()` refuses to start a battle against broken content, with per-effect validators. This is the discipline that makes 72 missions survivable. |
| **Test suite** | 314 tests across 50 groups, all passing, all renderer-free. |
| **Timeline** | A genuine continuous recovery timeline (TIM-01), not rounds. Speed → turn rate → recovery delay, with previews. The character docs' tempo ideas have somewhere to land. |
| **Elevation / facing / flanking** | Real climb and drop limits, real facing arcs with front/side/rear modifiers, real LOS. MAP-01 is largely met — at 8×8. |
| **Campaign layer** | Flags, mission outcomes derived from *authoritative battle facts* rather than dialogue promises (BRN-01 is genuinely met, and it is the requirement most projects fake). |

**Measured performance** (34×44 map, 18 units, headless):

| | 8×8 campaign map | 34×44 file map |
|---|---|---|
| Battle creation | 0.4 ms | 0.4 ms |
| Movement range for one unit | 0.8 ms | 3 ms |
| One full AI decision | 2.5 ms | 2.7 ms |
| **Whole battle to a terminal result** | 100 ms / 25 activations | **109 ms / 51 activations** |

This is the encouraging surprise: **the simulation core scales**. A 23×-larger map costs essentially nothing. The performance problems the GDD anticipates (MAP-02) are real but they are *renderer and AI-population* problems, not simulation problems. Do not pre-optimise the simulation.

---

## 2. The headline problem: scale

### 2.1 Everything is 8×8

```
MAPS                 provingGrounds 8×8, elevationLab 8×8
Act One content pack hollowmerePerimeter, borderOutpost, reliefDepot,
                     cleanupCauseway, detentionYard, pursuitCanal,
                     convoyDepot, quarryEvacuation, quarryDefense
                     — all 8×8
```

An 8×8 map is 64 tiles. The GDD's S tier wants ~450–600 walkable tiles; XL wants 2,200–3,200.

### 2.2 The tuning is 8×8 tuning, and it does not transfer

This is the part that will bite quietly, because nothing errors — the missions just feel wrong.

- `GAME_CONFIG.grid.maxPathLength = 32` (line 42). On a 64×80 map, a unit **cannot path more than 32 tiles**, which is less than the map's height. Long routes silently fail to be found rather than reporting a problem.
- `movementRecoveryPerTile = 40` against `baseRecovery = 1000` (line 50). Measured reachable tiles for a mech: **7 on the 8×8 map, 34 on the 34×44 map** — but a 44-tile-tall map needs roughly **eight activations just to cross**. The GDD's direct-route rule ("meaningful contact within two player activations", §3) is violated by the default numbers on any map above S.
- `timeline.previewCount = 15`, `limits.maxActivationsPerBattle = 400`. A 90–150 minute XL operation will exceed 400 activations.
- The camera's initial fit is tuned for a small diamond. On the 34×44 test map the opening view shows perhaps a quarter of the battlefield. Observed directly in playtest.

**Action:** these are balance constants in one place, which is exactly right. They just need a pass against real map sizes. Do that pass *before* authoring, not after — every mission authored against the wrong movement economy has to be re-laid-out.

### 2.3 What this means for asset work

Terrain art is currently a per-terrain-id tile (`terrain/plain`, `terrain/rough`, `terrain/wall`) with **four terrain types total**. A 64×80 map painted from four tiles will read as noise. Before commissioning tile art, decide the real terrain vocabulary — the GDD implies doors, gates, power nodes, bridges, hazards, collapsible tiles (MAP-03), none of which exist. **Do not commission terrain art until MAP-03's vocabulary is settled**; you will be paying for it twice.

---

## 3. Requirement audit

Against the GDD §8 catalogue. **Met** / **Partial** / **Missing**.

| ID | Requirement | Status | Note |
|---|---|---|---|
| SIM-01 | Deterministic authoritative simulation | **Met** | Enforced by the architecture audit. |
| TIM-01 | Recovery timeline | **Met** | Constants need a large-map pass (§2.2). |
| ACT-01 | Action + reaction framework | **Partial** | Move + primary action + quick actions exist. **No reaction system at all** — line 6047 is a comment reading "Generic hook reserved for Phase 4 reactions". Every trio Link mechanic depends on this. |
| RES-01 | Generic resource framework | **Partial** | Per-unit resources exist with max/current and spend/restore effects. **No squad-wide resources** (Stock), no charge/solution states, no reaction pools. |
| STA-01 | Status/component framework | **Partial** | Timed statuses work well. **No subsystem damage** — nothing models a damaged sensor, radiator, weapon or comms, which Kell's solution-breaking, Nyx's venting and Becker's whole character need. |
| FAC-01 | Multi-faction hostility matrix | **Missing** | `isHostile()` is one line: `teamId !== teamId` (line 4690). Three teams means three mutually hostile teams. Civilians and protected assets have to be put **on the player team**, which is why the example mission's pumps are player units. Mid-battle hostility change is impossible. |
| MAP-01 | 2.5D tile battlefield | **Met** | Elevation, cover, facing, flanking, LOS, deterministic projection all present. |
| MAP-02 | Large-map sectors & culling | **Missing** | No dormant groups, no sector activation, no render culling, no pathfinding budget. Every unit thinks every activation (`runAiTurn`, line 8273). |
| MAP-03 | Interactive/destructible environment | **Missing** | `createTerrain`/`removeTerrain` effects exist and are capped at 64 overrides. **No doors, gates, interactables, hazards or scripted terrain replacement.** |
| LOS-01 | Sensor/visibility model | **Partial** | Real LOS exists. **No shared sensor contacts, no remote targeting, no separation of concealment from targetability** beyond two status flags. |
| AI-01 | Role-based tactical AI | **Partial** | Three profiles (`aggressive`, `cautious`, `support`) that are pure weight vectors. No hunter, escort, civilian, ace or objective-focused behaviour. |
| AI-02 | Alert/search state | **Missing** | No dormant → alerted → searching → engaged. AI reads full battle state; there is no per-faction knowledge model at all. |
| STL-01 | Three-state stealth | **Missing** | Concealment is a boolean derived from status flags `untargetable` / `hidden` (line 4758). No Suspected state, no last-known position, no heat, no counter-detection. Nyx's entire design is unimplemented. |
| OBJ-01 | Composable objectives | **Partial** | Six types plus a linear `phasedObjective`. **One objective at a time**, no objective stack, no partial failure. The GDD's Bellview brief ("losing pumps is survivable unless all fail") cannot be expressed. |
| OBJ-02 | Dynamic objective mutation | **Missing** | Phases advance linearly and only forward. Objectives cannot be added, replaced, failed, hidden or reprioritised mid-battle. |
| SCR-01 | Mission phase state machine | **Missing** | No phase machine. |
| SCR-02 | Trigger/action event bus | **Partial → the critical gap.** | See §4. Triggers exist but only produce dialogue, and they work by rescanning the battle log rather than subscribing to events. |
| CIN-01 | Mid-battle cinematic sequencer | **Partial** | Hard-pause portrait dialogue with priority and once-only works well. No camera choreography, no unit emphasis, no in-scene choices mid-battle. |
| CIN-02 | Cinematic authoritative actions | **Missing** | A cutscene cannot change battle state. Grayfield's scripted shot, scripted repair and faction flip are all impossible. |
| BARK-01 | Non-blocking combat dialogue | **Partial** | `pauseBattle: false` exists on beats. No collision/cooldown rules to prevent spam. |
| SPN-01 | Reinforcement system | **Missing** | A `spawnUnit` effect exists for summons. **No authored spawn groups, no map-edge arrival, no telegraphing, no phase-specific AI assignment.** |
| BOS-01 | Elite/ace phase behaviour | **Missing** | No retreat, no loadout change, no death-refusal, no cross-mission persistence. |
| CIV-01 | Civilian/convoy behaviour | **Partial** | A `civilian` tag exists and outcome facts track civilian damage — which is the *good* half. No panic, flee, traffic routes or evacuation zones. |
| CAP-01 | Disable/capture/surrender | **Missing** | Units are alive or destroyed. No disable, capture, surrender or extraction of a pilot from a dead frame. |
| SUB-01 | Multi-sector / submap | **Missing** | One map per battle. |
| UI-01 | Battle HUD clarity | **Met** | Genuinely strong — timeline, forecasts, threat zones, danger overlays, contextual command model. |
| RWD-01 | Loot/salvage/persistent condition | **Partial** | Equipment ownership, frame condition and repair costs persist. No wreck salvage. |
| PRG-01 | Character-specific skill trees | **Missing** | A one-perk-per-operator choice (`perkChoices`, two options each) stands in for three deep trees per operator. |
| HUB-01 | Roster-as-capability hub | **Partial** | Facilities exist and gate on flags. Capabilities are not attached to people. |
| VALE-01 | Authority + Aegis datalink | **Missing** | No Authority resource, no marks that feed allies, no sensor sharing. |
| KELL-01 | Firing solution + remote shot | **Missing** | No anchor/charge/fire state, no thermal reveal, no firing on another unit's sensors. |
| REYES-01 | Stock + field engineering | **Missing** | Repair abilities exist; the Stock economy, salvage and strain do not. |
| NYX-01 | Thermal headroom + cloak | **Missing** | A binary `cloak` status stands in. |
| LINK-01 | Relationship link / reaction pool | **Missing** | Blocked on ACT-01. |
| BRN-01 | Outcome fact/flag system | **Met** | The best-implemented advanced requirement in the project. Facts are derived from battle state, and the architecture audit *tests* that a dialogue promise does not set the flag. |
| SAV-01 | Mid-mission save/resume | **Missing** | `saveCampaign()` (line 17799) serialises hub state only. Battle state is never serialised. A 150-minute XL operation cannot be paused. |
| AUD-01 | Contextual audio control | **Partial** | Per-screen and per-mission music with fallback chains. No per-phase changes or stingers. |
| DBG-01 | Mission authoring/debug tools | **Partial** | Strong developer panel, validation panel, soak tests, replay check. No phase jump, flag setting, group spawning or AI-knowledge inspection. |

**Tally: 7 met, 13 partial, 20 missing.**

That reads worse than it is. Of the 20 missing, roughly twelve are downstream of just **three** systems: the mission script layer (SCR-01/02, CIN-02, OBJ-02, SPN-01, BOS-01), the faction matrix (FAC-01, CAP-01, CIV-01), and the reaction framework (ACT-01, LINK-01, and all four character kits).

---

## 4. The critical gap, in detail

### R-01 — The mid-battle layer can talk but cannot act

`evaluateMidBattleTriggers()` (line 16983) is the closest thing to the GDD's §5 mission-script layer. What it actually does:

1. Takes the mission's `midBattle` array.
2. For each entry, **rescans the entire battle log** looking for matching entries.
3. Returns a list of **dialogue objects** — speaker, text, priority, `pauseBattle`, `once`.

Three consequences:

**It is dialogue-only.** There is no action vocabulary. Nothing in the GDD §5.3 list — spawn, change faction, replace objective, scripted attack, scripted repair, alter terrain, change AI profile, set flag, focus camera, change music — can be triggered. Grayfield's entire second phase is out of reach, and so is Warner Collapse.

**It is a log scan, not an event bus.** Every check re-filters `state.battleLog` from index zero on every evaluation. At 8×8 with 25 activations that is free. At XL with 400+ activations and 30 beats it becomes quadratic. More importantly it means triggers can only observe things that happen to have been *logged*, which is why the trigger list is a 25-branch `if/else` chain of special cases (`crossedHalfway` literally checks whether any player unit's `y` is above the map's midpoint) rather than a general vocabulary.

**Trigger types are hardcoded in the engine.** Adding `unitLeftRegion` means editing App.jsx, which is precisely the thing the GDD's §15 definition of done forbids.

**Fix, in order:**
1. Emit typed events from the simulation (`unitEnteredRegion`, `unitDefeated`, `objectiveProgress`, `resourceBelow`, …) into a subscription bus rather than a text log.
2. Give mission data a **phase state machine** (`approach → contact → escalation → reversal → extraction`) whose transitions are events.
3. Give phases an **action list** resolved through a handler registry, exactly like `EFFECT_HANDLERS` already works for abilities. This is the pattern the codebase already knows; it just has not been applied to mission scripting.
4. Route scripted actions through the same authoritative command path as player actions so they land in the log and in saves (CIN-02).

This single change unblocks SCR-01, SCR-02, CIN-02, OBJ-02, SPN-01 and BOS-01 — six requirements, and by far the most mission-design leverage per unit of work.

### R-02 — No faction matrix

`isHostile()` is `state.units[a].teamId !== state.units[b].teamId`. Everything else follows from that one line:

- Neutrals and civilians must sit on the player team to avoid being shot, which distorts roster filling and objective bookkeeping.
- Three-way battles (Northport, Central Power, Executive District, and six other named operations) are impossible.
- Mid-battle defection — Grayfield, West Barracks, Exit Route — is impossible.

**Fix:** replace with a per-battle `hostility[teamA][teamB]` matrix, defaulted from the encounter and mutable by phase actions. This is a small change with very large content reach, and it is a prerequisite for CAP-01 and CIV-01.

### R-03 — No reaction framework

Line 6047: `/** Generic hook reserved for Phase 4 reactions. */` — an empty comment.

Every character document's signature mechanic is a reaction or an out-of-turn action:

- Vale marks → **Kell fires as a reaction, out of turn order**
- Kell kills → **Vale gets free movement**
- Reyes repairs → **that unit gains an immediate partial action**
- All three deployed → **shared reaction pool**

Also overwatch, guard interception, covering fire. `overwatch` currently exists as a status (`overwatching`) but not as an interrupt.

**Fix:** an interrupt queue with a per-activation reaction budget and an explicit recursion guard (the GDD calls this out, correctly — reaction-generated actions must not create reactions without limit). `GAME_CONFIG.limits` already has the right shape for the caps.

### R-04 — AI is omniscient and always awake

`chooseAiCommands()` (line 8196) reads `state` directly. There is no information view, no per-faction knowledge, no alert state, no dormancy. Every unit enumerates every reachable tile × every ability × every target, every activation.

At the measured 2.7 ms per decision this is fine up to roughly 25 thinking units — which happens to be exactly the GDD's own recommendation (§12.2). But the *design* consequence matters more than the performance one: **stealth cannot exist against an omniscient AI**, so STL-01 and AI-02 are blocked on this, and so is Nyx.

**Fix:** interpose a knowledge layer between AI and state. Start dumb — a per-faction set of "known contacts" with last-known positions, updated on LOS and on noise events. Dormancy falls out of it almost for free.

### R-05 — No mid-mission save

XL operations are specified at 90–150 minutes. Nothing serialises battle state. This is not a nice-to-have for missions that long; it is the difference between a mission being playable and being abandoned.

The good news: because the simulation is already deterministic and state-based, this is mostly a *discipline* problem rather than an architecture problem. The battle state object is already plain data. The work is auditing it for non-serialisable values, versioning it, and covering the things the GDD §12.1 lists (RNG state, event queue, fired triggers, dialogue index, AI knowledge, terrain overrides).

### R-06 — Content is the superseded prototype story

`CAMPAIGN` still contains the Hollowmere arc, with Reyes participating in Vale's jailbreak. The GDD §0 explicitly supersedes this ("When older prototype material conflicts — for example, Reyes participating in Vale's jailbreak — the newer character documents win"), and Hollowmere was retired for sounding invented.

This is not an engine problem, but it is a **planning** problem: thirteen missions of dialogue, flags, outcome rules and encounter data are written against a story that no longer exists. Decide explicitly whether Act One is a reference implementation to be replaced or content to be migrated. Do not let it rot in place while new content is written beside it — the flag namespace will collide.

### E-01 — One 29,000-line file

`src/App.jsx` is 29,530 lines containing content, engine, presentation adapter, tests and UI. The internal discipline is genuinely good — the divider comments are respected and the architecture audit enforces the boundary — but:

- Editing content means opening the engine.
- The test suite cannot run outside a browser (addressed in this pass, see §6).
- Merge conflicts between a designer editing content and a programmer editing the engine are guaranteed.
- Any tool that wants to know what a `rifleGrunt` is has to import the entire game.

**Fix:** split along the boundaries that already exist as comments — `content/`, `engine/`, `presentation/`, `ui/`, `tests/`. The audit function already knows where the lines are; it will keep them honest through the move. This is low-risk, mechanical and pays back immediately.

### E-02 — Content registry is built once and frozen

`CONTENT` is constructed at module scope and `deepFreeze`d (line 3745). Nothing can be registered after load. That is a defensible choice for integrity, but it means hot-reloading a mission, loading DLC-style content, or letting a tool inject a map all require a page reload.

Worth revisiting when App.jsx is split: a `createContentRegistry()` that can be re-run, with the frozen instance as the default export.

---

## 5. Recommended build order

The GDD's §13 order is broadly right. Two amendments, based on what actually exists:

**Phase 0 — before anything else (days, not weeks)**
- **Retune movement, recovery and `maxPathLength` for M/L/XL maps.** Everything authored before this has to be re-laid-out afterward.
- Fix the camera's initial fit for large maps.
- Split App.jsx (E-01). Do it while the file is 29k lines rather than 60k.

**Phase A — mission script layer (R-01)**
Event bus → phase state machine → action handler registry → authoritative scripted actions. Plus the faction matrix (R-02), because half the interesting actions are faction changes.
*Definition of done: Warner Collapse can be authored as data.*

**Phase B — reactions and resources (R-03)**
Interrupt queue with caps; squad-wide resources; charge/solution states. Then mid-mission save (R-05), because save correctness is far cheaper to build before four bespoke character resources exist than after.

**Phase C — information model (R-04)**
Per-faction knowledge, last-known positions, alert states, dormancy. Then Nyx's heat and three-state stealth on top.

**Phase D — the trio**
Vale's Authority and datalink; Kell's firing solution and remote targeting; the Section Seven Link. These are the payoff for A–C and should be cheap once those exist.

**Phase E onward** — as the GDD has it: Reyes's Stock and the Workshop, then large-map sectors and destructibles, then hub capabilities and skill trees.

**Assets and dialogue** can start in parallel with Phase A for *portraits, music and UI art* — those are decoupled and the fallback system means missing art never breaks a rule. **Terrain and environment art should wait for MAP-03** (§2.3). **Mission content should wait for Phase A.**

---

## 6. What was built in this pass

Four things, all of which exist to unblock the analysis above rather than to pre-empt it.

### 6.1 A mission file format

`src/content/mission-format.js` — one JSON file per mission carrying its map, unit placements, named regions, objective, story scenes and mid-battle beats. Three functions: `normalizeMission`, `validateMission`, `compileMission`.

The compiler is what makes it pleasant to author: in a mission file you name things (`pumpWest`, `westLane`), and the compiler resolves them to what the engine wants (`u5`, a tile array, a bounding box). Neither the writer nor the tool ever handles runtime ids.

The validator reports **errors** (won't load) and **warnings** (will load, read them anyway), including several that catch real design mistakes: impassable elevation steps that look like open ground, extraction regions with no walkable tiles, objectives pointing at units on the wrong team, and enemy counts past the AI budget.

Critically, it also flags **what the engine cannot do yet**. Author a `phaseStarted` trigger or a `changeFaction` action and the tool says, in the panel, that the beat will never fire because the engine does not implement it. The backlog in §3 is visible from inside the tool.

### 6.2 A loader

`src/content/mission-registry.js` — eagerly globs `src/content/missions/*.json`, compiles them, and merges the results into the content registry before it is frozen. **Drop a file in the folder and it is in the game.** Hand-written maps win on an id collision so a stray file can never shadow a fixture.

It also reads a **playtest slot** written by the editor, which lets you go from painting a tile to standing on it without a rebuild.

Integration into App.jsx is four edits: the registry merge, `storyScript()` consulting file missions, `missionEncounterId()` resolving them, and a playtest boot path.

### 6.3 The editor

`editor.html` → `src/editor/`. A separate app that imports the mission format module **and nothing else** — it never loads App.jsx, so it builds to 46 kB and cannot be broken by a renderer change.

- **Map**: canvas-based (5,120 tiles will not tolerate DOM), viewport-culled, terrain painting, elevation raise/lower/flatten, variable brush, resize, undo/redo, keyboard tools.
- **Cliff warnings drawn live** — a red edge on any step a unit cannot climb. This is the mistake that is invisible in a text file and infuriating in playtest.
- **Units**: place by team and chassis, edit ref/facing/AI profile/group; renaming a unit updates every objective and trigger that points at it.
- **Regions**: named, coloured, painted areas that objectives and triggers select by name.
- **Objective**: every type the engine supports, with its parameters and a plain-language summary of what each one actually does. Phased objectives get a reorderable list.
- **Scenes**: the cutscene editor — scenes, speaker-attributed lines, choices with campaign flags, briefing/victory/defeat sequencing, and a live preview panel.
- **Beats**: mid-battle triggers with type-aware parameter fields, region and unit pickers, follow-up lines, priority, pause and once-only.
- **Live validation** in a permanent right-hand panel.
- **Playtest** button — writes the mission and opens the game on it in a new tab, with an in-game banner and an exit button.
- **Export** — writes straight into `src/content/missions/` via the file picker where the browser supports it, otherwise downloads.
- Autosaves to local storage, so a refresh never costs work.

**The workflow it is built around:** paint → validate → playtest → export → drop in the folder → shipped.

### 6.4 A reference mission and a headless test runner

`src/content/missions/act1-02-bellview-pump-station.json` — the GDD's Act One mission 2, at **34×44**, with 18 units, four regions, three scenes and six mid-battle beats. It is 23× larger than anything the engine had previously run, and it is what the performance numbers in §1 were measured on.

`npm test` now runs the existing 314-test suite headlessly (it previously only existed behind an in-game panel), plus five new tests covering the mission pipeline — including one that boots a battle on every file-authored map and asserts it reaches a terminal result, with an error message that names `maxPathLength` as the likely cause if it ever stalls.

**Current state: 314/314 passing, architecture audit passing, content clean.**

One pre-existing failing test was fixed: a bookkeeping assertion that the Presentation group contains 20 tests, when it has contained 21 since before this work.

---

## 7. Answering the actual question

> *What needs to be done first, before adding all the assets, dialogue, etc.?*

**Three things, in this order:**

1. **Retune the movement and timeline constants for real map sizes**, and split App.jsx. Both are cheap now and expensive later, and everything authored before the retune has to be redone after it.

2. **Build the mission script layer** — event bus, phase state machine, action handler registry, faction matrix. This is the difference between "we can write missions" and "we can write *these* missions". Grayfield is the acceptance test, exactly as the GDD says.

3. **Then reactions**, because the four character documents are all reaction mechanics wearing different hats, and none of them can be prototyped until interrupts exist.

Everything else — stealth states, Stock, Authority, firing solutions, submaps, salvage — is downstream and can be scheduled normally.

**What you can start on right now, in parallel, safely:** portraits, music, UI art, character writing, scene dialogue, and mission *layout* using the editor (map geometry survives a retune far better than encounter tuning does).

**What to hold:** terrain and environment art (wait for the MAP-03 vocabulary), and mission scripting content beyond dialogue (wait for Phase A).

The GDD's own definition of done is the right one, and it is worth restating because it is the correct target and it is not far away:

> The engine is story-production ready when a designer can author Grayfield, Warner Collapse and Transmission entirely through mission data plus registered generic handlers, without editing the React renderer or adding mission-id conditionals to simulation code.

The engine already refuses mission-id conditionals — the architecture audit enforces it. What is missing is the other half: enough generic handlers for a designer to say something interesting. That is the work.
