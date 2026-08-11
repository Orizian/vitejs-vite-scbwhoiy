# Commanded sequencing

Taking several activations that are already coming and choosing what order they
happen in.

Not extra turns. Not speed. Nobody acts twice, nobody loses a turn, nothing is
refunded — the same units act the same number of times, in a different order.
That restriction is the design, not a limitation of it: a commander who *grants*
turns breaks the initiative system, and a commander who only sequences makes the
initiative system the interesting part.

- Primitive: `src/combat/sequencing.js` (pure — no engine, React or content ids)
- Adapter, command and event: `src/App.jsx`
- Authored data: `src/content/gameplay/abilities.json`
- Fixture: `src/content/missions/fixture-command-arena.json`
- Acceptance: `npm run check:command`

---

## The invariant, first

> Before and after a reorder, every unit that can act owns exactly one upcoming
> activation, and the set of units owning one does not change. Only the order
> does.

That property was written as a test — `assertOwnsOneActivationEach`, in the
`Sequencing` group — and it passed against the engine **before any reorder code
existed**. The failure mode of a sequencing bug is a unit acting twice or never
again, and both are invisible for several activations; a property that is only
added alongside the feature is a property that has never seen the engine
without it.

---

## Why this is not a timestamp rewrite

The obvious implementation is to permute the selected units' `nextActionTime`
values among themselves. It is wrong twice over, and the first reason is fatal:

**It cannot express every permutation.** Activation order is decided by

```js
if (a.time !== b.time) return a.time - b.time;
if (a.speed !== b.speed) return b.speed - a.speed;   // faster first
return a.creationOrder - b.creationOrder;            // stable
```

Two units sharing a timestamp are separated by speed, then creation order. Deal
them equal numbers in a different arrangement and the comparator sorts them
straight back — the player's chosen order simply does not happen, with nothing
reported. That case is reachable: equal-speed units are scheduled identically at
battle start.

**And a rewritten timestamp is a lie every other reader believes.** `turnEnded`
recovery, `timelineModified` and the HUD all treat that number as *when this
unit acts*. A commander who edits it has moved the baseline for anything that
later does arithmetic on it.

### What it is instead

A **view over time**. The plan captures the multiset of timestamps the selected
units already own and re-deals that exact multiset in the commanded order. The
comparator consults the dealt slot instead of the unit's own clock, and breaks
ties by the commanded index:

```js
if (a.time !== b.time) return a.time - b.time;
if (a.sequenceIndex != null && b.sequenceIndex != null && a.sequenceIndex !== b.sequenceIndex) {
  return a.sequenceIndex - b.sequenceIndex;          // ← the commanded order
}
if (a.speed !== b.speed) return b.speed - a.speed;
return a.creationOrder - b.creationOrder;
```

Because the slots come out of the set those units already held, nobody outside
the selection shifts by a single position, and the activation count is unchanged
*by construction* rather than by promise. Because the commanded index breaks
ties, every permutation is expressible even when the numbers collide.

`unit.nextActionTime` is never written. Ordinary haste and delay keep operating
on the truth, a save is exact because it is the same plain numbers, and when the
window is spent the layer empties and ordering reverts to plain time with
nothing to clean up.

`timelineCandidates` is the single place the view is applied — so the selector,
the preview rail and the planner cannot disagree about the order.

---

## Enemy activations are barriers

```
Kell → Enemy A → Reyes → Vale
```

A basic reorder may **not** turn that into `Kell → Reyes → Vale → Enemy A`. The
window walks the upcoming list and stops at the first hostile; allies behind it
report `an enemy acts first` and cannot be picked. The refusal is visible in the
panel, in the command's errors and in the plan.

This is what keeps initiative a real system rather than a suggestion. The mode
is authored (`hostileBarrier: "stop" | "ignore"`), so a later endgame command
that bends the rule is a content change — but nothing ships with `ignore`.

---

## When the command stops speaking for a unit

Three rules, all cheap and all deterministic:

| | |
|---|---|
| **it acted** | the slot is consumed at `unitActivated`, not at `turnEnded` — a unit destroyed mid-turn has still had its turn as far as the command is concerned |
| **it died or went dormant** | dropped, and the order closes over the gap |
| **its own clock moved** | dropped, and logged |

The third is the one worth arguing about. A commanded unit that gets hasted or
delayed has been rescheduled by something authoritative; holding it in a slot
would make the sequencing layer outrank the timeline instead of sitting on top
of it. So the timeline wins, and `activationOrderDropped` says so — a commander
whose order quietly stops being followed is worse than one whose order is
refused, because the player planned around a sequence and has no way to discover
it changed.

---

## Cost, and whose turn it is

Using the command is the commander's **action for that activation**. She is not
getting timeline manipulation on top of a full attack: she spends the action,
pays Command Points, and her activation then finishes normally.

She also cannot sequence *herself*. She is standing in the present, not waiting
in the queue — there is no slot of hers to move, and pretending otherwise is
exactly where "take another turn" creeps in.

Command Points are the existing squad-wide resource, so the command competes
directly with reaction fire, interception and every other coordinated response.
Making that work required fixing a real bug: `resourceSpent` only ever read
`unit.resources[id]`, so **a faction-scoped ability cost deducted nothing at
all** and reported nothing. Costs are scope-aware now, in the event handler, both
validators and the ability view model.

---

## Ordinary rules resume immediately

The reorder sequences already-earned activations and nothing else. Once a
commanded unit acts:

- its recovery is charged normally,
- `modifyTurnDelay` moves its *next* activation normally,
- a status applied to it ticks normally,
- reactions and interventions inside its turn behave identically.

There is deliberately no "reordered turn" mode anywhere in the engine. A
reordered turn is an ordinary turn that happened at a different point in a list.

---

## The vertical slice

`battlePlan` on the assault chassis: 2 Command Points, up to 4 allied
activations, 2600 time units of reach, enemies as barriers.

The command arena opens on a deliberately wrong order — the sniper who wants to
be holding a lane is scheduled *after* the frame that walks somebody into it:

```
natural     Reyes → Veteran → Nyx → Kell
commanded   Kell → Reyes → Veteran → Nyx
```

Then, with no combo code anywhere:

1. Kell takes his ordinary turn and prepares a firing lane.
2. Reyes takes an ordinary support turn.
3. The Veteran runs an ordinary route and shoves an enemy across row 8.
4. Kell's ordinary overwatch reaction becomes eligible and the reaction
   lifecycle runs exactly as it always does.
5. Nyx takes her ordinary activation, once.

The only thing the ability changed was the order.

---

## What the player sees

```
UPCOMING                       COMMAND ORDER
  1  ▣ Sniper Mech             1. Sniper Mech
  2  ▣ Support Mech            2. Support Mech
  ·  ■ Rifle Grunt   enemy     3. Interdiction Frame
  —  ▣ Stealth Mech            4. Stealth Mech
     an enemy acts first
                               COST: 2 Command Points
```

Click an eligible portrait to append it to the order; click it again to remove
it and renumber the rest. No timestamps anywhere — a player who has to decode
numbers to know what they bought has been handed a spreadsheet, not a commander.

Click-to-sequence rather than drag-and-drop because it is unambiguous about
*what number this unit is*, which dragging portraits along a rail is not.

The combat log gains an **orders** filter. A turn arriving out of its natural
place is otherwise unexplainable from the rest of the log.

---

## Preview and execution cannot disagree

`createCommandPlanModel` is built from `planActivationWindow` and
`validateOrder` — the same two calls the command validator makes. The plan is
recomputed at validation *and again* at execution, because a preview the player
looked at three seconds ago is a claim about a world that may have moved, and
the difference between a stale plan and a live one is a unit acting twice.

`projectCommandedOrder` predicts the resulting order using the same three rules
the live comparator uses. There is a test that compares the prediction against
what actually happened, and an acceptance check that does it in the browser.

---

## Causality and the log

```
Vale — Battle Plan
  original   Reyes → Veteran → Nyx → Kell
  new        Kell → Reyes → Veteran → Nyx
  cost       2 Command Points
```

`activationOrderChanged` is an ordinary event carrying both orders, the actor,
the ability, the cost and the window bounds. Both orders, not just the result:
what makes a reorder legible is the difference.

---

## Performance

```
plan a window          0.013 ms
full preview model     0.030 ms   (9 units)
```

Timeline windows are small and the planner is one pass over the sorted
candidates. Nothing here justifies an index, and correctness matters far more
than either number.

---

## Testing

- `npm test` — the `Sequencing` group covers the ownership property across a
  whole battle, iteration-order independence, tied timestamps, the barrier, the
  reach limit, the self-exclusion, the selection cap, a plain permutation,
  counted activations, every refusal, the Command Point charge, a commanded unit
  dying, a commanded unit being rescheduled, `modifyTurnDelay` afterwards,
  save/load mid-window, reactions inside a commanded turn, interventions inside
  one, preview parity, exclusion reasons, an engine-names-nothing check and a
  perf guard.
- `npm run check:command` — 76 checks through the real runtime in a real page,
  including the full planning panel driven through the actual input reducer.
- The character-name tripwire refuses the command kit's ids inside the generic
  directories, verified against an injected probe with four fake branches.

---

## Known debt

- **The AI does not sequence.** The primitive is faction-agnostic and an enemy
  commander could use it, but no scoring path chooses an order — building one
  is a planning search, not a wiring job, and it is deliberately out of scope.
- **The commander cannot include herself.** `includeActive` exists in the
  authored block and the planner honours it, but no shipped ability sets it,
  and moving an in-progress activation is a genuinely different problem.
- **Enemy activations cannot be crossed.** `hostileBarrier: "ignore"` is
  implemented and validated; nothing ships with it, because an endgame command
  mastery that bends the rule should arrive as a deliberate design decision.
- **One command at a time.** Issuing a second replaces the first. Layering two
  partial orders has no clear meaning and no content wants it.
