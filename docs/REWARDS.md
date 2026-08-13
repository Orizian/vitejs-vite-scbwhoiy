# Rewards, drops and loot

What a mission pays, what a defeated enemy leaves behind, and how often either
may be collected.

- Pure module: `src/campaign/rewards.js`
- Registries: `src/content/gameplay/{materials,loot-tables}.json`
- Mission-side authoring: a `rewards` block, and `dropTableId` on a placement
- Adapter, sources and application: `src/App.jsx`
- Fixture: `src/content/missions/fixture-reward-bench.json`
- Acceptance: `npm run check:reward`

---

## Four words, kept apart

A single `rewards` array would have been shorter and would have made the three
questions a player actually asks unanswerable.

| | |
|---|---|
| **reward** | something granted because an outcome occurred |
| **source** | what caused it — a mission clear, or a defeated unit |
| **loot table** | a reusable authored definition of what a source can pay |
| **grant** | one concrete payment: currency, equipment or material |

*Why did I get this* is the source. *Can I get it again* is the claim policy on
the grant. *What do I have to kill for it* is the reverse index over tables.
Collapse the four and all three become guesswork.

---

## Determinism without state

The tactical engine has a seeded RNG, and loot deliberately does not use it.

`state.randomState` is a *stream*: a seed and a counter that advances every
time something rolls. Drawing loot from it would mean a drop depended on how
many dice the fight happened to consume — flank a unit twice instead of once
and the salvage changes — and reloading a finished attempt would reroll it,
because the counter is where it is only by virtue of history.

Every loot roll instead hashes a **key**:

```
missionId | attempt | sourceId | tableId | poolIndex | rollIndex
```

Every component is either authored or already persistent. There is no reward
RNG to save, no campaign seed had to be invented, and the acceptance run proves
the point directly: a battle that burned forty extra numbers out of the combat
stream produces a byte-identical receipt.

The attempt counter is the load-bearing part, and it already existed —
`beginMission` has always incremented `campaign.attempts[missionId]`, and it
already survived save, load and two migrations.

---

## Inventory needed no new model

The question §9 asks was already answered by the code:

```
campaign.inventory = { plateArmor: 2, longRifle: 1 }
```

A count, not a boolean. `equipmentAvailableCount` subtracts equipped copies
from owned ones, and validation already errors on "equipped 3 times but only 2
copies owned". **Duplicates are a first-class concept**, so no item-instance
architecture was invented.

"You may only ever have one of these" is therefore enforced where it belongs —
a `claim` policy on the authored entry — rather than by making the object
special. Two policies, not ten:

| | |
|---|---|
| `repeatable` | the farming case. Replay, kill it again, get another |
| `oncePerCampaign` | the unique case. Recorded as a claim key, forever |

A claim key is `sourceKind::sourceId::tableId::entryId`. It deliberately
excludes the attempt — the whole point is that it outlives attempts — and
includes the *entry* rather than the item, so two different unique rewards that
happen to pay the same part remain two separate claims.

### Which is why entry ids are required

A claim keyed by array position would silently retarget the moment an author
inserted a line above it, and the symptom would be a unique reward becoming
collectable again, months later, in somebody's save. Validation refuses an
entry without a stable `id`.

---

## Exactly once

A receipt is identified by `missionId#attempt`. `applyRewards` refuses a
receipt it has already applied and says so.

This is not an optimisation. Currencies and material counts *accumulate*, so a
double application is invisible until somebody notices they have twice the
salvage they earned. The unit suite applies one receipt four times over — a
remount, a reload and two impatient clicks are indistinguishable from here —
and ends with one servo assembly. The acceptance run does it five times through
the real page.

A genuinely new attempt has a new number, therefore a new receipt id, and is
allowed to pay again.

---

## Replay opened for the first time

`resolveMissionOutcome` used to begin:

```js
if (campaign.completed.includes(missionId)) return campaign;
```

A second clear paid *nothing whatsoever*. Every reward in the game was
implicitly first-clear-only, which is why this phase adds a replay path rather
than changing one.

Story progress is still strictly first-clear — clearing a mission twice does
not make a plot happen twice, so flags, unlocks, recruits and contacts fire
once. Rewards became a separate question with their own claim rules.

```
first clear   story progress  +  clear table  +  first-clear table
replay        clear table only, minus anything already claimed
failure       nothing at all
```

Failure salvage is deliberately not implemented: the game has no defined
semantics for it, so the conservative rule stands — persistent loot is awarded
on successful resolution — and the question is left to whoever designs
retreating.

---

## Where a drop lives

Two ownership points, because a real roster needs both.

**A chassis** names what its archetype is worth. `rifleGrunt` drops
`standardSalvage`, and every rifle grunt in every mission does, with no
per-mission authoring.

**A placement** overrides it. This is the entire reason the override exists:

```json
{ "ref": "namedCaptain", "definitionId": "rifleGrunt",
  "dropTableId": "namedCaptainCache" }
```

The named captain and the ordinary trooper in the bench fixture are the *same
chassis*. Only the placement differs. The alternative — duplicating a unit
definition to change what something drops — is what makes a real roster
unmaintainable, and it is the thing this avoids.

Eligibility comes from `collectDefeatedSources`, read from final unit state
rather than by re-scanning the log: a unit destroyed and then revived finished
the operation intact and pays nothing. Being on the board is not the same claim
as having been defeated, and the fixture parks a bystander specifically to
prove it.

Loot resolves at mission results, not on the battlefield. There are no pickups
to walk over.

---

## The mission owns what it pays

```json
"rewards": { "clear": "rewardBenchClear", "firstClear": "rewardBenchFirstClear" }
```

Two slots and no third. A repeatable reward is simply `clear`; adding a
separate "replay" table would have made the common case ambiguous about whether
the first clear also pays it. "Only once" is a claim policy on the entries, not
a property of the slot, which is why a first-clear table can still contain
something repeatable.

### Legacy migration

Thirteen Act One missions author their rewards in the `CAMPAIGN` literal. They
still work, adapted into ordinary grants at **one** call site
(`legacyRewardTable`), so there is a single runtime authority while two
authoring locations exist. Adapted tables are visibly named `legacy:<missionId>`
and are built on demand rather than stored, so they cannot drift from the
literal they adapt.

They adapt as *first-clear* sources, which preserves exactly what the game did
before — those missions never paid a replay.

**The migration path** is per-mission and needs no engine change: move the
currencies into a loot table, name it in the mission file's `rewards.clear` or
`rewards.firstClear`, and delete the literal's block. The count of missions
still relying on the adapter is the migration's progress bar; when it reaches
zero, `legacyRewardTable` and its call site are deleted. The campaign-as-data
phase is the natural time to finish it.

---

## Provenance, and finding a source

Every receipt line carries `sourceKind`, `sourceId`, `sourceLabel`, `tableId`
and `entryId`. That is enough for a results screen to say which enemy dropped
what, and enough for a future codex to work backwards.

No item stores a source string. `tablesGranting(tables, kind, itemId)` derives
the answer from canonical content — direct grants, then tables that reference
those tables — and the tests walk it the rest of the way, from tables to the
placements that carry them:

```
prototypeAlloy
  ← restrictedTechnology, eliteSalvage, namedCaptainCache
  ← fixture-reward-bench:namedCaptain, fixture-reward-bench:elite, …
```

A stored description would go stale the first time a table changed. This
cannot.

---

## Nested tables

Implemented, because the duplication is real: `restrictedTechnology` is the
shared pool of things that should not be in the field, and both `eliteSalvage`
and any future elite archetype reference it rather than copying it. An entry
either names an item or names a table, never both.

Depth is bounded at 4, cycles are refused by validation, and the runtime also
refuses to follow one — a Studio draft can be mid-edit and still get previewed.
A line pulled in through a reference keeps the *source* that pulled it, not the
table that referenced it, so salvage from a nested pool still names the enemy
it came off.

---

## Validation

| | |
|---|---|
| table | unknown grant kind · unknown equipment, material or currency · non-positive quantity · missing or duplicated entry id · zero-or-less weight · negative rolls · an empty pool · a pool that rolls but can choose nothing · an entry naming both a table and an item · an unknown claim policy · a cycle |
| mission | an unknown clear or first-clear table · a placement dropping an unknown table |
| material | malformed tags · a non-positive tier |
| unit | a chassis dropping an unknown table |

Validation reads the **authored** value, not the normalized copy.
Normalization coerces an unknown claim policy to `repeatable` so the runtime
stays safe; validating the coerced value would mean a typo silently became
repeatable and nothing ever said so.

An empty table is a warning rather than an error, because a table is empty the
moment it is created in the Studio.

---

## Testing

- `npm test` — the `Rewards` group, 28 tests: determinism, both ownership
  points, defeated-vs-present, exactly-once under five applications, the unique
  claim across a save, the legacy adapter, first-clear-vs-replay progression,
  the reverse index, thirteen validation refusals, and a source-reading check
  that fails if the pipeline names any item, enemy or mission.
- `npm run check:reward` — 45 checks through the real runtime and the real
  save slot.

---

## Known debt

- **No replay UI.** The architecture supports it end to end and the tests drive
  it, but nothing on the mission board offers a completed operation again. The
  board filters completed missions out of `available`. This is a screen, not an
  architecture problem.
- **Thirteen missions still author rewards in the `CAMPAIGN` literal.** The
  adapter is deliberate and temporary; see the migration path above.
- **No failure salvage.** Undefined by design rather than unimplemented.
- **No difficulty context.** No difficulty concept exists anywhere in the
  repository, so none was invented. `planRewards` takes an input object, so
  adding one later is an argument rather than a redesign.
- **Currencies are campaign fields, not a registry.** Valid ids are named in
  one place (`CAMPAIGN_CURRENCY_IDS`) and passed into validation. The
  campaign-as-data phase should promote them; the authored schema will not need
  to change when it does.
- **No crafting, vendors, salvage-from-wrecks, affixes or procedural
  generation.** Materials exist so that loot authored today does not need
  rewriting when the first of those arrives.
