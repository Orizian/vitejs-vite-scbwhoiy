# Gameplay data

Every number the simulation reads, as files you can edit without opening source.

- Files: `src/content/gameplay/*.json` — **the game's actual input**, not a mirror
- Format and serializer: `src/content/gameplay/format.js`
- Loader and draft overlay: `src/content/gameplay/registry.js`
- Editing schema: `src/content/gameplay/schema.js`
- Cross-registry rules: `src/content/gameplay/validate.js`
- Export / import: `src/content/gameplay/exchange.js`
- Test arena resolution: `src/content/gameplay/arena.js`
- Studio: `src/editor/GameplayStudio.jsx` · Acceptance: `npm run check:gameplay`

---

## One source of truth

```
   src/content/gameplay/*.json          ← authored, checked in, diffable
             │
             ▼
      parseRegistryFile()
             │
    ┌────────┴─────────┐
    ▼                  ▼
CANONICAL_GAMEPLAY   + draft overlay (only if the Studio wrote one)
                       │
                       ▼
                 GAMEPLAY_CONTENT
                  │        │        │
                  ▼        ▼        ▼
             App.jsx    catalog.js   Studio
             CONTENT   (map editor)  (editing + export)
```

There is no editor-side database. The Studio reads `CANONICAL_GAMEPLAY`, which is
parsed from the same files `App.jsx` builds `CONTENT` from. `catalog.js` — the
mission editor's vocabulary — is **derived** from those files too, so a unit
created in the Studio is immediately placeable on a map with no second edit.

Three things make this hold rather than merely being true today:

- `serializeRegistryFile` is the only writer. The migration, the exporter and
  the checked-in files all go through it, so unmodified data exports
  byte-identically to what is on disk.
- `catalogDriftIssues()` checks both directions for every derived registry. An
  entity the engine has and the files do not is an error, not a curiosity.
- A test asserts every key present in the data is declared in the schema, so
  nothing can be authored-but-invisible.

---

## The registries

| Registry | File | What it owns |
|---|---|---|
| Units | `units.json` | Frames: stats, resource pools, native abilities, AI profile, sensors, default loadout |
| Abilities | `abilities.json` | Targeting, timing, costs, conditions, ordered effects |
| Equipment | `equipment.json` | Weapons, armour, utility and core systems; slot, compatibility, modifiers, granted abilities |
| Statuses | `statuses.json` | Timed conditions: duration, modifiers, triggers, behaviour flags |
| AI profiles | `ai-profiles.json` | Scoring weight vectors |
| Operators | `operators.json` | Playable pilots: identity, stable `ref`, chassis, perk choices |
| Perks | `perks.json` | Progression choices, as stat modifiers |
| Terrain | `terrain.json` | Tile rules **and** the map editor's swatch: cost, walkability, sight, modifiers, `char`, `paint` |
| Resources | `resources.json` | Every pool of points a battle tracks: unit-scoped and faction-scoped, with regeneration and link gating |
| Reactions | `reactions.json` | Out-of-turn responses as WHEN / IF / THEN |
| Combat links | `combat-links.json` | Operator relationships that unlock shared reactions |

An entity's key **is** its id. It is never repeated inside the entity, and it is
what missions, combat links, reactions and saves address. A display name may
change freely; an id may not, except as a deliberate migration.

### Data parameters vs engine behaviour

The schema marks fields `behaviour: true` when they *select* engine code rather
than define it — an ability's `effects[].type`, a status's `preventsAction`, a
unit's `aiProfile`. The Studio shows those as selectors and says so. You can
change which behaviour runs; you cannot write a new one here. That boundary is
deliberate and there is no free-text formula or code field anywhere in the
Studio.

### Derived values, stated as derived

Some things look authored and are not. The Studio shows them read-only, with the
rule that produces them, rather than offering a box the loader would overwrite:

- **Art.** Every unit, ability, status, equipment and terrain asset id is
  generated from the entity's own id, and the file is found by convention at
  `public/assets/<kind>/<id>/…`. There is no asset id to type. (The old
  `assets` field was removed from the files during this phase precisely because
  the loader overwrote it.)
- **Composed stats.** The Studio's derived-values panel calls
  `window.STATUS_ZERO.composeUnitPreview`, which runs the engine's own
  `calculateUnitStats`. There is no second calculator.
- **Terrain movement cost for impassable tiles.** The file writes `null`
  because JSON has no `Infinity`; `engineTerrain()` restores it. `walkable`
  remains the authoritative flag.

---

## The workflow

```
  edit in the Studio  →  validate (live)  →  Test Unit  →  Export changes
        →  hand the bundle to a Claude Code session  →  canonical files updated
```

### Edit

Three columns: registry tabs, a filtered library, then overview and a
schema-driven inspector. The inspector contains no entity ids — it renders
whatever `REGISTRY_SCHEMAS[kind].sections[].fields` declares, which is why
adding a field to a registry needs no editor change.

Changes are tracked per entity against canonical, semantically: re-serializing
or reordering keys is not a change. `Changes (n)` lists them; each can be
opened, compared field-by-field, or reverted.

### Draft isolation

Three separate places, on purpose:

| Slot | Key | Who reads it |
|---|---|---|
| Studio working draft | `statuszero.gameplay.editorDraft` | the Studio only |
| Test overlay | `statuszero.gameplay.draft` | the content registry, at import |
| Canonical files | `src/content/gameplay/*.json` | everything |

The Studio never writes canonical files — export is the only way data reaches
the repository. The test overlay is written only by Test Unit, is announced by
a **DATA TEST** banner in battle and on the main menu, and is cleared by
leaving the test. Nothing here can touch a campaign save.

### Test

`Test Unit` resolves the selection to something that can actually be deployed,
writes the overlay, and opens the arena (`fixture-test-arena`) in a new tab
through the ordinary playtest path — same registry, same compiler, same engine.

The reload is the mechanism, not a workaround: `CONTENT` is built once at import
and frozen, which is a property worth keeping, so a draft can only reach the
simulation on a load that happens after it was written.

Not everything is deployable, so the arena says who it fielded and why:

| Selection | What the arena deploys |
|---|---|
| Unit | that unit, default loadout |
| Operator | the operator's chassis (perks are campaign progression, not applied) |
| Equipment | a compatible chassis with the part fitted, preferring one that already fields it |
| Ability | the first unit that knows it, else a chassis carrying equipment that grants it |
| Status | the subject for the first ability that applies it |
| AI profile | a unit running it, placed **opposite** you |
| Perk | the owning operator's frame, with the same caveat |
| Terrain | refused — paint it into a map and playtest that instead |

Resolution is deterministic (registries are walked in id order) and a refusal is
always a sentence you can act on.

### Export

`Export changes` produces only the registries you touched. `Export full`
produces all of them. Both emit **whole, valid registry files** — a partial
registry file is not something the game could load or a person should have to
merge — plus:

- `manifest.json` — every entity, its registry, its operation (`add` /
  `modify` / `delete`), and the repository path it belongs to
- `README.md` — the same in prose, with integration instructions

The bundle is one text document with unambiguous file boundaries, so it can be
pasted into a session, read without tooling, and diffed. It carries **no
timestamp**: two exports of the same authored state are identical bytes, which
is what makes "has anything actually changed?" answerable.

### Handing it to Claude Code

Paste the bundle and ask for it to be applied. The README already says what to
do, but the short version is: each included file is a complete canonical
registry file, already in the project's deterministic format, so a whole-file
replacement is intended and safe. Then `npm test`, `npm run check:gameplay`,
`npm run build`.

Deletes need one extra thought — `referencesTo()` reports what points at an
entity, and the Studio refuses a delete that would break a reference.

### Import

`Import…` reads a bundle back **as a draft**, never as an install. It is
something to inspect, validate and test; accepting it is a separate act
(exporting it, or testing it). Canonical files are untouched by an import.

---

## Validation

`validateGameplayData(data, context)` runs live in the Studio and blocks export
while any error stands. It covers:

- id shape, and that every entity is an object
- unit → ability, AI profile and equipment references
- default loadouts: slot correctness and class compatibility
- ability → status and summoned-unit references
- equipment slots, modifier shape, granted/removed abilities
- status durations and modifier key vocabulary
- operator → chassis and perk references, and duplicate stable `ref`s
- perception channels on units and equipment
- terrain: one-character map glyphs, no duplicates, hex swatches, movement cost
  present exactly when the tile is passable
- external references, when the caller supplies them: mission unit ids, combat
  link ids, reaction-applied statuses

Warnings (missing display names, missing art) do not block. Missing artwork is a
normal state for content in progress and the project's standing policy is kept
rather than reinvented.

---

## Tests

| What | Where |
|---|---|
| Format, diff, bundle, arena, composition — 12 tests | `Gameplay data` group in `App.jsx`, run by `npm test` |
| The whole workflow in a browser — 41 checks | `npm run check:gameplay` |
| Catalog derivation is complete | `catalogDriftIssues()`, asserted by the suite |

The unit tests defend the properties the workflow rests on: serialization is
canonical, stable and lossless; the shipped files are already canonical; the
engine and the files agree; the diff is semantic; a changes export names every
entity and ships whole files; export and import round trip exactly; a full
export of unmodified data reproduces the shipped files byte for byte; the schema
describes every authored field; every entity resolves to something the arena can
field; the arena mission stays valid after a swap; the Studio reads derived
values from the engine; and a draft reaches the game only through the load-time
overlay.

---

## Remaining debt

Still edited in source. None of it is blocked by the architecture above — each
is the same shape of work: extract the literal to JSON, add a schema, add
validation.

| What | Where | Why not yet |
|---|---|---|
| Campaign structure: mission list, rewards ("loot"), chapters, base stages, facilities, contacts | `CAMPAIGN` in `App.jsx` | This is the campaign graph, explicitly out of scope for this phase. Mission rewards are the piece most worth pulling out next. |
| Campaign dialogue and speakers | `CAMPAIGN.dialogue`, `SPEAKER_CATALOG` | Narrative, not gameplay data — it belongs to the Scene editor, and putting it here was explicitly ruled out. |
| Equipment slot list | `GAME_CONFIG.equipment.slots` | Engine configuration. Adding a slot changes the composition pipeline, not just data. |
| Unit classes | implicit in `classId` strings | There is no class registry; `classId` is a free string matched against `compatibleClasses`. A small `classes` registry would let the Studio offer a dropdown and catch typos. |
| Balance formulas and engine tuning | `FORMULAS`, `GAME_CONFIG` | Out of scope: these are the algorithms, not their inputs. |
| Scene backgrounds, expressions, music contexts | `catalog.js` | Presentation vocabulary for the Scene editor. |

Reactions, combat links and resources joined this architecture in the combat
orchestration phase — see [`docs/COMBAT_ORCHESTRATION.md`](COMBAT_ORCHESTRATION.md).
`src/content/reactions.js` survives only as a thin adapter that turns the
id-keyed registries into the ordered lists the reaction runtime indexes.

One structural note: `catalog.js` is no longer a mirror for units, abilities,
statuses, equipment, AI profiles or terrain, but it is still hand-written for
the scene and speaker vocabulary above. When those move, the file can go.
