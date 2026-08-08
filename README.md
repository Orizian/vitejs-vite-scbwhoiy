# STATUS ZERO

A long-form tactical RPG built on a deterministic, data-driven battle engine.

```bash
npm install
npm run dev       # game at http://localhost:5173/ , editor at /editor.html
npm run editor    # opens the mission editor directly
npm test          # runs the full suite headlessly (needs a dev server on :5173)
npm run test:serve  # same, but starts and stops vite for you
npm run build     # builds both entry points
npm run lint
```

## Where things are

| | |
|---|---|
| `src/App.jsx` | Content, engine, presentation adapter, UI and the 314-test suite. Everything below the `EDITABLE CONTENT ABOVE / ENGINE BELOW` divider is renderer-free and knows no concrete content id — `auditArchitecture()` enforces that on every run. |
| `src/content/missions/*.json` | Mission files. Drop one in and it is in the game. |
| `src/content/mission-format.js` | Mission schema, validator and compiler. Shared by the game and the editor. |
| `src/content/mission-registry.js` | Loads mission files and the editor's playtest slot into the content registry. |
| `src/content/catalog.js` | The content vocabulary the editor may place. Mirrors `App.jsx`; a drift test keeps it honest. |
| `src/editor/` | The standalone mission editor. Imports the mission format and nothing else. |
| `public/assets/` | Art, music and fonts, addressed by convention. Missing files fall back to readable placeholders — no game rule ever depends on an asset existing. |

## Documentation

- **[`docs/ENGINE_ANALYSIS.md`](docs/ENGINE_ANALYSIS.md)** — audit against the design bible: what is built, what is missing, what to build first, and why.
- **[`docs/MISSION_FORMAT.md`](docs/MISSION_FORMAT.md)** — the mission file format and the authoring workflow.

## Authoring a mission

```
npm run editor
  paint → place units → draw regions → set objective → write scenes and beats
  ▶ Playtest   opens the game on this mission
  Export…      writes <mission-id>.json
move it into src/content/missions/
```

The editor validates live against what the engine can actually do, and tells you when a trigger or action you have authored is not implemented yet rather than letting it silently never fire.
