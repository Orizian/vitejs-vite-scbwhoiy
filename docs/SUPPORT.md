# Support, resource transfer and repair

Everything the engine could do to a resource before this phase either created
it or destroyed it. A support operator does neither: she takes something finite
from one place and puts it somewhere else, and every interesting decision comes
from that being a real trade.

- Primitive: `src/combat/resources.js` — `planTransfer` / `applyTransfer` (pure)
- Effect, event and adapter: `src/App.jsx`
- Authored data: `src/content/gameplay/{abilities,resources,statuses,units,reactions}.json`
- Fixture: `src/content/missions/fixture-support-arena.json`
- Acceptance: `npm run check:support`

---

## One effect, four shapes

`transferResource` is the only new effect. It covers all of these because none
of them are actually different sums:

| | |
|---|---|
| unit → unit, same resource | hand a frame two charges of yours |
| unit → unit, different resource | coolant becomes somebody's stored thrust |
| unit → faction, different resource | your capacity becomes squad tempo |
| faction → unit | falls out for free; nothing uses it yet |

**Scope is never named at a call site.** `from` and `to` nominate an *owner* —
the ability's source or its target — and which pool that owner actually touches
comes from the resource definition's own scope. That is the whole reason
crossing from a personal resource to a shared one needs no special case
anywhere.

```json
{
  "type": "transferResource",
  "from": "source", "to": "target",
  "resourceId": "supportCharge",
  "intoResourceId": "burst",
  "cost": 1, "gain": 1, "maxTransfers": 2,
  "partial": true
}
```

---

## Exchanges, not amounts

A transfer is expressed as whole exchanges of `cost` source points for `gain`
destination points, up to `maxTransfers` of them.

Counting whole exchanges rather than scaling one amount is what makes partial
transfers exact. Offer two charges into one point of headroom and it moves one
and spends one — it does not burn two to deliver one. Integer in, integer out,
nothing rounded and nothing wasted.

It also expresses conversion without a ratio field: Tactical Relay is one
exchange of `cost: 2` for `gain: 1`, authored explicitly rather than computed.

`partial: false` makes it all-or-nothing, which is what a conversion wants: one
odd charge does not half-become a Command Point.

---

## Nothing is created

The conservation property is structural rather than promised. `applyTransfer`
debits the source and credits the destination in one step, so there is no
window in which the points exist nowhere and no pair of independently-clamped
events that can disagree. Both the unit suite and the acceptance run add the
two balances up before and after.

The one thing worth stating explicitly: **a transfer that would move nothing
never runs**. A full destination, an empty source, or an all-or-nothing
exchange that cannot complete all refuse before the action is spent — in the
command validator, and in the ability view model so the button says so first.

---

## The bug on the way in

`resourceRestored` read only `unit.resources[id]`, so **restoring a
faction-scoped resource added nothing and reported nothing**. That is the exact
bug fixed on the *spend* side when squad-funded abilities arrived; the restore
half was never touched, and it had to work before support could put anything
back into the squad's budget. Both halves are scope-aware now, along with the
content validator and the ability view model.

---

## Subsystem damage is a status

There is no subsystem model, and the inventory is why. Running the decision
tree honestly:

| Concept | Already expressible? |
|---|---|
| mobility damaged | ✅ `movementFlat: -3` |
| sensors damaged | ✅ a status `perception` profile |
| reactor unstable | ✅ stat modifiers |
| **weapon offline** | ❌ only *equipment* could remove an ability |

Three of four already worked. So the addition is six lines: a **status** may
now declare `removesAbilities` and `blocksAbilityTags`, mirroring exactly what
equipment already declares.

```json
"thrustersImpaired": {
  "tags": ["mechanical", "systemDamage"],
  "modifiers": { "movementFlat": -3, "speedMultiplier": 0.85 },
  "blocksAbilityTags": ["route"]
}
```

The frame still walks. It no longer runs, and nothing needing a running start
is available at all.

`blocksAbilityTags` covers what an id list cannot: "your drive is out" should
apply to whatever this chassis happens to carry, not to a list the author has
to keep in step with every frame that ever gets a route.

**Repair is `cleanse`**, which already existed. An impairment inherits the
entire status lifecycle for free — duration, stacking, display, save/load — and
a dedicated model would have had to reimplement all of it to gain nothing this
slice needs.

---

## The vertical slice

`supportMech` gains **Support Charge**: max 4, one back per own activation,
nothing else refills it. Everything she does for somebody else comes out of it.

| Action | Cost | What it is |
|---|---|---|
| Power Transfer | 1–2 charge | her rack becomes an ally's stored thrust |
| Coolant Transfer | 1–2 charge | the same clamps, a different rack — 1 charge → 2 capacitor |
| Tactical Relay | 2 charge | personal capacity becomes one squad Command Point |
| System Repair | 1 charge | pulls a damaged system back to operational |
| Field Repair | free | hull integrity, through the ordinary healing pipeline |
| Emergency Patch | 1 charge, reaction | an ally drops below the line and she is already moving |
| Arc Welder | free | the same machine takes a frame apart at arm's length |

She is not a backline medic. Her thesis is that **she lets the rest of the
roster operate past the limits it is built for** — and the welder is why being
next to her is not safe.

### The economy proof

```
squad Command Points   1     (the plan costs 2 — unaffordable)
Reyes Support Charge   4

Tactical Relay
  Support Charge  4 → 2
  Command Points  1 → 2

Vale — Battle Plan     spends 2, reorders the squad
```

No Reyes→Vale code anywhere. One frame put points into a shared pool; another
spent them.

### The transfer proof, twice

```
Support Charge 4 · Burst 1/5      →  Support Charge 2 · Burst 3/5
Support Charge 4 · Capacitor 0/8  →  Support Charge 2 · Capacitor 4/8
```

Two entirely different economies, one effect type, only the authored data
differing. The engine never learns which resource is which.

---

## Preview and execution agree

`planTransfer` is called by the forecast, the ability model and the executor.
The cap is therefore *in the promise*: an ability that would deliver 1 because
the target is nearly full forecasts `+1`, not `+2` followed by a surprise.

```
TRANSFERS   +1 Burst
```

---

## Validation

- an unknown source or destination resource
- a non-positive `cost`, `gain` or `maxTransfers`
- a transfer into the balance it came from
- a shared resource transferred into itself — one pool twice
- delivering or costing more per exchange than the pool can ever hold
- an impairment naming an ability that does not exist
- an impairment blocking a tag no ability carries

---

## AI

The scorer values a transfer at **what it would actually move**, so a full
target scores below doing nothing and a support AI cannot spend its turn and
its finite capacity topping up a rack that is already full. That is the only
support behaviour built here; genuine support *sequencing* — deciding who needs
funding most, three activations ahead — is a planning problem and is documented
debt rather than attempted.

---

## Performance

```
plan a transfer                    < 0.001 ms
ability model incl. transfer plan    0.12 ms
```

Two lookups and integer division. Nothing here justifies caching.

---

## Testing

- `npm test` — the `Support` group covers conservation, partial transfers,
  full destinations, empty sources, the second economy, cross-scope
  contribution, a capped squad pool, all-or-nothing, the funded-command
  proof, an ally afford­ing what it could not, hull repair, capability loss
  and return, two impairment tags through one repair, save/load, the emergency
  reaction, the welder, forecast parity, honest refusals, the AI refusal, an
  engine-names-nothing check and a perf guard.
- `npm run check:support` — 69 checks through the real runtime in a real page.
- The tripwire refuses the support kit's ids inside the generic directories,
  verified against an injected probe with five fake branches.

---

## Known debt

- **No support sequencing AI.** It refuses waste; it does not plan.
- **No faction → unit transfer content.** The primitive covers it; nothing
  wants it yet.
- **Impairment is applied by tests and content, not by combat.** No shipped
  attack inflicts `thrustersImpaired` — what deals system damage is a
  balance question this phase deliberately did not answer.
- **One rack, one operator.** Whether other frames carry a personal support
  economy is content, and none do.
