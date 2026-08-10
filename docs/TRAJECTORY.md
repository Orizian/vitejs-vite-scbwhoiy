# Trajectory combat

A route across the grid, described well enough to charge for its turns and to
hit something halfway along it.

The target fantasy is a frame that enters a formation at speed, moves specific
enemies to specific tiles, and leaves. What makes that a *tactical* act rather
than a damage number is that the player chooses the exact tile, and someone
else's ability is what makes that tile matter:

```
   a route runs past an enemy behind cover
   └─ a contact halfway along it shoves that enemy two tiles north
      └─ two, not the maximum four — four would overshoot the lane
         └─ the tile it lands on is visible to a prepared shooter
            └─ the shooter reacts and fires
```

Nothing in the engine knows the route belongs to anyone in particular.

- Primitive: `src/combat/trajectory.js` (pure — no engine, React or content ids)
- Adapter, command and preview: `src/App.jsx`
- Authored data: `src/content/gameplay/abilities.json`, `resources.json`
- Fixture: `src/content/missions/fixture-trajectory-arena.json`
- Acceptance: `npm run check:trajectory`

---

## What it adds, and what it deliberately does not

It adds a **description**, not a movement system. Tiles, integers, eight
discrete headings, five turn categories. There is no physics, no spline, no
continuous position, and no second real-time subsystem.

It adds no second pathfinder either. `planTrajectory` asks the engine's own
`evaluateTraversalStep` about every tile it wants to enter. A plan that says a
tile is reachable is making the *engine's* claim, not its own — which is the
property that lets one function serve execution, the player's preview and the
tests.

A trajectory with one segment and no contacts is exactly an ordinary move.
Normal movement is untouched.

---

## The primitive

```
start ─segment─▶ redirect ─segment─▶ redirect ─segment─▶ endpoint
                     ▲                    ▲
                  a heading change, categorised and therefore priceable
```

**Headings** are the eight grid vectors. They are not the same thing as a
unit's facing — facing is four isometric directions chosen for how the art
reads, and a route needs to know it turned even when the sprite would not
change.

**Redirects** are categorised by the angle between two headings:

| Category | Angle |
|---|---|
| `straight` | 0° |
| `slight` | 45° |
| `quarter` | 90° |
| `sharp` | 135° |
| `reverse` | 180° |

The category is all the engine produces. What each one *costs* is authored.

> The grid currently has `allowDiagonalMovement: false`, so diagonal headings —
> and therefore `slight` turns — plan as blocked. The trajectory module does not
> know or care: it asks the traversal validator, which refuses them, the same
> way it refuses a wall. Turning diagonals on is a config change, not a second
> movement model.

**Plans are always returned, even when illegal.** `legal` says whether it can
run and `stopIndex` says how far it got. A preview that could only render legal
routes would be unable to show the player *where* their route breaks, which is
the one thing they need to see.

---

## Execution

`executeTrajectory` runs each segment as an ordinary `unitMoved` event, and
resolves that segment's contact between segments. That ordering is what makes a
mid-route strike honest: the mover really is standing where the strike says it
is, and every reaction that would fire on the movement has already fired.

Three things end a route early, and all three are generic:

1. **The mover cannot travel.** Killed by a reaction to its own movement, for
   instance. The guard names no cause.
2. **The frame is not where the segment starts.** Something moved it mid-route.
3. **The world changed under the plan.** Every segment is re-walked against live
   state before it is applied, through the same `trajectoryDeps` adapter that
   planned it. This is not paranoia: a route's own shove routinely lands a
   target on the tile the next leg wanted, and replaying the plan blindly would
   drive the frame straight through them.

An interrupted route is still paid for. The mover is buying the attempt, the
same way a missed shot is.

---

## Precise displacement

The distinction from a knockback is the whole point. An author asks for *this
many tiles*, not "as far as it goes", because the exact tile is what opens a
firing lane or completes a cluster.

```json
{ "type": "displace", "distance": 4 }
```

The authored `distance` is a **maximum**. The player chooses the actual
distance and the heading; the engine clamps the choice to the ceiling and then
clamps it again on the way through, so no caller can widen it.

`planDisplacement` returns the same shape whether or not it succeeds:

| Field | Meaning |
|---|---|
| `requested` | what was asked for |
| `resisted` | tiles absorbed by the target's `displacementResistance` |
| `actual` | tiles actually travelled |
| `blocked`, `blockReason`, `blockTile`, `blockedBy` | what stopped it, and who |

Resistance shortens the shove *before* the walk begins, so a braced target
moves less rather than being stopped by something invisible partway. A
displacement that moves nobody still publishes a `displacementBlocked` event —
a shove that bounced off a wall is exactly the moment a collision reaction
wants.

---

## Scaling by approach

Impact is worth what the runway was. Content asks for that without writing
arithmetic:

```json
{
  "type": "damage",
  "power": 55,
  "scaling": { "from": "approachDistance", "perUnit": 14, "max": 84 }
}
```

`from` names an entry in `EFFECT_SCALING_SOURCES` — a small registry of things
the engine already knows (`approachDistance`, `segmentDistance`,
`redirectCount`). It is **not** an expression language, and there is no
authored JavaScript anywhere in this path. Adding a new scaling source is one
registry entry; authoring a formula is not possible on purpose.

The bonus is stamped on the resulting event and in the log line, so a player
can see where the damage came from.

---

## Authoring a route action

Everything below is data. The engine has no list of which abilities are routes;
an ability *is* one exactly when it has a `trajectory` block.

```json
"trajectory": {
  "maxSegments": 2,
  "allowedRedirects": ["slight", "quarter"],
  "resourceId": "burst",
  "redirectCosts": { "quarter": 1, "sharp": 2, "reverse": 3 },
  "continueAfterContact": true,
  "contactEffects": [ … ]
}
```

| Field | What it decides |
|---|---|
| `maxSegments` | how many legs, and therefore how many turns |
| `maxDistance` | total tiles; empty means the mover's own movement stat |
| `allowedRedirects` | turns the action can make at all — anything absent is refused before execution, not priced higher |
| `resourceId` | which authored pool pays for turns |
| `redirectCosts` | the price list, in that pool's units |
| `continueAfterContact` | whether touching something ends the action |
| `contactEffects` | the ordinary effect list resolved where the route touches something |

The Studio edits all of it (Abilities → Trajectory), and validation refuses an
unknown turn category, a price list with no resource to pay it, a resource that
does not exist, and a contact effect referencing a status or unit that does not
exist.

### Availability

A route ability reaches by travelling, so it is **not** judged on who is
standing next to the frame right now — that would grey out the charge in
exactly the situation a charge is for. It needs somewhere to run: one legal
first step in any heading. A frame boxed in on every side genuinely cannot use
it, which is the counterplay stated as a rule rather than a nerf.

---

## The planning UI

`mode: "planningRoute"`. The player draws the route one leg at a time by
clicking where each leg ends; only tiles on one heading from the current end
qualify. Clicking an enemy the route already passes within reach of attaches a
contact; clicking the route's end again runs it. Right-click and Backspace
remove the last leg rather than discarding the whole thing.

The panel shows legs, turn categories, the price per category, the bank
afterwards, the contact target, the chosen displacement and where it lands, and
the planner's own reason when a leg is refused. The board draws the route as an
ordinary planned path plus three marks a path cannot make: turns, the tile a
displaced unit will land on, and where the route stops short.

**All of it comes from one `createRoutePlanModel` call**, which calls
`planUnitTrajectory`, `planDisplacement` and `trajectoryResourceCost` — the
same three functions execution calls, with the same arguments. Drawing the
route twice is how a preview starts telling a different story from the numbers
beside it.

There is a test for every promise the panel makes: the frame lands on the tile
the preview named, the target lands on the tile the preview named, and the bank
holds what the preview quoted.

---

## The vertical slice

`interdictorFrame` in `units.json` is the first frame authored to use all of
it. It is deliberately not a better version of anything already in the squad:
95 HP, 18 evasion, a light carbine, and no armour of consequence. What it has
is speed 135, movement 7 and a bank of **Burst**.

| Action | What it is |
|---|---|
| Mach Strike | two legs, one turn, an impact worth what the runway was, and a shove the player aims |
| Vector Route | four legs, any turn, priced — a planned line through a formation that can touch something and keep going |
| Impact Chain | Burst spent on the target instead of the ground: three impacts, the last of which moves them |
| Carbine Burst | the ordinary ranged option, chosen for its weight |
| Spool Drive | an activation spent banking Burst, at a real defensive cost |

Burst is a `unit`-scope resource: max 5, starts at 2, regains 1 when its owner
activates. A quiet turn buys a loud one.

**Counterplay**, as measurements rather than nerfs:

- A strike from a standing start is worth well under half the same strike after
  a run-up, because the power was earned by the ground covered.
- Banking Burst costs a whole activation and applies `spooling` (−20 evasion,
  −10 defense).
- A frame with no room to run cannot use its route actions at all.
- Emplacements resist displacement by their own stats, so control degrades
  against anything bolted down.

---

## Testing

- `npm test` — the `Trajectory` group covers the primitive, execution, precise
  displacement, scaling, the vertical slice, the Kell synergy chain, the
  counterplay boundaries and the planning UI.
- `npm run check:trajectory` — the same chain through the real runtime in a
  real page, comparing what the preview promised against what the engine did,
  plus the Studio's ability to author and refuse it.
- The character-name tripwire in `scripts/run-tests.mjs` now also refuses
  content ids that belong to one operator's kit (`burst`, `machStrike`,
  `interdictor`, …) inside `src/combat`, `src/reactions`, `src/mission`,
  `src/perception` and `src/scene`. `auditArchitecture()` covers the trajectory
  half of `App.jsx`.

---

## Known debt

- **The AI does not plan routes.** It scores `displace` as an effect but never
  proposes a trajectory command, so enemy interdictors would not use these
  actions. Deliberate: AI route planning is a search problem worth its own
  phase.
- **Contacts are one target per leg.** Enough for everything authored so far;
  an area contact would be a new field, not a new system.
- **Turn cost is charged from the plan, before the first tile.** An interrupted
  route pays in full. That reads correctly as buying the attempt, but if a
  future action wants pro-rata refunds, that is where to look.
- **`slight` turns are currently unreachable** because diagonal movement is
  off. The content that permits them is forward-looking, not broken.
