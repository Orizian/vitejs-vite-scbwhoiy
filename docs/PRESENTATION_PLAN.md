# Presentation Sequence Engine — audit and plan

An audit of what the repository already has against the Presentation Sequence
Engine specification, and a restructured phase plan.

Measured at commit `fccf8f7`: 735 unit tests, 15 browser suites, App.jsx at
44,610 lines.

---

## 1. The headline

**More of this exists than the specification assumes, and the pieces that
exist are the load-bearing ones.**

The project already translates resolved combat events into presentation events
through a pure function, already drives them through a sequential queue with
per-step durations and a completion callback, and already gates the combat loop
on that queue finishing. That is a primitive sequence runner. What it lacks is
that the sequences are *hard-coded in a switch statement* rather than authored.

Three things do not exist in any form: **animation clips**, **sound effects**,
and **music cue control**. Those are the real cost of this specification, and
two of the three are as much an art-pipeline question as a code one.

One structural fact dominates the schedule: **the entire presentation layer
lives in App.jsx, which is 44,610 lines.** A sequence runner, a director, a
timeline editor, an audio bus, a VFX layer and a layer-compositing renderer
cannot be added to that file. The extraction that was already next on the
roadmap is now a prerequisite rather than a cleanup.

---

## 2. Audit — what exists

### Already there, and directly reusable

| Spec section | What the repo has | Where |
|---|---|---|
| §3 pipeline | `engineEventToPresentationEvents(event, before, after)` — pure, tested, translates resolved events into presentation events | `App.jsx` |
| §3 runner | `playPresentation(events, onDone)` plus a queue driver that walks one event at a time with `presentationEventDuration(event, timing)` | `App.jsx` |
| §6 *fixed* timing | `presentationEventDuration` is exactly the fixed mode, scaled by speed | `App.jsx` |
| §12 camera | `createCameraState` · `panCamera` · `fitCameraToMap` · `focusCameraOnTile`, all pure; zoom bounds and step in config | `App.jsx` |
| §26 speed | `GAME_CONFIG.presentation.speeds` (`normal` 1, `fast` 0.5, `instant` 0) and `getAnimationTiming(speedId)` | `App.jsx` |
| §18 music | `MusicTrackPlayer` / `AppMusicPlayer`: real `<audio>`, candidate list, volume, browser unlock handling, request object | `App.jsx` |
| §23 dialogue | `ScenePlayer` and the scene step registry — schema-driven, with an editor and a preview | `src/scene/`, `src/editor/SceneEditor.jsx` |
| §4 assets | `presentationAssets` registry, frozen, id-derived, with `validateAssetReferences` and glyph fallback | `App.jsx` |
| §28 determinism | The project's central discipline. Seeded RNG with counter assertions, "preview must not roll" tests, planner/applier separation everywhere | throughout |
| §31 validation | Four content validators with a shared error/warning convention and a Studio that blocks export on errors | `src/content/gameplay/validate.js` |
| §41 slice content | Kell's reaction (`sectionSevenMarkShot`) already exists mechanically | `reactions.json` |

**The scene editor is the closest existing analogue to the Presentation
Editor.** It is a step registry driving a schema-generated inspector, with
preview-from-here and round-trip export. The Presentation Editor is that plus a
time axis.

### Does not exist in any form

| Spec section | Gap | Cost |
|---|---|---|
| §14 animation | No clips. Units are directional sprites with glyph fallback. No clip registry, no animation events (`fire`, `impact_window`, `complete`) | **Large** — and art-dependent |
| §17 SFX | Nothing. Zero sound effects. The only audio in the repository is one `<audio>` element for music | **Medium** |
| §18–22 music director | Track-level play only. No cue markers, no duck, no seek, no transition, no `returntomusic_*` | **Medium** |
| §13 layers | The battlefield is one React tree. No per-layer dim/opacity/blur/silhouette | **Medium** — a renderer refactor |
| §15 VFX/impact | `pushBattleEffect` shows transient DOM effects. No hitstop, freeze, shake, impulse, projectile tracking | **Medium** |
| §16 cut-ins | Nothing | **Small** once layers exist |
| §5 editor | Nothing | **Large** |
| §7 CONTINUE ACTION | Presentation runs strictly *after* full resolution, all at once | **Small** — see §3 below |
| §8–11 director | The event→presentation mapping is a `switch`. No context object, no priorities, no fallback chains, no final-blow detection | **Medium** |
| §27 skip | No skip. (`instant` speed is close but is not a mid-sequence skip) | **Small** |
| §30 preview sandbox | Nothing | **Medium** |

---

## 3. The four findings that shape the plan

### CONTINUE ACTION is much cheaper than it looks

The specification reads as though presentation must interleave with combat
resolution. It does not. The engine resolves the whole action *first* and then
hands over a list of presentation events. So `CONTINUE ACTION` never re-enters
the simulation — it is a **split point in an already-computed list**.

```
today      [resolve] → [all presentation events, played in order]

needed     [resolve] → [authored steps] → [the action's own events] → [authored steps]
                            before          ← CONTINUE ACTION →         after
```

The action's presentation events are held back and released when the sequence
reaches `CONTINUE ACTION`. This preserves determinism by construction: the
mechanical outcome was fixed before any presentation ran, which is exactly what
§28 demands and what makes §27's "skip produces identical gameplay state"
trivially true rather than a thing to be careful about.

### The runner must be a planner, not a coroutine

Timing-based code is hard to test, and this project's entire quality story
rests on headless determinism. Every successful subsystem here — trajectory,
propagation, sequencing, rewards — split into a **pure planner** and a thin
applier.

The sequence runner must do the same:

```
planSequence(sequence, context, assetIndex) → a schedule
    [ { at: 0.00, step: dimBattlefield, mode: "transition", until: 0.10 },
      { at: 0.10, step: focusCamera,    mode: "fixed",      until: 0.60 },
      { at: 0.60, step: continueAction, mode: "waitEvent",  event: "impact" }, … ]
```

A schedule is data. It can be asserted on headlessly — total duration, step
ordering, that `CONTINUE ACTION` appears exactly once, that the camera is
restored, that music resolves — without a clock, a browser or a screenshot.
The React layer only *executes* a schedule. Waits for events (`impact`,
`targetDeathComplete`, `dialogue_complete`) resolve at execution; the schedule
records that they are waits.

**This is the single most important architectural decision in the plan.**
Without it, presentation becomes the one part of this codebase that cannot be
tested, and the §31 validation list (unreachable step, camera never restored,
music unresolved) becomes unimplementable.

### The renderer needs layers before most primitives are possible

§13's isolation effect — terrain, environment, non-focus units and UI all to
zero opacity while two units stay lit — is not a filter over a flat tree. The
battlefield must become explicitly composited layers with a presentation state
each. Camera focus, dim, blur, silhouette, cut-in placement and hide-UI all
depend on it. It should be scheduled once, early, rather than approximated five
times.

### Animation is the real unknown

Everything else is bounded engineering. Animation clips are a pipeline
decision that has not been made: frame sequences? sprite sheets? per-direction
variants? And §14 wants clips to emit events (`fire`, `impact_window`) that
sequences synchronise against.

With no art in the repository today, this must follow the project's existing
discipline — **path-convention discovery with graceful fallback**, exactly as
unit portraits already work. A missing clip degrades to the current sprite
behaviour and the sequence still runs. §9's fallback chains apply the same
principle to sequences themselves. Unfinished art must never break a mission.

---

## 4. Restructured phase plan

The previous roadmap was *Mission Content Extraction → App.jsx Extraction →
theme/project*. Presentation is now a pillar comparable in size to the tactical
engine, which took seven phases. The specification's own six-phase order is
sound; it needs one prerequisite in front and a different seam between two of
its phases.

### P1 — Presentation extraction and asset kinds *(prerequisite; no new features)*

Move the presentation layer out of App.jsx: the event adapter, the queue
driver, camera state, the battlefield renderer, the HUD. Extend the asset
registry with the kinds the later phases reference — animation clips, sound
effects, cut-ins, music tracks — with path-convention discovery and fallback,
but no playback yet.

*Ends with:* identical behaviour, App.jsx materially smaller, `src/presentation/`
existing, asset kinds authored and validated.

**This is the App.jsx extraction that was already next, with a better reason.**

### P2 — Sequence runtime and CONTINUE ACTION *(spec Phase 1)*

The presentation resource schema. `planSequence` as a pure planner producing a
schedule. All six timing modes. The context object (§8). `CONTINUE ACTION` as a
split point. A **minimal explicit hook** — an ability or reaction names a
sequence id — so the slice is provable in a real battle immediately.

*Ends with:* one authored sequence bracketing a real reaction, in a real
mission, with the mechanical outcome provably unchanged.

### P3 — Layers, camera and core primitives *(spec Phase 2, minus SFX)*

Battlefield layer compositing. Dim, opacity, tint, blur, silhouette, hide/show.
Camera focus/pan/snap/zoom/shake/impulse/restore as sequence steps. Hitstop,
freeze frame, impact frame. Animation clip playback with clip events. Speed
override and restore.

*Ends with:* Kell's basic sequence working end to end, silent.

### P4 — Audio bus: SFX and the music director *(spec Phase 3, plus SFX)*

The specification puts SFX in Phase 2 and music in Phase 3. They need the same
bus — mixing, volume, unlock, preload — so they belong together. Cue metadata,
duck, seek, transition, and the `returntomusic_*` policies including the
context-sensitive form in §21.

*Ends with:* the acceptance scenario audible — music ducks to silence, rifle
cock, glint, and the track returning at `climax` or `resolution` by context.

### P5 — Presentation Editor and preview sandbox *(spec Phase 4)*

A fifth editor mode. Track-based timeline, step inspector, asset browser,
context simulator, event log, instant preview against a sandbox arena. Built on
the scene editor's step-registry pattern.

*Ends with:* a sequence authored, timed and previewed without running a
mission, and without touching JSON.

### P6 — Presentation Director *(spec Phase 5)*

Priority levels P0–P4. Actor presentation profiles with fallback chains.
Major-kill and final-blow detection. Context-driven resolution, replacing P2's
explicit hook.

*Ends with:* every operator automatically receiving a cinematic final blow with
no mission or ability naming a sequence.

### P7 — Cut-ins, dialogue, nesting, skip *(spec Phase 6)*

Cut-in assets and commands. Dialogue inside the tactical scene. Nested
sequences with cycle detection. Skip and the flourish accessibility setting.

*Ends with:* the full §41 acceptance scenario, all 25 steps.

### Deferred, unchanged

Mission content extraction (12 prototype missions still have literal maps and
encounters) · campaign currency generalization · mission-board replay UI ·
theme layer · project switching. None blocks presentation.

---

## 5. Scope checks and pushback

**§26 speed vocabulary.** The spec says 1×/2×/4×; the repo stores duration
*scales* (`fast` = 0.5). Same concept, inverted. Reconcile once in P1 rather
than translating at every call site.

**§22 beat-synced transitions.** Correctly marked not-required for v1. Agree —
defer entirely. Cue markers alone deliver §19–21.

**§28 save safety.** Recommend option 1: disallow saving during a sequence.
The battle save is already tied to resolved state, and sequences are short.
Option 2 buys nothing for meaningful cost.

**§24 conditional steps.** Keep to the closed vocabulary the spec lists
(`critical`, `lethal`, `targetIsBoss`, `missionWillComplete`, …). The tactical
engine already has a closed condition registry and this project has repeatedly
found that a small validated vocabulary beats an expression language.

**§32 hooks.** Adding seven presentation slots to abilities, four to reactions,
six to units and five to missions is a large authored surface that will mostly
stay empty. Recommend adding hooks **per phase, as their primitives land**,
rather than all at once in P2 — otherwise the schema advertises capability that
does not exist.

**One genuine risk not in the spec.** The presentation layer must never touch
`state.randomState`. The tripwire and architecture audit should be extended in
P1 to assert that `src/presentation/` cannot import the engine's mutation
surface at all — the same probe-verified discipline used for `src/combat/` and
`src/campaign/`.

---

## 6. Sizing

| | |
|---|---|
| P1 extraction + asset kinds | large, low risk, mechanical |
| P2 sequence runtime | medium, **highest architectural leverage** |
| P3 layers + primitives | large, medium risk (renderer refactor, animation unknown) |
| P4 audio bus | medium, low risk, entirely new code |
| P5 editor | large, low risk, established pattern |
| P6 director | medium, low risk |
| P7 polish | medium, low risk |

Seven phases. The tactical engine took seven and this is a comparable pillar.

The two that decide whether the rest goes well are **P2** — because a pure
planner is what makes presentation testable — and **P3**, because the animation
pipeline decision is the only genuine unknown and everything visual sits on the
layer model.

---

## 7. Recommendation

Start with **P1**, and treat it strictly as extraction: no new capability, no
behaviour change, all 735 tests and 15 browser suites green throughout. It is
the phase that makes the other six possible, and it is work the roadmap already
called for.

Before P3, make the animation pipeline decision explicitly — clip format,
directional variants, event emission, fallback — because P3, P5 and P7 all
depend on it and it is the one item here that cannot be resolved by reading the
existing code.
