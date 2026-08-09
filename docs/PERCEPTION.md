# Knowledge and perception

What a faction *believes* about the battlefield, as opposed to what is true.

Before this existed, AI decision-making read `state.units[id].x` directly. Every enemy knew where every player unit was, always, through walls, and no amount of stealth content could have changed that. This is the layer that makes hiding mean something.

- Runtime: `src/perception/` — `channels.js`, `knowledge.js`, `sensors.js`, `runtime.js`, `view.js`
- Bridge into the engine: the `PERCEPTION_ENGINE` adapter in `src/App.jsx`
- Fixture: `fixture-knowledge-slice.json` (Vent Row)
- Acceptance run: `npm run check:knowledge` · Benchmark: `npm run bench:knowledge`

---

## The three states

```
   unseen  ──── an observation ────▶  suspected  ──── a good enough channel ────▶  acquired
      ▲                                   │                                            │
      └──── the lead goes cold ───────────┘◀───────── the sightline breaks ─────────────┘
```

| | |
|---|---|
| **unseen** | No usable information. The unit does not exist as far as this faction's decision-making is concerned — it is not in the AI's target list, it exerts no threat, and it has no position. |
| **suspected** | A contact. Something is, or was, around here. Enough to move toward, search, or take cover from. **Never** enough to shoot. |
| **acquired** | A firing solution. This faction may act on the real tile. |

Records are keyed **by faction**, never by unit. That single decision is what makes "two hostile factions hold different beliefs about the same physical unit" fall out for free instead of needing a special case, and it is why a defector brings their own eyes but not their old side's map.

All of it lives in `state.perception` as plain serializable data, so it rides in a save and replays identically from a seed.

---

## Where the gate is

```
             ┌──────────────────────────────┐
  truth ────▶│  PERCEPTION_ENGINE (adapter) │────▶  the sweep  ────▶  records
             └──────────────────────────────┘
                                                                        │
  AI decision-making ◀──── perception/view.js ◀──────────────────────────┘
```

`view.js` is the only position API the AI may call. Everything above the line reads real coordinates; everything below reads a record. An AI that calls `believedPositionOf` **cannot** cheat, because the true coordinate is not reachable from what it is handed.

Gated: `enumerateAiTargets`, `tilePositionScore`, `objectivePositionScore`, `nearestHostileFacing`, and the reaction layer's `moveTowardNearestHostile`.

**Scope of the gate:** knowledge is required for units the acting faction is *hostile* toward. Own-team, allied and neutral units are treated as known — a medic knowing where the friendly civilians are is not an exploit, and hostility is what the guarantee is about. A neutral that turns hostile is gated from that moment, using the record the sweep has been keeping all along.

Set `perception: false` on `createBattle` and everything is visible again. That is what the A/B benchmark toggles, and it is the fastest way to tell whether a behaviour change came from this layer.

---

## Channels

A channel says what physics it obeys and how far up the ladder it can push a contact **on its own**. Channels are not additive: two suspicions do not make a firing solution.

| | LOS? | Through concealment? | Position | Ceiling |
|---|---|---|---|---|
| `optical` | yes | no | exact | acquired |
| `thermal` | yes | **yes** | exact | acquired |
| `signal` | no | yes | approximate | **suspected** |
| `acoustic` | no | yes | approximate | **suspected** |
| `intel` | no | yes | exact | acquired |

Sensors and emissions are ordinary content on a chassis, a status or a piece of equipment:

```jsonc
// A cloak field
"perception": { "emissions": { "optical": 0 } }

// A thermal optic
"perception": { "sensors": { "thermal": { "range": 8 } } }
```

Sensors compose by **max** (two pairs of binoculars do not see twice as far). Emissions compose by **product**, so nothing can out-stack a suppressor. A unit with no `perception` block is an ordinary body with ordinary eyes, which is what every pre-existing content entry is.

Perception uses **reciprocal** line of sight. The engine's Bresenham walk is directional — it breaks diagonal ties in the order it happens to step — which was invisible while sight only validated an attacker's shot but produced genuine one-way visibility once it decided who can see whom. Targeting still uses the existing directional check; the two are allowed to differ, and the AI simply repositions until its shot is also legal.

---

## Signatures

A unit that fires, shouts or lights up an EM band is loud for a while and then is not.

```js
DEFAULT_EVENT_SIGNATURES = {
  abilityUsed: { actor: "sourceUnitId", emits: [ acoustic 1, signal 1 ] },
  ...
}
```

Data, not branches. `actor` is spelled out per event because the simulation is not uniform about it — an attack names its actor `sourceUnitId` while a defeat names its subject `unitId`, and guessing is how a signature silently never fires. An ability tagged `silent` in content makes no noise; one tagged `loud` makes twice as much.

This is the whole of the Keraunos firing-signature story, and it is why a garrison behind a wall still knows *someone* is out there.

---

## Time

Every duration is counted in **the believing faction's own activations**. Not seconds, not global activations — "four activations ago" has to mean four of *my* turns, or a twelve-unit battle would forget everything between one of my units acting and the next.

| | default | |
|---|---|---|
| `suspectedDecayActivations` | 4 | how long a stale contact survives |
| `investigatedDecayActivations` | 1 | once a searcher has stood on the tile and found nothing |
| `searchArrivalRadius` | 1 | how close counts as having searched it |
| `reconSweepActivations` | 12 | the escalation threshold, below |
| `reconHoldActivations` | 2 | how long a painted contact is guaranteed |

Losing a sightline demotes **acquired → suspected immediately**, keeping the last-known tile. That is the whole of "contact lost", and keeping the tile is what makes "he was right there a second ago" work. Going from suspected to unseen throws the position away, because a stale guess allowed to persist forever is omniscience with extra steps.

---

## Search, and the escalation

A unit with no firing solution moves toward the freshest suspected contact and, if it has nothing at all, toward its faction's **search anchor** — an *area*, never a unit. The anchor is seeded at deployment with the centre of the hostile deployment (you do not walk into an engagement with no idea which direction it is in) and is updated to wherever a contact was finally forgotten.

Fog of war has one failure mode that is not interesting: two sides that cannot resolve each other and stand there until the activation cap. Two tiles apart with a wall between them, hearing each other every turn, is a real tactical situation and a terrible battle. Reconnaissance escalates in two stages on one counter:

| after `reconSweepActivations` without a firing solution | |
|---|---|
| the faction has **no contact at all** | it is handed SUSPECTED contacts — a direction to search |
| the faction has **contacts but no solution** | those contacts are painted ACQUIRED, held for two activations |

**Stage two can only escalate a trace the faction already had.** A unit that has never been detected is never painted, which is exactly what keeps a stealth build meaningful. In an ordinary engagement neither stage is ever reached. Set `reconSweepActivations: 0` for a mission built on the standoff.

Searching units also prefer ground with a **line** on the last-known position rather than ground merely near it — a painted contact behind a wall is still unshootable, so the search has to be about angles.

---

## Authoring

Four actions and one condition, all generic:

```jsonc
{ "type": "setKnowledge", "factionId": "foe", "unitRefs": ["nyx"], "state": "acquired" }
{ "type": "shareKnowledge", "fromFactionId": "foe", "toFactionId": "player", "maxState": "suspected" }
{ "type": "emitSignature", "unitRefs": ["nyx"], "channel": "thermal", "strength": 2, "duration": 2 }

{ "knowledgeState": "nyx", "factionId": "foe", "atLeast": "suspected" }
```

and a trigger, so "the moment they spot you" is one beat:

```jsonc
{ "trigger": "knowledgeChanged", "factionId": "foe", "unitRef": "nyx", "to": "acquired" }
```

Reactions gain `knowsSubject`, which any reaction that responds to a hostile should carry — without it an overwatch shot is a detection oracle that tells the player exactly where an invisible unit is.

**Nothing shares knowledge implicitly.** A unit changing sides brings itself, not its old side's map, because the record lives with the faction rather than the unit. A defection that is meant to come with the dossier is a scripted `shareKnowledge` — which is the beat an author wants control over anyway.

### The one place a briefing is granted automatically

An objective that names unit ids briefs the faction that owns it: a SUSPECTED contact at the target's position *at battle start*, marked persistent so ordinary decay leaves it alone. Being ordered to destroy something implies being told where it is. It is a snapshot — a briefed unit that walks away leaves the briefing pointing at empty ground, which is correct — and it is still only suspected, so the squad has to go and look before it can shoot.

---

## Debugging

- **Developer tools → Knowledge** — every faction's contacts, its clock, how long it has been without a firing solution, and where it is sweeping.
- **Intel** on the camera controls — a dashed ghost on the tile your squad last had eyes on. Dimmed once a unit has searched it and found nothing.

---

## Cost

`npm run bench:knowledge` A/Bs the layer inside one build, so the delta is the feature and not a content change.

| | per activation | |
|---|---|---|
| 8×8, 6 units | 0.48 → 0.55 ms | +15% |
| 18×14 fixture, 5 units, 3 sensors | 0.80 → 0.97 ms | +21% |
| 34×44, 18 units | 0.95 → 1.59 ms | +67% |

One sweep of the 34×44 board is 0.58 ms. Two things keep that from being paid repeatedly: a **board stamp** skips a sweep entirely when nothing that could change an observation has moved, and one **line-of-sight memo per sweep** halves the Bresenham walks, since sight is reciprocal and both factions ask about the same pairs.

The cost scales with observer × subject pairs. If a battle ever fields enough units for that to matter, the next step is incremental updates keyed on the unit that actually moved rather than a full re-sweep — the record shape does not have to change for that.

---

## What this is for

Nyx's kit is not built yet, and nothing here names her. What is built is the information architecture it consumes:

| her design calls for | this layer provides |
|---|---|
| Unseen / Suspected / Acquired | the three states, faction-scoped |
| a cloak that beats eyes but not heat | `emissions.optical: 0` against a channel that pierces concealment |
| thermal vents that give her away | `emitSignature` on the thermal channel, from mission data |
| enemies searching her last position | suspected contacts, decay, and the search anchor |
| counter-stealth equipment | a `sensors` block on a piece of equipment |

Her Heat economy, cloak durations, Velocity and Blade are still to come. None of them requires a change here.
