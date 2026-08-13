# The tactical language

Four gaps, none of them a subsystem. Each one was a place where the engine
could *do* something it could not *ask about*, or could ask about something it
could not act on.

- Vocabulary shared by engine and tooling: `src/combat/authoring.js`
- Balance queries: `src/combat/resources.js` — `readResource` / `resourceQueryHolds`
- Conditions: `src/App.jsx` (effects) and `src/reactions/conditions.js` (reactions)
- Scaling, triggers and the operator migration: `src/App.jsx`
- Acceptance: `npm run check:support` (checks 15–18 and the Studio block)

---

## Asking what a balance is

Everything the engine could do to a resource, it could do without ever knowing
the number: spend it, restore it, transfer it, refuse when there was not
enough. What no authored condition could do was *ask*.

That gap is why a steal has never been authorable. A steal that is offered
against a target carrying nothing is not a mechanic, it is a wasted turn, and
the only way to avoid it was an engine branch that knew which resource mattered.

```json
{ "type": "resourceBalance", "of": "target", "resourceId": "burst",
  "compare": "atLeast", "value": 1 }
```

`atLeast` · `atMost` · `equal` · `notEqual`, against a count or — with
`percentOfMax` — against a share of the pool's own ceiling. The percentage
form is the one that survives a rebalance: doubling a maximum does not send
you back through every condition that mentioned it.

**Scope is never named.** `of` nominates an *owner* — the acting unit or the
one being acted on — and which pool that owner actually touches comes from the
resource definition, through the same resolver that prices an ability. That is
not a nicety. This project has now shipped the same scope bug three times, each
time because a second lookup read `unit.resources` directly, and each time the
symptom was a shared pool silently reading zero. There is one door.

Both condition registries have it. They are genuinely separate systems — an
effect condition is a function of `(context, condition)` over battle state, a
reaction condition is a function of `(condition, ctx)` over a pure adapter —
so each got its own handler in its own idiom, and the comparison itself lives
in the resource layer where both can reach it.

### Proof, in shipped content

```
Spool Drive       burst 5/5   →  not offered   "Requires room in the Burst rack."
                  burst 2/5   →  offered

Tactical Relay    Command Points 4/4  →  not offered
                  Command Points 1/4  →  offered
```

One is a personal rack, the other is the squad's shared budget. Same condition
type, same fields, no scope at either call site.

---

## A mark worth a number

Statuses could change stats. Conditions could test for a status. Damage could
scale from a named source. What was missing was the join: a damage effect could
not read a status the target was carrying.

Without it, "marked targets take more" has to be an engine branch that knows
what a mark is — and then ionised, exposed, braced and whatever comes next each
need their own.

```json
"scaling": {
  "from": "targetStatus", "statusId": "marked",
  "mode": "multiplier", "perUnit": 0.15
}
```

`statusId` for one condition, `statusTag` for a family. Tags count: an ability
that scales from `systemDamage` is worth more against a frame that has lost
two systems than one that has lost one, with no list to maintain. A status *id*
is worth one at most, because reapplying a status refreshes its duration rather
than stacking — counting it twice would be counting something that is not there.

`power` adds to the formula's input before it runs; `multiplier` scales the
result afterwards. They are deliberately different: adding power to a
percent-of-max-HP formula and multiplying its output are not the same mechanic,
and an author has to be able to say which one they meant.

### The bug underneath

The forecaster never applied scaling at all. Not the new source — *any* of
them. Every route bonus and every chain decay this project has shipped was
promised at one number and delivered at another, and nothing caught it because
no test compared the two.

There is one function now, `effectScaling`, called by the executor and the
forecaster on the same context. The acceptance run asserts the equality
directly:

```
unmarked   projected 137
marked     projected 208   →  landed 208
```

---

## Moments a status can act on

The representation was always generic — a status carries a list of
`{ event, effects }` — but exactly one moment ever called it. Every passive
that was not "burn at the start of your turn" had to be built as something else.

Six moments now:

| | | |
|---|---|---|
| `activationStart` | the holder is about to act | burning, poison, upkeep |
| `activationEnd` | the holder has finished | cooling cycles, decay, payoffs |
| `unitDamaged` | took damage and survived | retaliation, reactive plating |
| `unitMoved` | finished a move | trails, leaks |
| `killedUnit` | landed a killing blow | momentum, trophies |
| `statusApplied` | gained any status | adaptation, resonance |

The admission criterion was **can this moment say unambiguously who the effect
lands on**. Poison lands on the holder; retaliation lands on the attacker. So a
trigger names a `target` of `holder` (the default) or `counterpart`, and only
the moments that *have* a second party accept the second value — validation
refuses the rest.

Two candidates failed that test and are deliberately absent:

**The holder's own destruction.** `unitDefeated` clears the unit's statuses, so
a death rattle would have to read a list that no longer exists, from a unit
that no longer acts. Resurrecting it for one trigger is a different feature
with different rules about what a dead unit may do.

**A status being removed.** "Removed" covers expiry, cleanse and defeat. Those
are three different fictions with three different actors, and one event name
for all of them would give authors a hook that does the wrong thing two times
out of three.

### Causality, and the ceiling

A trigger queues a `statusTriggered` event and then resolves its effects
through the ordinary path, so everything it causes inherits the cause of the
blow that caused it. A retaliation is attributable to the attack that provoked
it, three steps later, without the trigger mechanism knowing anything about
attribution.

That inheritance is also the safety property. Two frames both wearing reactive
plating will hit each other back forever — and that is a legitimate thing to
author, so nothing refuses it. What stops it is the causal depth every other
cascade in this engine already stops at:

```
14 exchanges · queue drained · both frames still standing
```

No new recursion framework, no private counter, no global ban on nested
triggers. `chainExhausted` was already there, imported, and used only by a
test; it does real work now.

Three further guards, each of which costs something real if dropped: the status
list is copied before iteration, because a trigger may cleanse the status that
is firing; a status cleansed by an *earlier* trigger in the same pass is
skipped, because it is no longer carried; and a holder killed inside its own
pass stops, because a corpse retaliating is exactly the impossible effect worth
refusing.

---

## One operator id

An operator entry carried a registry key **and** an optional `ref`, and they
were allowed to differ. For one pilot they did — key `commander`, ref `vale` —
while three others carried no `ref` at all and fell back to their key.

Both were live. The campaign roster, deployment and repair addressed operators
by key. Combat links, reaction ownership and mission unit refs addressed them
by `ref`. Nothing said which to use where, and the only reason it worked was
that seven of the eight agreed with themselves.

**The entry key is now the id, everywhere.** `ref` is gone from the schema, and
its presence is a validation error *even when it agrees with the key* —
agreeing today is precisely how the last one survived long enough to disagree.

```
legacy save   roster.commander
migration     → roster.vale          (once, at load, version 3 → 4)
runtime       vale
```

The alias lives in one map consulted in one place. Nothing downstream resolves
it, because the point of a migration is that the runtime stops having two
answers. Stored mission results are re-keyed too — they carry a per-operator
condition report, and a stale key there would have quietly dropped a pilot's
record.

Scene speakers moved with it: the same character now has one id whether she is
shooting or talking.

---

## Authoring

Every list above is exported from `src/combat/authoring.js` and consumed three
ways: the engine implements it, the validator checks against it, and the Studio
prints it as a closed vocabulary. A unit test asserts the engine's registries
and the validator's lists are the same set, so the two cannot drift.

The Studio needed one change to support this — a schema field may now carry its
own `vocabulary`, instead of the editor mapping a `typeKey` to a hard-coded
list. Status triggers were the first field to use it.

### What validation refuses

| | |
|---|---|
| resource | unknown id, unknown comparison, negative threshold, over 100 percent, unknown owner |
| scaling | unknown source, unknown mode, non-numeric value, a status source naming nothing, an unknown status, a tag nothing carries |
| triggers | an unknown moment, a counterpart where the moment has none, no effects, a status that reapplies itself the instant it lands |
| operators | a leftover `ref`, a non-slug id, a duplicate, a link or reaction naming a pilot that does not exist |

---

## Testing

- `npm test` — the `Tactical language` group, 33 tests: both scopes on both
  condition registries, the default comparison, percent-of-max, an absent pool
  refusing rather than reading zero, forecast/execution parity in both
  directions, tag counting versus id counting, every trigger moment, a dead
  holder answering nobody, causal attribution across an exchange, the bounded
  ping-pong, the save migration, and a source-reading check that fails if any
  new function names a resource, a status or a pilot.
- `npm run check:support` — 87 checks, of which 13 are this phase.

---

## Known debt

- **Conditions cannot count nearby units.** Lone Wolf, outnumbered, formation
  and surrounded are what this blocks. The counting is a dozen lines over
  helpers that already exist; what is not trivial is whether counting
  *hostiles* reads the board or the asking faction's knowledge. This project
  has a standing position that a reaction must not become a detection oracle —
  `knowsSubject` exists for exactly that — and answering the same question for
  a count is a design decision, not a sweep item. Deferred deliberately.
- **Nothing in combat inflicts system damage.** Unchanged from the support
  phase, and now slightly more visible: `targetStatus` scaling by the
  `systemDamage` tag is authorable and there is nothing to author it against.
- **No AI use of any of this.** The AI reads conditions through the shared
  evaluator, so an ability gated on a balance is correctly refused. It does not
  *plan* toward a balance, a mark or a trigger.
