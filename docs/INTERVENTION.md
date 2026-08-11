# Pre-resolution interventions

Reactions could already happen *around* an action. They could not change one.

A guard could shield before the damage landed and a pursuer could advance after
the kill, but nobody could say **no** — and "no" is the entire vocabulary of a
defensive specialist.

- Primitive: `src/combat/interventions.js` (pure — no engine, React or content ids)
- Declaration event and verdict handler: `src/App.jsx`
- Reaction effects: `src/reactions/effects.js`
- Authored data: `src/content/gameplay/{reactions,abilities,statuses,units,resources}.json`
- Fixture: `src/content/missions/fixture-duel-arena.json`
- Acceptance: `npm run check:duel`

---

## The gap was a missing moment, not a missing effect

An action used to become its consequence immediately. `useAbility` queued
`abilityUsed`, and by the time anything could respond the shot had been fired.
There was no point at which an action was *chosen but not yet true*, and
without that point a defender can only ever clean up afterwards.

`src/reactions/events.js` used to carry a note saying cancellation needed an
"event-veto contract the queue does not have", and that `STAGES` was where it
would go. That was wrong about the location. Teaching `processNextEvent` to
skip handlers would have made every handler's precondition *"unless somebody
vetoed me"* — the kind of rule that is true in review and false in production
six months later.

The answer was an ordinary event instead.

```
useAbility / move          command handler
  └─ resourceSpent         the cost, first
  └─ actionDeclared        ← the moment. Reactions get their say here.
        └─ abilityUsed     or unitMoved, or nothing at all
```

`actionDeclared` **always resolves**. It just sometimes resolves into nothing.
No handler is ever skipped, no event is dropped, and the continuation invariant
is untouched — which mattered more than anything else here, because the
reaction lifecycle has softlocked this project before.

---

## Four verdicts, and why not five

| | |
|---|---|
| `continue` | it resolves as declared — the default, and what happens when nobody intervenes or every intervention is refused |
| `cancel` | it does not resolve at all |
| `redirect` | it resolves against a different target |
| `replace` | it does not resolve; something else already did instead |

Every defensive fantasy this game has — a taunt, a body block, a parry, a
counter-charge, a suppression that makes someone think better of it — is one of
these four with different content around it. A fifth kind should have to
justify why it is not one of the four.

`continue` is a verdict but never a *proposal*. Offering it as one would let an
author "intervene" to do nothing while consuming the single slot below.

---

## Cost commits at declaration

> **A declared action is paid for whether or not it resolves.**

The mechanism is ordering, not a rule written down somewhere: the resource
events are queued *ahead* of the declaration, so they have already resolved
before anyone can object. The activation is marked spent by the declaration
rather than by the outcome, and recovery is charged either way. A vetoed move
spends the move and goes nowhere.

Being stopped is a thing that happened to you, not a refund. If it were a
refund, intercepting would cost the defender a Command Point to accomplish
nothing except making the attacker try again — and no defensive ability should
be a tempo loss for the person using it.

---

## One intervention per declaration

Not because two could not be meaningful, but because deciding which of two wins
needs a precedence table, and a precedence table silently overrides the
reaction ordering the author already controls through priority, speed and
creation order. First in that order commits; every later proposal is refused
**and recorded**, because a refused intervention is exactly as interesting as
an accepted one when somebody asks why their duelist did nothing.

A second ceiling bounds one causal chain (`perChain: 3`). With today's content
it is a guard rail rather than a balance lever — reaction-driven attacks do not
themselves declare, so an interception war cannot currently start. That is
deliberate: allowing reactions to intervene in reactions is precisely the
recursion the reaction depth cap exists to prevent, and doubling up two bounded
systems that can each re-enter the other is how you get the failure mode this
phase was written to avoid.

---

## Redirecting, and the revalidation that makes it honest

An ability is redirected by naming a different **unit**; a route is redirected
by naming a **tile it was already going to cross**. Getting that wrong was the
first thing that broke when the movement veto was written, and the module now
refuses the mismatch explicitly.

A redirect is revalidated **twice**: once when it is proposed, so an illegal
one is refused while the reaction can still be refunded, and once at
resolution, because the world moves in between. Both use `evaluateTargeting` —
the real one, so range, line of sight, filters and concealment all still apply.
A defender cannot drag a short-ranged swing across the map by standing far away
and volunteering.

When a redirect does not hold, the action **reverts to what was declared and
says why**:

```
The redirect on Hand Cannon did not hold — Target is out of range.
```

Silently doing nothing would be worse. A defensive ability that sometimes fails
for reasons the player cannot see is a defensive ability nobody trusts.

**Not everything is redirectable.** A single-target shot is. A self-buff, an
empty-tile placement and a five-tile blast are not — dragging an area effect
across the map is not a parry, it is a second ability. The flag is set at
declaration time from the ability's own targeting, and `actionIsRedirectable`
is a content condition so a prompt never offers a taunt that could not work.

---

## Voluntary, not forced

Only movement a unit **chose** is declared. `unitForcedMove` opens no
declaration and never will: a mover who did not decide to go has made no
decision for a defender to answer.

That asymmetry is the point, not an oversight. It is what stops a duelist from
vetoing the consequences of a shove she was not part of — and it means the
fixture work from the previous phase is completely untouched, because a mine
still cannot tell the difference between walking and being thrown.

---

## The AI actually decides now

The old policy took anything affordable. Honest about being a stand-in, and
useless the moment the other side had more than one reaction — and it made an
enemy duelist impossible to author, because intercepting is only interesting if
the AI can tell a shot worth stopping from one worth ignoring.

The replacement answers three questions in one currency, expected HP:

```
what does it get me?    the reaction's own effect, forecast for real
what does it stop?      for an intervention, the damage it prevents
what does it cost me?   scarcity, not price
```

Scarcity is linear in what is left *afterwards*, so taking the last point of a
pool is four times as expensive as taking the first. That is the only reason an
AI ever holds anything back. It reads forecasts and never the RNG, so a replay
from the same seed makes the same choices.

It is not tactical judgement and does not pretend to be. Effects that are real
but not forecastable in HP — statuses, advances, timeline pushes — score a flat
modest value rather than a made-up number.

---

## The vertical slice

`duelistFrame` — 96 HP, 42 defense, 30 evasion, movement 5, speed 118. She does
not out-damage anything and cannot hold a line by absorbing it. What she does
is answer one enemy's decisions, one at a time, until they stop making any.

| Action | What it is |
|---|---|
| Challenge | names an enemy **and takes the guard** — the stance that arms everything below, so the whole kit costs an action to switch on |
| Riposte | her ordinary swing, and the same swing she uses out of turn |
| Guard Break | only targetable against someone already committed to fighting her, which is exactly who she has been arranging to fight |

| Reaction | Trigger | Verdict |
|---|---|---|
| Intercept | a challenged adjacent enemy declares an ability at her side | `replace` |
| Hold the Line | an adjacent enemy declares a **move** | `cancel` |
| Take the Hit | anything single-target is declared at an ally | `redirect` onto herself |
| Punish | an action **she** cancelled | a free swing |

Punish is gated on `preventionReason: "cancel"` so it follows the veto that
dealt no damage rather than stacking onto the intercept that already hit.

**Poise** is a `unit`-scope resource: max 3, starts 2, one back per own
activation. Separate from Command Points on purpose — a duelist who drained the
squad every time she said no would be a tax on everyone else's options. The
hard stop costs one of each, so the squad's budget gates the strongest veto.

### Against the other roles

- **Vale** survives the hit. The duelist stops it happening. One is a damage
  sink, the other is a decision sink.
- **Nyx** removes a unit. The duelist removes a unit's *options*, and the
  target is still standing there being unable to use them.
- **The Veteran** decides where things are. The duelist decides whether they
  get to be anywhere else.
- **Kell** answers what he can see. The duelist only answers what is standing
  next to her, which is the price of the guarantee.

### And against the player

`loyalistDuelist` carries the same three abilities and qualifies for the same
four reactions, because they are gated on a status rather than on an owner.
Every intervention the player's frame performs on an enemy activation, the
enemy performs on theirs — there is a test and an acceptance check for exactly
that.

---

## What the player sees

The reaction prompt now states the **consequence**, not just the price:

```
Intercept                              duelist
Bravo deals with you first; Hand       1 poise, 1 reaction capacity
Cannon never resolves.
```

A prompt that names a cost and not an outcome is asking the player to gamble on
their own kit. The trigger line reads in present tense and unfinished — *"Bravo
is about to use Hand Cannon"* — because the whole point of the window is that
it has not happened yet.

The combat log has a **vetoes** filter. An attack that produced no damage entry
at all reads as a bug until you can see the line that says why.

---

## Causality

```
Bravo
└─ actionDeclared              Hand Cannon at Ward
   └─ (intercept reaction)     depth 1, viaReaction
      └─ abilityUsed           Riposte, Duelist → Bravo
         └─ damageResolved
   └─ actionPrevented          reason: replace, by Duelist
      └─ (punish reaction)
```

One `chainId` throughout. A cancelled action and a resolved one are the same
shape in a trace; one just has a shorter tail.

---

## Validation

The Studio derives its trigger, effect and condition lists straight from the
engine registries, so all of this is authorable without a line of editor code.
Validation refuses the mistakes that would otherwise be silent:

- an intervention effect on any trigger other than `actionDeclared` — an
  action can only be changed before it resolves, and a cancel hung on
  `unitDestroyed` would do nothing forever with no clue why
- cancelling something that has already been prevented
- a cost larger than the resource's maximum, which could never be paid

and warns about a veto that costs nothing, or one with no per-activation or
per-chain limit.

---

## Performance

```
intervention lookup + refusal      0.00025 ms
whole declared command             0.777 ms   (including battle construction)
```

The declaration is two object allocations and a bounded list append. The record
retains 24 declarations, pruning only resolved ones — an open declaration is
never dropped, because losing it would strand the action waiting on its verdict.

---

## Testing

- `npm test` — the `Interception` group covers the closed kind list, the
  one-per-declaration rule, the chain cap, a double resolve, the unchanged
  default path, cost commitment, the movement veto, redirect and its two
  failure modes, area refusal, route truncation, intercept, an intercept that
  kills the actor, a dead actor with no intervention at all, forced movement,
  the punish follow-up, a whole-battle soak, save/reload mid-declaration, the
  AI scorer, the enemy duelist, determinism, an engine-names-nothing check and
  a perf guard.
- The `Continuation` group pins the invariant as a property rather than by
  example — deliberately written **before** any of this landed.
- `npm run check:duel` — 74 checks through the real runtime in a real page,
  every one of which asks `battleContinuation` afterwards.
- The character-name tripwire refuses the duelist kit's ids inside the generic
  directories, verified against an injected probe with five fake branches.

---

## Known debt

- **Routes do not declare.** `trajectory` executes a multi-segment plan
  synchronously; making it interceptable means deciding *where along the route*
  the interception lands, which is a real design question rather than a wiring
  job. Ordinary movement and abilities both declare.
- **Fixture activation does not declare.** Setting off your own charge is a
  command, and nothing yet wants to veto it.
- **Reaction attacks do not declare**, so an intercept cannot be intercepted
  (above). Deliberate, and the reason `perChain` is currently a guard rather
  than a lever.
- **Movement redirect ships unused.** The engine truncates a route to a tile on
  it and there are tests for it, but no shipped ability uses it, because
  choosing the stop tile is a targeting decision no current reaction effect
  makes. The hard stop cancels instead.
- **The AI does not seek out interceptions.** It scores them well when offered
  one; it will not manoeuvre a duelist into position to be offered more.
