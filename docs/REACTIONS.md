# Reactions and combat links

Out-of-turn responses to authoritative simulation events, and the relationship framework built on them.

Section Seven is the first Link. Nothing in the simulation or the renderer names it — a test greps both for its identifiers.

- Runtime: `src/reactions/` — `events.js`, `conditions.js`, `effects.js`, `economy.js`, `links.js`, `runtime.js`
- Content: `src/content/reactions.js`
- Bridge into the engine: the `REACTION_ENGINE` adapter in `src/App.jsx`
- Fixtures: `fixture-section-seven.json` (Act-I style), `fixture-grayfield-slice.json` (restored mid-battle)

---

## Lifecycle

```
authoritative simulation event  (state.resolutionQueue)
        │
        ├── before stage ──┐
        │                  │  1. derive    sim event -> reaction events
   [ event handler ]       │  2. discover  indexed by trigger, never a scan
        │                  │  3. filter    conditions + economy + legality
        ├── after stage ───┤  4. order     mandatory, priority, speed, creation
        │                  │  5. choose    automatic / AI hook / player window
        ▼                  │  6. pay       cost deducted, limits recorded
   next event              │  7. execute   re-check legality, then run effects
                           │  8. cascade   new events open their own windows
                           └──────────────────────────────────────────────────
```

**Before** runs with the event dequeued but unapplied — the only moment an intercept or defensive guard can matter. **After** runs against settled state, where counterattacks, pursuit and "advance into the opening" live.

Everything lives in `state.reactions`, plain serializable data. A save taken mid-chain resumes exactly where it stopped; a replay from the same seed reproduces the same sequence.

### One caveat worth knowing

A `damageResolved` event carries an **already-computed** amount. A before-stage reaction on `unitDamaged` can add a shield (consumed inside the handler) but cannot change defence maths. Mitigation that depends on stats belongs on **`attackDeclared`**, which fires before the ability's effects resolve.

---

## Writing a reaction

```jsonc
{
  "id": "sectionSevenMarkShot",
  "name": "Fire on the Mark",
  "description": "Vale paints a target and Kell fires on his data, out of turn.",
  "owner": "kell",                    // authored unit ref
  "trigger": "targetMarked",
  "priority": 70,                     // higher resolves first
  "conditions": [
    { "sourceUnit": "vale" },
    { "linkActive": "sectionSeven" },
    { "subjectRelation": "hostile" },
    { "subjectAlive": true }
  ],
  "cost": { "pool": { "id": "sectionSevenLink", "amount": 1 } },
  "limits": { "perActivation": 1 },
  "effect": { "type": "reactionAttack", "targetFrom": "subject", "power": 95, "formula": "physical" }
}
```

Optional flags: `mandatory: true` (cannot be declined), `automatic: true` (resolves without asking), `capacity: n` (per-unit reaction points for this owner).

### Events

`activationStarted`, `activationEnded`, `attackDeclared` *(before)*, `attackResolved`, `unitDamaged` *(both stages)*, `unitHpBelowThreshold`, `unitMoved`, `unitDestroyed`, `targetMarked`, `statusApplied`, `repairCompleted`, `factionChanged`.

`targetMarked` is derived from status **data**, not a hardcoded id: any status tagged `targeting` produces one. Adding an event type is a data edit in `REACTION_EVENT_TYPES` plus a case in `deriveReactionEvents`; matching is generic.

### Conditions

`all`, `any`, `not`, `sourceUnit`, `subjectUnit`, `subjectRelation`, `sourceRelation`, `linkActive`, `reactorHpBelow`, `subjectAlive`, `withinRange`, `abilityId`, `statusId`, `reactorHasStatus`, `missionFact`, `amountAtLeast`.

Conditions are re-evaluated **immediately before execution**, not just at discovery — by then an earlier reaction in the same chain may have killed the actor, moved the target or flipped a faction.

### Effects

| Effect | What it does |
|---|---|
| `reactionAttack` | A real attack out of turn, via the same damage pipeline. |
| `advanceIntoOpening` | A legal move toward the tile an event freed up, capped at the mover's movement. Falls back to the closest reachable tile; **never teleports**, never fails the simulation. |
| `partialAction` | See below. |
| `reactionStatus` | Applies a status through the normal effect pipeline. |
| `reactionRepair` | A real repair out of turn. |
| `restoreReactionResource` | Refunds a pool or a unit's capacity. |

### What a partial action can currently do

Deliberately narrow. The recipient uses **exactly one ability flagged `basic` in content**, against a target chosen by the same deterministic scorer the AI uses. Nothing else — no movement, no non-basic ability, no second action, no new activation. The activation still belongs to whoever was taking their turn.

`grants: "move"` is the alternative: a reposition capped at half the recipient's movement.

This is a tempo grant, not a free turn. When Kell's firing solution and Reyes's Stock land, the effect can be re-pointed at them without the framework changing.

---

## Economy

Three independent gates, all serializable, all re-checked before execution.

| | |
|---|---|
| **Per-unit capacity** | `cost: { reaction: 1 }`. Refills when the unit activates. |
| **Shared pools** | `cost: { pool: { id, amount } }`. Any number of units may draw on one. |
| **Limits** | `perEvent` (always on — one event never fires the same reaction twice), `perActivation`, `perBattle`. |

A pool declares `refreshOn`: `ownerActivation` (a point back each time an owner takes a turn, capped), `selfActivation`, or `manual`.

Per-activation limits are keyed by activation index rather than cleared on a tick, which is why they are trivially correct across save/load.

---

## Combat links

A Link is a named combat relationship. Three independent gates:

| | |
|---|---|
| `unlocked` | Narrative/campaign state. Persists past the battle. |
| `enabled` | Battle-local switch — what mission scripting toggles. |
| `active` | Derived: all participants present, alive, actionable and mutually allied. |

A link is usable only when all three hold. Its reactions are not merely unaffordable when it is inactive — **they do not exist**, and its shared pool goes unavailable while keeping its banked value.

**If a participant is destroyed, disabled or stops being allied**, the link deactivates immediately, the pool becomes unavailable, and any offer already made is refused at the pre-execution re-check. When the link reforms, the pool refills — a relationship that flickers off and on does not hand out free points, because the refill only happens on a genuine transition.

```jsonc
{
  "id": "sectionSeven",
  "name": "Section Seven",
  "icon": "◈",
  "participants": ["vale", "kell", "reyes"],
  "requireAll": true,
  "requireMutuallyAllied": true,
  "unlockedByDefault": true,
  "sharedPool": { "id": "sectionSevenLink", "max": 2, "startsAt": 2,
                  "refreshOn": "ownerActivation", "refreshAmount": 1 },
  "reactions": ["sectionSevenMarkShot", "sectionSevenAdvance", "sectionSevenFieldTempo"]
}
```

Vale/Nyx, Nyx/Reyes, Becker/Reyes and the rest are additional entries in the same table. No engine change.

### Narrative gating

Mission scripting drives the link through one generic action:

```jsonc
{ "type": "setLinkState", "link": "sectionSeven", "enabled": true, "unlocked": true }
```

The Grayfield fixture proves the composition: the interception phase disables the link, the betrayal phase changes the factions **and** re-enables it, and the shared pool becomes usable in the same instant. A test asserts that the faction change **alone** is not enough — the script is what brings it back.

---

## Ordering and control

Offers for one event are sorted: **mandatory** first (they cannot be declined, so they must not be starved of a shared pool), then authored **priority**, then the faster reactor's **speed**, then **creation order**, then **id**. Fully deterministic.

Each offer's controller is `automatic` (mandatory or flagged), `ai`, or the team's human controller.

- **automatic / mandatory** — resolve immediately, no prompt.
- **ai** — the deterministic AI hook decides. Same legality path as the player's.
- **human + optional** — the runtime **suspends**: `state.reactions.window` is set, the event queue parks, and `executeCommand` returns `pendingReaction: true`.

Presentation never determines legality. The window is authoritative state; the UI only renders it and reports the answer back through `resolveReactionChoice`.

Headless runs (tests, soaks, replay) set `autoResolveReactions: true` and apply a deterministic policy (`takeFirst` or `decline`). The game passes `false` so the player is asked.

---

## Safety

| Guard | Covers |
|---|---|
| `maxDepth: 4` | Cascades. A reaction triggering a reaction is legitimate; ten levels is a bug. |
| `maxPerEvent: 12` | Reactions under one simulation event, across all stages. |
| `maxPerBattle: 2000` | A runaway that survives everything else. |
| `perEvent` limit | One event instance never fires the same reaction twice — including after a reload, because `__seq` rides on the event. |
| Pre-execution re-check | Dead or dormant actors, stale targets, faction changes, links that went inactive. |
| Cost refund | A reaction that turns out to be illegal, or whose effect reports no-op, is refunded rather than half-applied. |
| Event allowlist | Reactions see only the authoritative queue. Presentation events cannot trigger anything. |

Cascades are **bounded, not suppressed**: Vale's mark → Kell's shot → the kill → Vale's advance is a two-level chain that runs to completion. Tripping a guard is recorded in `state.reactions.guards` and surfaced by the test suite, never swallowed.

---

## Save, load and replay

`state.reactions` is plain data and rides in `serializeBattle`. A suspended window serializes with the offers already computed, so reloading re-presents the same choice.

What cannot be duplicated by a reload:

- **reactions** — `eventFired[reactionId@eventSeq]`, and `__seq` is stable across a requeue
- **movement, attacks, repairs** — they are ordinary events that already happened
- **resource costs** — pools and counters are in the save
- **link activation** — `unlocked`/`enabled` are in the save

---

## Adding a character reaction

Add an entry to `REACTION_DEFINITIONS` in `src/content/reactions.js`. If it belongs to a relationship, list it under that link's `reactions`.

That is the whole procedure. No engine change, no renderer change, no new branch in the combat loop.
