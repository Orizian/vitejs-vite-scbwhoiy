# STATUS ZERO

A long-form tactical RPG built on a deterministic, data-driven battle engine.

```bash
npm install
npm run dev       # main menu at http://localhost:5173/ , editor also at /editor.html
npm run editor    # opens the editor directly
npm test          # runs the full suite headlessly (needs a dev server on :5173)
npm run check:menu        # browser acceptance: the front door, menu to base to editor
npm run check:scene       # browser acceptance: authoring, previewing and exporting a scene
npm run check:gameplay    # browser acceptance: edit a stat, test it, export it, import it back
npm run check:orchestration  # browser acceptance: the reaction chain, Command Points, timeline
npm run check:trajectory  # browser acceptance: routes, precise displacement, the synergy chain
npm run check:cascade     # browser acceptance: arc propagation and the grouping payoff
npm run check:grayfield   # browser acceptance: mission scripting end to end
npm run check:reactions   # browser acceptance: Section Seven + Grayfield link restore
npm run check:knowledge   # browser acceptance: the contact lifecycle, unseen to cold
npm run check:questions   # verifies the AI cannot read a hidden unit's real position
npm run bench:knowledge   # A/B the knowledge layer inside one build
npm run test:serve  # same, but starts and stops vite for you
npm run build     # builds both entry points
npm run lint
```

## Where things are

| | |
|---|---|
| `src/App.jsx` | Content, engine, presentation adapter, UI and the 555-test suite. Everything below the `EDITABLE CONTENT ABOVE / ENGINE BELOW` divider is renderer-free and knows no concrete content id — `auditArchitecture()` enforces that on every run. |
| `src/content/missions/*.json` | Mission files. Drop one in and it is in the game. |
| `src/content/mission-format.js` | Mission schema, validator and compiler. Shared by the game and the editor. |
| `src/content/mission-registry.js` | Loads mission files and the editor's playtest slot into the content registry. |
| `src/content/gameplay/*.json` | Authored gameplay data: units, abilities, equipment, statuses, AI profiles, operators, perks, terrain. The game's actual input, edited by the Studio. |
| `src/content/gameplay/` | The format, loader, editing schema, cross-registry validation, export/import and test-arena resolution for that data. |
| `src/content/catalog.js` | The content vocabulary the editor may place. Derived from the gameplay files; a two-way drift test keeps the derivation complete. |
| `src/mission/` | The mission scripting runtime: event stream, trigger/condition vocabulary, action registry, phase state machine and faction relationships. Engine-agnostic; App.jsx supplies an adapter. |
| `src/reactions/` | The reaction and combat-link framework: event stages, trigger/condition/effect registries, the reaction economy and relationship links. Engine-agnostic; App.jsx supplies an adapter. |
| `src/combat/` | Combat orchestration primitives shared by everything above: one resource system (unit and faction scopes), the causal-chain model that bounds reaction cascades and explains them, the trajectory/displacement planner that describes a route without adding a second movement model, and the propagation planner that chains from target to target over live positions. |
| `src/perception/` | Faction-scoped battlefield knowledge: observation channels, the unseen/suspected/acquired model, the sensor sweep, decay and the believed world the AI reasons over. Engine-agnostic; App.jsx supplies an adapter. |
| `src/scene/` | The authored-scene format: the step vocabulary, validation, serialization and the pure stage fold the player and the editor both run. |
| `src/content/scenes/*.json` | Authored scenes. Drop one in and missions can reference it by id. |
| `src/editor/` | The editor: missions, scenes and gameplay data. Imports the formats and the registries, never the game. |
| `public/assets/` | Art, music and fonts, addressed by convention. Missing files fall back to readable placeholders — no game rule ever depends on an asset existing. |

## Documentation

- **[`docs/ENGINE_ANALYSIS.md`](docs/ENGINE_ANALYSIS.md)** — audit against the design bible: what is built, what is missing, what to build first, and why.
- **[`docs/MISSION_FORMAT.md`](docs/MISSION_FORMAT.md)** — the mission file format and the authoring workflow.
- **[`docs/MISSION_SCRIPTING.md`](docs/MISSION_SCRIPTING.md)** — phases, triggers, actions, factions and groups: how a battle changes shape mid-mission.
- **[`docs/REACTIONS.md`](docs/REACTIONS.md)** — out-of-turn reactions, the reaction economy, and the combat-link framework behind Section Seven.
- **[`docs/SCENES.md`](docs/SCENES.md)** — the scene format, the timeline editor, and why previewing from step 37 lands in the same world as playing to it.
- **[`docs/PERCEPTION.md`](docs/PERCEPTION.md)** — what each faction believes, why the AI cannot cheat, and the architecture Nyx's stealth kit will consume.
- **[`docs/GAMEPLAY_DATA.md`](docs/GAMEPLAY_DATA.md)** — the authored gameplay registries, the Studio, and how a tuning change gets from a text box into the repository.
- **[`docs/COMBAT_ORCHESTRATION.md`](docs/COMBAT_ORCHESTRATION.md)** — resources, Command Points, causal chains, the reaction lifecycle, and how one operator's kill becomes another's opening.
- **[`docs/TRAJECTORY.md`](docs/TRAJECTORY.md)** — routes, redirects and their price, precise displacement the player aims, approach-distance scaling, and the interdictor frame authored on top of it.
- **[`docs/PROPAGATION.md`](docs/PROPAGATION.md)** — chains that walk from target to target over live positions, hop scaling and the kill cascade, and why moving one enemy two tiles creates a chain that did not exist.

## Starting the game

The application opens on the **main menu**.

| | |
|---|---|
| **Continue** | Resumes the saved campaign. Disabled, with a reason, when there is nothing to resume. |
| **New Game** | A fresh campaign. Nothing is written to disk until you save, so backing out costs nothing — if a save already exists it asks first. |
| **Editor** | Missions, scenes and gameplay data, mounted in place. Authoring only; it cannot touch a campaign. |
| **Settings** | The same Escape overlay the game uses — display scale, master and music volume. |

Escape opens Settings anywhere in the game, and offers **Return to main menu** once you are in a campaign.

Two things skip the menu on purpose: the editor's **Playtest** button, which boots straight into the battle you just painted, and `?boot=game` / `?boot=editor`, which is how a test harness asks for a screen by name.

## Authoring

```
npm run editor

MISSIONS  paint → place units → draw regions → set objective → beats
          ▶ Playtest   opens the game on this mission
          Export…      writes <mission-id>.json  →  src/content/missions/

SCENES    background → characters enter → dialogue → reaction → exit → end
          ▶ Preview       runs it in the game's own player
          ▶ From step N   starts there, with the stage reconstructed
          Export…         writes <scene-id>.json  →  src/content/scenes/

GAMEPLAY  pick a registry → pick an entity → change the number
DATA      ▶ Test Unit      drops it into the test arena, on the real engine
          Export changes   a bundle a Claude Code session applies to the repo
          Import…          reads a bundle back as a draft, never as an install
```

A mission points at a scene by id (`preMissionScene`, `postMissionScene`); a scene needs no mission at all. Gameplay data is shared by all of them: the units the mission editor places and the stats the battle reads are the same files the Studio edits.

The editor validates live against what the engine can actually do, and tells you when a trigger or action you have authored is not implemented yet rather than letting it silently never fire.
