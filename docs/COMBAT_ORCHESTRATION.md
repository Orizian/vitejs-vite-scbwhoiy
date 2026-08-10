# Combat orchestration

The layer operator synergies are authored from.

The target sequence is a chain of ordinary events, each one caused by the last:

```
   something displaces an enemy
   └─ the enemy loses cover from a prepared shooter
      └─ the shooter reacts and fires        ← costs Command Points
         └─ the enemy is destroyed
            └─ an ally reacts and advances    ← costs Section Seven tempo
```

No engine module knows who any of those units are. Every step is a registered
primitive; the sequence itself is content.

- Resources: `src/combat/resources.js` · Causality: `src/combat/causality.js`
- Reaction runtime: `src/reactions/` · Authored data: `src/content/gameplay/`
- Fixture: `src/content/missions/fixture-synergy-arena.json`
- Acceptance: `npm run check:orchestration`

---

## Resources

One mechanism, two scopes.

| Scope | Balance lives on | Example |
|---|---|---|
| `unit` | the unit (`unit.resources`) | reaction capacity, ammunition, a character's Burst |
| `faction` | battle state (`state.resources.faction[teamId]`) | Command Points, a link's shared tempo |

A definition declares `max`, `startsAt`, an optional `regen` (`manual`,
`ownerActivation`, `selfActivation`) and an optional `linkId` gate. Effects and
costs speak the same four verbs: **has**, **spend**, **gain**, **set**.

Two distinctions the schema is careful about:

- **Availability is not balance.** A resource gated by a combat link keeps its
  points while the link is down; it simply cannot be spent from. That is what
  stops a link flickering off and on from handing out free tempo.
- **`everyUnit` decides who has one.** Reaction capacity is universal. A
  character's Burst is not, and auto-creating one on a unit that never earned
  it would mean asking whether a cost can be paid is what grants the means to
  pay it.

This replaced two systems. Before, `unit.resources` and a reaction-only pool
table did the same job with different code and different serialization, and
only one of them was reachable from an ability.

### Command Points

The squad's coordination budget: `max 4`, starts at `3`, regains 1 whenever any
unit of the faction activates. Reactions and coordinated actions draw on it; an
**ordinary activation never does**, so running dry costs you options, not turns.
Every faction has its own balance. Nobody privately holds it — there is a test
that says so.

The numbers are conservative starting values for testing, not final balance.

---

## Reactions as data

Reactions, combat links and resources are canonical gameplay registries, edited
in the Studio and exported like anything else. A reaction is WHEN / IF / THEN:

```json
"heldFiringLane": {
  "name": "Held Firing Lane",
  "trigger": "unitMoved",                            // WHEN
  "requires": { "status": "overwatching" },          // offered to
  "conditions": [                                    // IF
    { "reactorHasStatus": "overwatching" },
    { "subjectRelation": "hostile" },
    { "knowsSubject": "acquired" },
    { "subjectBecameExposed": true },
    { "withinRange": 12 }
  ],
  "cost": { "resources": [ { "id": "commandPoints", "amount": 1 },
                           { "id": "reactionCapacity", "amount": 1 } ] },
  "limits": { "perActivation": 1, "perChain": 1 },
  "effect": { "type": "reactionAttack", "targetFrom": "subject", "power": 90 }
}
```

`owner` names one operator. Leave it out and `requires` decides instead — which
is how a stance-based response is written once rather than once per operator.

### Events

Broad events carrying rich context, not one event per situation. `unitMoved`
covers walking *and* being shoved, carrying `forced`, `from`, `to`, `tiles` and
the displacer, because a prepared shooter does not care which happened — it
cares that something crossed its lane.

`activationStarted` · `activationEnded` · `attackDeclared` · `attackResolved` ·
`attackEvaded` · `unitDamaged` · `unitHpBelowThreshold` · `unitMoved` ·
`unitDestroyed` · `targetMarked` · `statusApplied` · `repairCompleted` ·
`factionChanged`

### Conditions and effects

Conditions are a declarative vocabulary, evaluated when the window opens **and
again immediately before the effect runs** — an earlier reaction in the same
chain can invalidate a later one.

Effects: `reactionAttack` · `advanceIntoOpening` · `partialAction` ·
`reactionStatus` · `reactionRepair` · `modifyTurnDelay` ·
`restoreReactionResource`.

There is deliberately no free-text formula field and no scripting. Content
selects behaviour; it does not write it.

---

## Exposure

There is no global "in cover" flag, and adding one would be wrong: a unit
behind a wall from the north is standing in the open from the east. Exposure is
a **relation**, computed from the reactor's own tile using the engine's existing
line of sight:

| Condition | Asks |
|---|---|
| `subjectInLineOfSight` | can the reactor see where the subject is now? |
| `subjectBecameExposed` | was the subject hidden at `from` and visible at `to`? |
| `eventForced` | was the movement forced rather than chosen? |

`subjectBecameExposed` is the displacement synergy in one line, and it is
indifferent to how the target got there.

> `withinRange` uses the engine's grid distance, which counts a diagonal as two
> steps — the same measure ability ranges use. A reaction that looks like it
> should reach and does not is usually this.

---

## Causality

Every event carries a `cause`:

| Field | Meaning |
|---|---|
| `chainId` | shared by everything descended from one origin |
| `parentSeq` | the event that caused this one |
| `rootSeq` | what started the chain |
| `depth` | how far down; bounded by `MAX_CHAIN_DEPTH` |
| `forced` | the chain passed through a displacement |
| `viaReaction` / `viaReactionId` | the chain passed through a reaction |

Attribution is **ambient**: `queueEvent` stamps the cause of whatever is
currently running, and `processNextEvent` runs each handler inside its own
cause. An effect six frames deep does not have to thread anything through, and
one that forgot would silently detach a subtree of the chain.

`state.causalTrace` keeps a bounded record so the debug view and the tests can
answer *why did that fire?* The reaction prompt shows the chain when depth > 0.

### Loop safety

`limits.perChain` bounds a cascade without banning it: the same reaction cannot
fire twice inside one chain, but a new chain is a new opportunity. On top of
that sit the pre-existing ceilings — one reaction per event instance, a depth
limit on cascades, and a per-battle cap.

---

## The lifecycle, and the softlock

**Root cause.** `resolveReactionChoice` ended the activation *authoritatively*
— `turnEnded` cleared `activeUnitId` — but never routed through the input state
machine. The UI stayed in `mode: "unitReady"` with a unit selected, and the turn
driver required `mode === "idle"`. Both sides waited. A second, latent variant:
if the active unit died mid-chain, `shouldAutomaticallyEndActivation` was false
(it had not moved and not acted) and nothing ever ended its activation.

**Fix.** Two invariants, neither of which mentions reactions:

1. `ensureActivationIsValid(state)` runs in `settleCommand`. An active unit that
   is dead, dormant or gone has its activation closed, with no recovery charged
   and a log line saying why.
2. `battleContinuation(state)` states what happens next, and the UI obeys it
   rather than deciding for itself:

   | kind | meaning |
   |---|---|
   | `finished` | the battle is over |
   | `reaction` | a choice is pending; nothing else may proceed |
   | `active` | a unit is activated and can still act |
   | `advance` | no active unit; `unitId` is next on the timeline |
   | `stalled` | nothing can act — reported as an error, never hidden |

`reconcileInputWithBattle(input, state)` brings the UI back in line whenever it
might have drifted, instead of every authoritative path having to remember to
notify it — which is the bug, one caller at a time.

An unaffordable reaction is still **shown**, greyed out, with the reason. A
reaction blocked by a *limit* is not shown at all: a shortage is a tactical fact
worth seeing, an inapplicable option is noise.

---

## Timeline

`modifyTurnDelay` is the generic primitive. It routes through the same
`timelineModified` event ordinary abilities use, so there is one initiative
calculator and a reaction's adjustment appears in the log, a save and a replay
like anything else.

Two clamps, both load-bearing:

- a single adjustment is capped at `GAME_CONFIG.timeline.maxTurnDelayAdjustment`
- nothing may be scheduled at or before `currentTime` — an activation in the
  past is one that fires forever

One subtlety worth knowing: a unit that is **mid-activation** has no meaningful
`nextActionTime` yet, because `turnEnded` is about to compute it. Adjusting the
field then would be overwritten a moment later, so the adjustment is banked
against the recovery instead. That is the same thing the author asked for —
*finish that and you are already moving* — and it is why the effect works on a
kill the unit itself made.

---

## The vertical slice

| Operator | Authored as | Proves |
|---|---|---|
| Kell | `heldFiringLane` — an unowned reaction gated on the `overwatching` stance he already had | prepared reaction, displacement trigger, exposure condition, Command Point cost |
| Vale | `sectionSevenAdvance` — the existing kill-linked advance, migrated | a reaction's kill creating the next reaction opportunity, and the lifecycle surviving it |
| Nyx | `predatorTempoKill`, `predatorTempoEvade` — timing passives gated on `cloaked` | generic timeline manipulation from authored data |

Kell's overwatch was **migrated, not duplicated**: the stance keeps its stat
bonuses and gains a reactive half. Nyx's passives are ordinary reactions using
the same vocabulary as everything else — a test asserts the timeline primitive's
source does not contain her name.

---

## Testing

| What | How |
|---|---|
| 24 orchestration unit tests | `Orchestration` group, run by `npm test` |
| the chain in a real page | `npm run check:orchestration` |
| character names in generic code | filesystem tripwire in `npm test` |

The tripwire scans `src/combat`, `src/reactions`, `src/mission`,
`src/perception` and `src/scene` for `vale`, `kell`, `nyx`, `aegis`. Comments
are stripped first: the rule is about behaviour, and "this is the shape Nyx's
cloak will need" is design rationale worth keeping, while `if (id === "nyx")` is
the thing to catch. A name inside a string literal still counts.

---

## Remaining debt

- **Reaction capacity is charged but never really contested.** Every unit has
  exactly one and it refills on its own activation. It becomes interesting when
  something spends two.
- **`chooseAiReaction` is a placeholder.** It refuses to spend the last point of
  a shared pool on a low-priority reaction and otherwise says yes. Enough to
  exercise legality and ordering; not tactical judgement.
- **No reaction cancels its trigger.** `STAGES` has `before` and `after`, but a
  before-reaction cannot veto the event that opened it — that needs an
  event-veto contract the queue does not have.
- **Displacement is a straight line.** `push` / `pull` / `moveUnit` move along
  one axis. Trajectory and arc movement are the displacement operator's problem,
  not this phase's.
- **Reaction capacity and Command Points do not appear in the unit inspector.**
  The squad strip shows faction resources; per-unit balances are only visible in
  the developer panel.
