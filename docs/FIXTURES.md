# Battlefield fixtures

Something that sits on a tile, belongs to somebody, remembers what state it is
in, and is not a unit.

The engine had two ways to put something on the map and neither fit:

| | |
|---|---|
| a **unit** | occupies its tile, has health, takes turns, appears in the timeline, can be targeted by everything |
| a **terrain override** | has no owner, no state, no trigger and no lifecycle |

A mine is neither. It belongs to a faction, sits on a tile without blocking it,
is armed or not, is known to one side and not the other, and disappears when it
goes off. So does a beacon, a deployable shield node, a healing station, a rune
and a turret emplacement — which is the argument for one generic concept rather
than a trap system.

- Primitive: `src/combat/fixtures.js` (pure — no engine, React or content ids)
- Adapter, effects and command: `src/App.jsx`
- Authored data: `src/content/gameplay/fixtures.json`
- Fixture: `src/content/missions/fixture-sapper-arena.json`
- Acceptance: `npm run check:fixtures`

---

## Exact region membership, first

Regions used to mean two different things depending on who asked. Objectives
and the scripting layer tested the authored tile list; the mid-battle trigger
tested the region's **bounding box**, which is the same answer only for
rectangles. An L-shaped region reported units standing in the notch as being
inside it, and the mission validator carried a standing warning saying so.

That was survivable while regions only decorated dialogue. It stops being
survivable the moment standing on a tile can hurt you, so it was fixed before
anything else in this phase:

- `src/mission/regions.js` is now the one place that answers "is this tile in
  this region", and mission-format, the mission runtime and the engine all call
  it.
- `compileMidBattle` carries the region's exact tiles instead of deriving a
  rectangle. `boundingBoxOf` still exists, is named for what it does, and is
  used for framing rather than membership.
- The two standing "not rectangular" warnings — on Bellview's `pumpYard` and
  the Section Seven fixture's `range` — are gone, because the thing they warned
  about no longer happens.

Regression tests cover a rectangle, an L-shape, a tile inside the bounding box
but outside the region, and enter / leave / re-enter across the notch.

---

## The runtime model

```js
{
  id, definitionId, x, y,
  ownerTeamId, ownerUnitId, createdBy,
  state,                    // placed · armed · triggered · disarmed · removed
  visibility, revealed,
  blocksMovement, charges, consumedOnTrigger,
  triggerTiles, data, createdAt
}
```

**State is a small closed list.** A fixture that could be in any state an author
invented would need a state-machine language to describe, and every system that
reads fixtures would have to cope with states it had never heard of. Five
covers a mine, a charge, a beacon and a deployable, and the transitions between
them are the ones that mean something mechanically — `canTransition` refuses
the rest, so nothing comes back from `removed`.

**The collection is deterministic.** Insertion-ordered, with `nextId` travelling
in the save: reusing an id after a reload would make two different devices
indistinguishable in a causal trace.

**It is plain data.** A save is a copy, and a save taken before fixtures existed
loads with an empty collection rather than being rejected.

---

## Authoring one

```json
"pressureMine": {
  "name": "Pressure Mine",
  "tags": ["explosive", "trap"],
  "visibility": "ownerTeam",
  "initialState": "armed",
  "trigger": { "type": "unitEnters", "triggeredBy": "enemy" },
  "area": { "shape": "diamond", "radius": 1 },
  "affects": "enemy",
  "effects": [ … ],
  "charges": 1,
  "consumedOnTrigger": true,
  "blocksMovement": false
}
```

`effects` is an **ordinary effect list against ordinary area targeting**. There
is no blast system: a charge that damages and shoves is the same machinery as
an ability that damages and shoves, which is why a healing station or a debuff
field needs no new architecture.

The Studio edits all of it (Fixtures → …). Validation refuses an unknown state
or visibility, a state it could never act from, negative charges, an unknown
trigger type or relationship, a device that places itself, a placement naming a
device that does not exist, a detonator wired to a tag nothing carries, and a
device that blocks movement while being invisible to its enemies — an invisible
wall is never what anybody meant.

---

## Triggering

```
WHEN  a unit's movement enters a tile the fixture covers
IF    the fixture is armed and the relationship matches
THEN  the fixture's authored effects resolve, and it is consumed or re-arms
```

**Voluntary and forced movement reach this by exactly the same route.** There is
deliberately no "was this a shove?" branch: both movement handlers ask the same
question of the same list, because a mine cannot tell the difference and
neither should the engine. That is the whole reason punching an enemy onto a
mine needs no combo code.

### Mid-path triggering

A mover crossing a mined tile sets it off **there**, not on arrival. `unitMoved`
scans the path for the earliest contact and, if it is not the last tile:

1. applies the move only as far as that tile and logs it,
2. queues the fixture trigger,
3. hands the remainder to `unitMovementResumed`, which rides on the trigger
   event so it runs only after the device has finished with the mover.

The continuation re-checks everything rather than assuming: a mover that died
never reaches its destination, and a mover thrown somewhere else is not owed
the rest of a path it is no longer standing on. With no fixtures placed the
scan is over an empty list and movement is byte-identical to before.

> The ordering here is load-bearing and was got wrong once: resolving a fixture
> drains the event queue, so a continuation queued *beside* the trigger ran
> before the blast landed and walked a corpse the rest of the way. It is queued
> *after* the activation now, and there is a test that kills the mover mid-path.

---

## Commanded devices

Remote detonation is **a command**, not a reaction. The operator spends her
action to set off a device she chose, at a moment she chose — that is the
mechanic, and modelling it as something automatic would take the decision away.

```json
"fixtureTargeting": {
  "tag": "commandable",
  "ownership": "own",
  "states": ["armed"],
  "rangeMax": null,
  "requiresLineOfSight": false
}
```

Selection is **by tag, never by id**, so one ability commands a family of
devices and a new member of that family is a content change. The same command
already serves the defuser: `fixtureAction: "disarm"` moves the device between
states instead of activating it, with `ownership: "any"` and a range of 1, so
walking up to a found mine and switching it off is the same code path as
detonating your own charge from across the map.

Nothing in the handler names a fixture, an ability or an operator.

---

## Visibility

Three modes — `everyone`, `ownerTeam`, `ownerOnly` — plus a `revealed` flag that
overrides in one direction only. Once something has been found it stays found,
because the alternative is a player standing on a mine they were previously
shown.

`visibleFixturesFor(state, teamId)` is the only path by which fixtures reach a
view model or a plan, so a device hidden from a side is hidden everywhere that
side can look. There is a test that scans everything the AI is handed for the
id of a device it is not entitled to know about.

**Documented gap:** there is no *detection*. A hidden device becomes visible
only when something reveals it explicitly. Wiring fixtures into the perception
layer's channels and sweeps is a real integration, and it is deliberately not
in this phase — the conservative owner-visible / enemy-hidden state is honest
about what it does, and the disarm path is already generic enough to use
whatever detection arrives later.

---

## Causality

```
Sapper
└─ Place Mine
   └─ fixture instance

Veteran
└─ Mach Strike
   └─ unitForcedMove              ← forced: true, depth 0
      └─ fixtureTriggered          depth 1
         └─ fixtureDetonated       depth 2
            └─ damageResolved
```

One `chainId` throughout, each step hanging below the last, and the damage
attributed to **whoever laid the device** rather than to the ground. The
detonation event records the fixture, its definition, its owner, who set it
off, and whether it was `automatic` or `command` — a distinction worth
recording rather than inferring.

---

## The vertical slice

`sapperFrame` — 92 HP, 44 defense, 14 evasion, movement 4, and a rack of four.
She does not win the fight she is standing in; she wins the one that happens
two activations later, on ground she picked.

| Action | What it is |
|---|---|
| Place Mine | a pressure plate on a nearby tile; the tile stays walkable, which is the entire point |
| Place Charge | inert until told otherwise |
| Detonate | a fixture-targeted command: now, while three of them are standing in the same place |
| Defuse | walk up to a found device and switch it off; costs the whole activation |
| Demolition Shot | the launcher, so an empty rack is a setback rather than a wall — and it scavenges one back |

**Ordnance** is a `unit`-scope resource: max 4, starts at 3, and nothing refills
it on a timer. Placing spends it; the launcher restocks it.

The two devices are deliberately opposites. A pressure mine is automatic
positional punishment. A remote charge is player-controlled timing — it does
nothing at all when stood on, and there is a test that stands on it to prove it.

---

## Performance

Measured in the real runtime, per movement scan:

```
 5 devices   0.0012 ms
20 devices   0.0018 ms
50 devices   0.0052 ms
```

Linear over the collection. At the counts a battle actually holds an index
costs more in bookkeeping than it saves, and the scan is four orders of
magnitude below the movement it is attached to. If that ever stops being true
the fix is a tile index inside `fixtures.js`, with no caller changing.

---

## Testing

- `npm test` — the `Fixtures` group covers placement, non-occupancy, the state
  machine, pressure triggering, ally immunity, mid-path triggering, a mover
  killed mid-path, the displacement acceptance, causality, commanded
  detonation, ownership refusal, tag selection, defusing, visibility, the AI
  leak check, save/reload, and a perf guard.
- `npm run check:fixtures` — the same flow through the real runtime in a real
  page, including the Studio's ability to author and refuse it.
- The character-name tripwire now also refuses the sapper kit's ids inside the
  generic directories, verified against an injected probe with five fake
  branches.

---

## Known debt

- **No detection.** Hidden devices are revealed explicitly or not at all (above).
- **The AI does not place devices**, and scores placement as a flat modest
  value so it neither spams them nor pretends to have a plan. Preparation AI is
  a planning problem worth its own phase.
- **One area shape per device.** A charge with a different blast for a different
  trigger would need a second definition, which is cheap and probably correct.
- **`triggerTiles` is authored but unused by shipped content.** It exists so a
  multi-tile device is a data change; nothing yet needs one.
- **Arming delay is not implemented.** The state machine supports `placed →
  armed`, but no shipped device starts unarmed, and no timer drives the
  transition. `delayedEffect` would do it with no new architecture.
