# Arc propagation

A chain of targets, each one chosen because of where the last one is standing
*right now*.

The engine already had area targeting: a shape, centred on a tile, listing
everything inside it. Every target in that model sits at a fixed offset from
one point, which is why it could not express the thing a chain needs —

```
hit A ─▶ find something near A ─▶ hit B ─▶ find something near B ─▶ …
```

— where the second target's legality depends on the **first target's** live
position rather than on the caster's. That dependency is the entire mechanic:
it is what makes a clustered formation a mistake, and what lets one operator
create another operator's payoff by moving a single enemy two tiles.

- Primitive: `src/combat/propagation.js` (pure — no engine, React or content ids)
- Adapter, effect and preview: `src/App.jsx`
- Authored data: `src/content/gameplay/abilities.json`, `resources.json`
- Fixture: `src/content/missions/fixture-cascade-arena.json`
- Acceptance: `npm run check:cascade`

---

## What it adds, and what it deliberately does not

It adds a **search**, not a targeting system. Fixed-shape AoE is untouched; an
ability chains exactly when its content carries a `propagation` block, and the
engine keeps no list of which ones do.

It adds no second distance metric and no second sight model. Every question the
search asks — how far, can it see, is this a legal target — goes through an
adapter onto `gridDistance`, `hasLineOfSight`, `TARGET_FILTERS` and
`passesTargetFilters`. A planned arc is making the *engine's* claim.

It is not an AI search. Content picks a named selection policy; it does not
write one, and there is no scoring language.

---

## The planner

```js
planPropagation(sourceUnitId, initialTargetId, deps, options)
```

The player picks the first target. Everything after it is the search's, and
`maxHops` counts **arcs** — 3 arcs reach four units in total.

A plan is returned whether or not it worked:

| Field | Meaning |
|---|---|
| `nodes` | ordered, each with `hop`, `fromId`, `distance`, `radius` |
| `order` | just the ids, in order |
| `legal` / `initialLegal` | whether it can run, and whether the first target was valid |
| `terminationReason` | `noInitialTarget` · `hopLimit` · `noEligibleTarget` |
| `rejected` | every candidate considered and why it was refused |

`rejected` is not debug residue — it is what lets the preview say *"Bravo, out
of arc range (5 > 3)"* instead of silently stopping short. A player who can see
why the chain ends can decide to fix it.

**Determinism is a hard requirement.** Every selection is fully ordered with a
stable final tie-break on unit id, and no randomness enters at any point, so a
replay chains identically.

### Selection policies

| Policy | Chooses |
|---|---|
| `nearest` | the closest legal target; ties broken by unit id |
| `nearestThenWeakest` | the closest; among equally close, the one with least health |

A registry, so "arc to the most wounded" is an entry plus a word in a JSON file.

### The ceiling

`MAX_PROPAGATION_HOPS = 24`, applied to whatever content asks for. Authored data
is allowed to be wrong; this is the difference between a mistyped hop count
producing a silly chain and producing a hung tab.

---

## Live positions

Positions are read at call time and never captured. There is no spawn cache and
no authored formation data anywhere in this path. That is not an implementation
detail — it is the feature:

```
before the shove   alpha                      (5 tiles to Bravo, arc range 3)
after the shove    alpha → bravo → charlie
```

Nothing about the ability changed. One enemy moved two tiles.

`propagationRadiusBonus` is an ordinary stat, so the `conductive` status widens
what a chain can cross by going through the same modifier pipeline as any other
buff. The arc radius for a given jump is `authored + bonus(from) + bonus(to)`,
which is why marking one enemy helps the arc both arrive and leave.

---

## Execution

`propagate` is an ordinary effect carrying an effect list:

```json
{
  "type": "propagate",
  "effects": [ { "type": "damage", "formula": "magical", "power": 155 } ]
}
```

The chain is planned once, then each node's effects resolve through
`resolveEffects` exactly as if that node had been targeted directly. There is
no chain-damage routine — which is the property that makes a chain of statuses,
heals or shields a different effect list rather than new architecture.

**Why the chain is planned up front rather than re-planned after every hop:**
because the preview must be able to promise the sequence. Re-planning mid-chain
would mean the order depends on damage that has not happened yet, and the panel
could only ever show a guess. Planned up front, preview and execution call the
same function against the same state and agree by construction — and there is a
test that runs both and compares them. A node that dies before the arc reaches
it is skipped rather than forced.

### Causality

Every hop is an ordinary event under the existing causality model:

```
Cascade Frame
└─ Chain Discharge
   └─ damage → alpha
      └─ propagationHop → bravo
         └─ damage → bravo
            └─ propagationHop → charlie
```

All of it shares one `rootSeq`, each hop carries its parent cause, and the
existing `MAX_CHAIN_DEPTH` guard still bounds everything. Nothing was replaced.

---

## Hop scaling

The same named-source registry the trajectory phase introduced, pointed at new
facts:

| Source | Reads |
|---|---|
| `hopIndex` | 0 on the initial target, 1 on the first arc |
| `hopDistance` | tiles the current arc crossed |
| `propagationKills` | units this chain has already destroyed |

`perUnit` may now be negative, with `min` bounding the downside (default 0, so
existing content is unaffected). Decay and growth are the same mechanism with
the sign flipped:

```json
"scaling": { "from": "hopIndex", "perUnit": -22, "min": -66, "max": 0 }
"scaling": { "from": "propagationKills", "perUnit": 30, "max": 90 }
```

There is still no expression language and no authored JavaScript.

`propagationKills` is the kill cascade, and it is deliberately a **counted
fact**: a kill can make the rest of the chain hit harder because content asked
it to, but it can never cause another arc. That is what stops a cascade
becoming a loop.

---

## Authoring a chaining action

```json
"propagation": {
  "maxHops": 3,
  "hopRadius": 3,
  "relationship": "enemy",
  "selection": "nearest",
  "allowRepeat": false,
  "includeSource": false,
  "requiresLineOfSight": false,
  "allowsDefeated": false,
  "filters": []
}
```

The Studio edits all of it (Abilities → Propagation). Validation refuses a
negative hop count or radius, an unknown selection policy, an unknown
relationship, a status filter naming a status that does not exist, and a
dangling reference nested anywhere inside the chain's effect list. It warns
about a radius of zero, a hop count above the engine ceiling, a `propagation`
block with no `propagate` effect to use it, and the one configuration that
bounces between two nodes (`allowRepeat` plus `includeSource`).

---

## The vertical slice

`cascadeFrame` is the first frame authored on top of it: 68 HP, 14 defense, 12
evasion, movement 4, magic 82. A capacitor bank with a cockpit attached.

| Action | What it is |
|---|---|
| Chain Discharge | the signature: heavy on the first target, then it goes looking, losing a little each arc |
| Surge Discharge | the whole bank — further, more arcs, and it *grows* with every frame the chain kills |
| Arc Lance | the reliable single-target answer, and it puts a little charge back |
| Grounding Cycle | an activation spent banking charge, standing still, exposed |
| Ionise | marks one enemy conductive so the next chain reaches a tile further from it |

**Capacitor** is a `unit`-scope resource: max 8, starts at 3, and nothing
refills it on a timer. Charge comes from acting, which is the tempo decision.

Balanced by geometry and fragility rather than by weak numbers:

- Against a two-by-two block, one Surge Discharge kills four frames.
- A clustered formation takes more than twice the total damage of a spread one.
- An elite survives a full chain at 19 HP and is standing next to a 68-HP frame.
- It is frailer than the sniper, less evasive than the stealth frame, and its
  longest reach is 5 against the sniper's 6 — there is a test for each.
- No stealth, no shield, no escape tool. A test asserts the abilities grant
  none of them.

---

## Performance

Measured in the real runtime on a 60-unit board with every candidate in range:

```
plan            0.82 ms
full preview    1.49 ms   (plan + per-node damage forecast)
```

The search is O(hops × units) with no allocation per candidate beyond the
candidate list. Nothing here needs optimising, and it was not optimised.

---

## Testing

- `npm test` — the `Propagation` group covers the search, ordering, tie-breaks,
  repeat and hop limits, live positions, conductivity, execution, cost, the kill
  cascade, causality, recursion safety, preview parity, the veteran-grouping
  acceptance, the glass-cannon numbers, and a perf guard.
- `npm run check:cascade` — the same chain through the real runtime in a real
  page, comparing what the preview promised against what the engine did.
- The character-name tripwire now also refuses the cascade kit's ids inside the
  generic directories, and matches **whole string literals** rather than bare
  words, so `"cascade stopped"` in a diagnostic message is not a false positive
  while `classId === "cascade"` still is one. Verified against an injected probe
  carrying six fake branches.

---

## Known debt

- **The AI does not plan chains.** It scores a chaining ability by how many
  units the chain would reach, so it prefers hitting four to hitting one, but it
  cannot pick a target *because* of who is standing behind them. Real chain
  planning is a search problem worth its own phase.
- **The chain is planned once per cast.** Deliberate, for preview parity (above),
  but it means a node killed mid-chain is skipped rather than replaced.
- **One initial target.** The chain starts from a single unit; an area-seeded
  chain would be a new field, not a new system.
- **`nearestThenWeakest` is unused by shipped content.** It exists to keep the
  policy registry honestly a registry.
