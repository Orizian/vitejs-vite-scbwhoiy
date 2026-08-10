# STATUS ZERO

A long-form tactical RPG built on a deterministic, data-driven battle engine.

```bash
npm install
npm run dev       # main menu at http://localhost:5173/ , editor also at /editor.html
npm run editor    # opens the editor directly
npm test          # runs the full suite headlessly (needs a dev server on :5173)
npm run check:menu        # browser acceptance: the front door, menu to base to editor
npm run check:scene       # browser acceptance: authoring, previewing and exporting a scene
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
| `src/App.jsx` | Content, engine, presentation adapter, UI and the 453-test suite. Everything below the `EDITABLE CONTENT ABOVE / ENGINE BELOW` divider is renderer-free and knows no concrete content id — `auditArchitecture()` enforces that on every run. |
| `src/content/missions/*.json` | Mission files. Drop one in and it is in the game. |
| `src/content/mission-format.js` | Mission schema, validator and compiler. Shared by the game and the editor. |
| `src/content/mission-registry.js` | Loads mission files and the editor's playtest slot into the content registry. |
| `src/content/catalog.js` | The content vocabulary the editor may place. Mirrors `App.jsx`; a drift test keeps it honest. |
| `src/mission/` | The mission scripting runtime: event stream, trigger/condition vocabulary, action registry, phase state machine and faction relationships. Engine-agnostic; App.jsx supplies an adapter. |
| `src/reactions/` | The reaction and combat-link framework: event stages, trigger/condition/effect registries, reaction economy, shared pools and relationship links. Engine-agnostic; App.jsx supplies an adapter. |
| `src/perception/` | Faction-scoped battlefield knowledge: observation channels, the unseen/suspected/acquired model, the sensor sweep, decay and the believed world the AI reasons over. Engine-agnostic; App.jsx supplies an adapter. |
| `src/scene/` | The authored-scene format: the step vocabulary, validation, serialization and the pure stage fold the player and the editor both run. |
| `src/content/scenes/*.json` | Authored scenes. Drop one in and missions can reference it by id. |
| `src/editor/` | The editor: missions and scenes. Imports the formats and the registries, never the game. |
| `public/assets/` | Art, music and fonts, addressed by convention. Missing files fall back to readable placeholders — no game rule ever depends on an asset existing. |

## Documentation

- **[`docs/ENGINE_ANALYSIS.md`](docs/ENGINE_ANALYSIS.md)** — audit against the design bible: what is built, what is missing, what to build first, and why.
- **[`docs/MISSION_FORMAT.md`](docs/MISSION_FORMAT.md)** — the mission file format and the authoring workflow.
- **[`docs/MISSION_SCRIPTING.md`](docs/MISSION_SCRIPTING.md)** — phases, triggers, actions, factions and groups: how a battle changes shape mid-mission.
- **[`docs/REACTIONS.md`](docs/REACTIONS.md)** — out-of-turn reactions, the reaction economy, and the combat-link framework behind Section Seven.
- **[`docs/SCENES.md`](docs/SCENES.md)** — the scene format, the timeline editor, and why previewing from step 37 lands in the same world as playing to it.
- **[`docs/PERCEPTION.md`](docs/PERCEPTION.md)** — what each faction believes, why the AI cannot cheat, and the architecture Nyx's stealth kit will consume.

## Starting the game

The application opens on the **main menu**.

| | |
|---|---|
| **Continue** | Resumes the saved campaign. Disabled, with a reason, when there is nothing to resume. |
| **New Game** | A fresh campaign. Nothing is written to disk until you save, so backing out costs nothing — if a save already exists it asks first. |
| **Editor** | Missions and scenes, mounted in place. Authoring only; it cannot touch a campaign. |
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
```

A mission points at a scene by id (`preMissionScene`, `postMissionScene`); a scene needs no mission at all.

The editor validates live against what the engine can actually do, and tells you when a trigger or action you have authored is not implemented yet rather than letting it silently never fire.
