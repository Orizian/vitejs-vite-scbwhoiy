# Scenes

Authored narrative, as content rather than code.

A scene is an ordered list of steps. That is the entire model — no graph, no branching, no scripting language. Reading a scene top to bottom tells you exactly what happens, in order, which is what lets the timeline editor and the runtime agree without either knowing about the other.

- Format: `src/scene/format.js` · Step vocabulary: `src/scene/steps.js` · Legacy adapter: `src/scene/legacy.js`
- Content: `src/content/scenes/*.json` · Registry: `src/content/scene-registry.js`
- Player: `ScenePlayer` in `src/App.jsx` — the game's, and the editor's preview
- Editor: `src/editor/SceneEditor.jsx` · Acceptance: `npm run check:scene`

---

## One representation

```
   src/content/scenes/*.json
             │
             ▼
      normalizeScene()  ─────────────▶  the scene
             │                              │
     ┌───────┴────────┐            ┌────────┴────────┐
     ▼                ▼            ▼                 ▼
  editor timeline   validation   ScenePlayer     mission hooks
```

There is no `editorScene` and no `gameScene`. The document the editor edits is the document `serializeScene` writes and the document the player runs. The only thing the editor adds is a `key` on each step to keep a React list stable while reordering — and that is deliberately **not** written to disk, so two equivalent scenes produce byte-identical files.

---

## Steps

| Step | Fields | Blocking |
|---|---|---|
| `dialogue` | speaker, text, expression?, position? | **yes** |
| `characterEnter` | character, position, expression? | no |
| `characterExit` | character | no |
| `expression` | character, expression | no |
| `background` | background, label? | no |
| `music` | mode (play/stop), context?, track? | no |
| `clear` | — | no |
| `end` | — | no |

**Only dialogue blocks.** The runtime runs presentation steps until it reaches a line, so a background change, a music cue and two characters walking on all land in the same beat rather than costing the player four clicks.

Speaking puts a character on stage. An author who writes a line for someone they never walked on gets the obvious result rather than an invisible speaker.

### Adding a step type

One entry in `SCENE_STEP_TYPES`:

```js
screenShake: {
  label: "Screen shake",
  summary: (step) => step.strength + " for " + step.duration + "ms",
  blocking: false,
  fields: [{ key: "strength", label: "Strength", kind: "enum", options: ["light", "heavy"] }],
  defaults: () => ({ strength: "light" }),
  validate: (step) => (step.strength ? [] : ["needs a strength."]),
  apply: (stage, step) => ({ ...stage, shake: step.strength })
}
```

Neither the editor nor the player has a switch on step type. The timeline renders `summary`, the inspector renders `fields`, validation calls `validate`, the runtime calls `apply`. A test asserts this — it walks the palette and fails if any type is missing a piece, or uses a field kind the inspector does not know.

---

## The fold, and why Play from here is exact

The stage at any step is a **pure left fold** over the steps before it:

```js
stageAt(scene, 37)        // reconstruct
advanceScene(scene, 0…)   // or get there by playing
```

Those two must produce the same world, and a test asserts it at every stopping point of the acceptance scene rather than assuming it. That is the whole reason `Play from here` exists: there is no hidden state, no animation to unwind, no "you had to be there". If a future step type introduces state that cannot be reconstructed, that test is where it will be caught.

---

## Authoring

```
Editor → Scenes
  library  ·  which scene
  timeline ·  what happens, in order
  inspector·  the fields of the selected step
```

Steps can be added, selected, edited, duplicated, deleted, moved up and down, and inserted above or below. Reordering is buttons rather than drag-and-drop — reliable beats fashionable, and the spec preferred it that way.

**Dialogue is optimised, because dialogue is most of it.** With a line selected, **Ctrl/⌘+Enter** in the text box adds the next line below, inherits the previous speaker and portrait side, and focuses the new text box. So a two-hander is: type, Ctrl+Enter, change speaker, type. The inherited values are written into the step like any other field — the saved document never depends on knowing the shortcut existed.

Characters, expressions and music contexts are dropdowns from the shared catalog. Backgrounds are a dropdown you can also type into, because writing runs ahead of art.

**Preview** runs the scene in `ScenePlayer` — the actual game player, not a lookalike. Inside the editor that is a route switch with the draft handed straight across, so what you see is what is on screen right now. Standalone (`editor.html`) it opens the game in a new tab, the same way mission Playtest does.

---

## Validation

Errors block export; warnings do not. Every problem names the step by its position in the timeline, because that is how the author is looking at it:

```
Step 14 — Dialogue references unknown character "vlae".
Step 4 — Character enters has an unknown position "overhead" (expected left, center, right).
```

| Checked | |
|---|---|
| scene id | present, a stable slug, not duplicated |
| step types | known |
| characters | in the speaker catalog |
| expressions | in the expression catalog |
| positions | left / center / right |
| music | a known context, or an explicit track |
| dialogue | has a speaker and has text |
| structure | not empty; nothing stranded after `end` |

**Missing art warns rather than blocking.** A background with no asset convention yet is a normal state for a scene in progress, and the asset layer already renders a readable placeholder. Nothing is silently repaired.

---

## Standalone and mission scenes

A scene needs no battle, no map and no mission. `act1-warner-arrival` is entirely dialogue and presentation; it runs from the registry with nothing else loaded. That is what makes base conversations, flashbacks, act transitions and antagonist scenes ordinary content.

Missions reference scenes **by stable id**, never by embedding them:

```jsonc
{
  "preMissionScene": "act1-warner-arrival",
  "postMissionScene": null
}
```

`preMissionScene` plays before the briefing; `postMissionScene` plays on the way out of the results screen. A mission naming a scene that does not exist fails validation at load, not at the moment a player would have watched it.

### What stays in mission scripting

In-battle lines are **not** scenes. An enemy identified, an objective reached, a civilian found, a reinforcement arriving, an HP threshold, a knowledge change — those are mission beats and reactions, which fire in context and do not take over the screen. The distinction:

| | |
|---|---|
| **Scene** | authored sequence; presentation temporarily has control |
| **Mission scripting** | contextual events during tactical play |

Both eventually draw through the same dialogue presentation. Neither is a second format for the other.

---

## Legacy content

Missions already carried narrative in an older shape: a scene was a title, a location and a flat list of `{ speaker, text }`, with optional choices. That format is a **strict subset** of steps — a line is a `dialogue` step, a location is a `background` step — so it needed an adapter, not a second runtime.

`sceneFromLegacy()` lifts one. The direction is one-way on purpose: new authoring produces steps, and nothing converts steps back into lines, because that would throw away everything the older format cannot say.

**What was migrated:** nothing wholesale. The adapter is proven by tests, and a test walks every legacy scene in every shipped mission asserting each one is either liftable or has a named reason it is not. Rewriting existing missions purely for tidiness is not worth the churn while their briefing/victory/defeat sequences work.

**What is deliberately still legacy:** scenes with `choices`. Branching is out of scope for this phase, so those keep being played by `StorySequenceScreen`. `legacySceneBlocker()` reports why, and the migration test fails if a legacy scene is ever left behind without a reason.

---

## Not built yet

Deliberately absent, and none of it requires the format to change:

| | |
|---|---|
| choices in scenes | branching stays in the legacy sequence screen for now |
| camera moves, screen shake, portrait animation | new step types; the registry is the whole extension point |
| flag writes, knowledge updates, battle transitions from a scene | steps whose `apply` reaches outside the stage |
| wait / timed pause | the runtime blocks only on dialogue today |
| sound effects | there is no SFX registry to reference yet |
| localization, voice | out of scope |
| drag-to-reorder | up/down is reliable; drag is a refinement |

The one real constraint worth knowing: a step's `apply` currently returns stage state and nothing else, so a step that must change campaign flags or launch a battle needs a second channel out of the fold. That is a deliberate boundary, not an oversight — it keeps `Play from here` honest.
