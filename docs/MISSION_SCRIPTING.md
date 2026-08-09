# Mission scripting

How an authored mission changes shape mid-battle: phases, triggers, actions, factions and groups.

Everything here is mission data. The simulation contains no mission-specific code, and the renderer contains no mission-specific logic — a test asserts it (`Grayfield slice / The engine contains no reference to the fixture`).

- Runtime: `src/mission/` — `events.js`, `conditions.js`, `actions.js`, `runtime.js`, `factions.js`
- Bridge into the engine: the `MISSION_ENGINE` adapter in `src/App.jsx`
- Reference mission: `src/content/missions/fixture-grayfield-slice.json`
- Editor: the **Factions**, **Groups**, **Objectives**, **Phases** and **Triggers** tabs

---

## The shape of it

```
authoritative simulation
        │  typed events (unitMoved, damageResolved, unitDefeated, …)
        ▼
   mission event stream        unitEnteredRegion, unitHpBelowThreshold, …
        │
        ▼
   triggers + conditions       "which beats want this event?"
        │
        ▼
   action list                 ◆ simulation   → back into the engine
        │                      ▷ presentation → queued for the renderer
        ▼
   phase state machine         approach → engagement → betrayal → …
```

The runtime lives **inside battle state** (`state.mission`). That one decision buys three things: a headless run executes the same beats as the game, deterministic replay reproduces a scripted battle exactly, and a save contains the current phase, the fired-once ledger and any half-executed beat — so reloading never replays a cinematic that already happened.

---

## Phases

A phase owns a set of objectives, which groups are awake, and a list of actions that run when it begins.

```jsonc
{
  "id": "betrayal",
  "name": "The turn",
  "enterWhen": { "trigger": "objectiveCompleted", "objectiveRef": "surviveInterception" },
  "next": "counterattack",          // where completePhase hands off
  "objectives": [],                 // replaces the active set on entry; empty = leave it alone
  "activateGroups": [],             // wake these groups
  "deactivateGroups": [],           // put these to sleep
  "onEnter": [ /* actions */ ],
  "onExit":  [ /* actions */ ]
}
```

`enterWhen` takes a trigger, a condition (`when`), or both. A phase with neither is only reachable through an explicit `startPhase` action. The editor warns about a phase nothing can ever enter.

On entry the declarative parts run first (objectives, groups), then `onEnter`. `completePhase` runs `onExit` and starts `next`.

`startPhaseId` names the phase the mission begins in; it defaults to the first one.

---

## Triggers

A trigger matches one mission event by field equality:

```jsonc
{ "trigger": "unitEnteredRegion", "unitRef": "vale", "regionRef": "westernKillZone" }
{ "trigger": "objectiveCompleted", "objectiveRef": "surviveInterception" }
{ "trigger": "unitDestroyed", "unitRef": ["prototype", "loyalistAce"] }   // array = any of
{ "trigger": "unitHpBelowThreshold", "unitRef": "vale", "percent": 75 }   // percent = at or below
```

Every event type is automatically a trigger — that is what makes the vocabulary data-driven rather than a chain of special cases. Adding an event to `MISSION_EVENT_TYPES` adds a trigger with no other code.

**Event vocabulary:** `battleStarted`, `activationStarted`, `activationEnded`, `unitMoved`, `unitEnteredRegion`, `unitLeftRegion`, `attackDeclared`, `attackResolved`, `unitDamaged`, `unitHpBelowThreshold`, `unitDisabled`, `unitDestroyed`, `wreckCreated`, `repairCompleted`, `resourceChanged`, `objectiveProgressed`, `objectiveCompleted`, `objectiveFailed`, `groupAlerted`, `groupSpawned`, `eliteSpotted`, `factionChanged`, `terrainDestroyed`, `phaseStarted`, `phaseCompleted`, `missionFactSet`, `sceneCompleted`.

The editor generates each trigger's form from that event's declared fields, so you cannot reference a field the event does not carry.

### Conditions

Conditions are asked about *current state* and compose:

```jsonc
{ "all": [ { "phase": "engagement" }, { "not": { "missionFact": "warnedAlready" } } ] }
{ "any": [ { "unitHpBelow": "vale", "percent": 40 }, { "teamUnitsAlive": "foe", "atMost": 2 } ] }
```

**Available:** `all`, `any`, `not`, `phase`, `missionFact`, `campaignFlag`, `unitAlive`, `unitHpBelow`, `unitInRegion`, `teamUnitsAlive`, `objectiveStatus`, `groupActive`, `factionRelationship`, `activationCount`, `once`.

A beat may have a trigger, a condition, or both. With a condition and no trigger it is re-evaluated on every event.

### Beats

```jsonc
{
  "id": "valePressed",
  "trigger": { "trigger": "unitHpBelowThreshold", "unitRef": "vale", "percent": 75 },
  "when": { "phase": "interception" },
  "phase": "interception",     // optional hard scope
  "once": true,                // default; the ledger survives save/reload
  "priority": 80,              // higher runs first when several fire together
  "actions": [ /* … */ ]
}
```

---

## Actions

Every action declares its **authority**, and the editor colour-codes them.

### ◆ Simulation — changes authoritative battle state

Routed through the same machinery ordinary gameplay uses, so they produce real events, real log lines and show up identically in a save.

| Action | What it does |
|---|---|
| `setMissionFact` | Records a mission-local fact later conditions read. |
| `setCampaignFlag` | Queues a campaign flag, applied when the mission resolves. Deduplicated, so a re-entered phase cannot grant a reward twice. |
| `startPhase` / `completePhase` | Drives the phase machine. |
| `addObjective` / `removeObjective` / `replaceObjectives` | Changes the active objective stack. |
| `completeObjective` / `failObjective` | Forces an outcome. A failed **required** objective loses the mission. |
| `activateGroup` / `deactivateGroup` | Wakes or sleeps a group. Dormant units stay on the map and take no turns. |
| `spawnGroup` | Places a reserve group, optionally inside a region. Never spawns twice. |
| `changeFaction` | Rewrites how two factions regard each other. |
| `changeUnitTeam` | Moves units to another team **in place** — HP, statuses, position and timeline slot all survive. |
| `moveUnit` | Walks a unit through the real pathfinder (`mode: "path"`) or places it (`"teleport"`). |
| `performAttack` | A real attack. Use `abilityId` for an authored ability's own numbers, or `power`/`formula` for an authored hit. |
| `performRepair` | A real repair through the heal path. |
| `modifyTerrain` | Replaces terrain across a region or tile list. |
| `applyStatus` | Applies a status through the effect pipeline. |
| `setLinkState` | Enables, disables or unlocks a combat relationship. This is how Grayfield restores Section Seven mid-battle; the link's shared reaction pool becomes available in the same instant. See [`REACTIONS.md`](REACTIONS.md). |

### ▷ Presentation — never touches battle state

| Action | Notes |
|---|---|
| `showScene` | **Blocking.** Hard-pauses the battle for portrait dialogue. Choices set mission facts. |
| `focusCamera` | Pans to a unit, region or tile. |
| `requestMusicState` | Asks the audio layer for a track or context. |
| `queueBark` | A non-blocking callout. |

In a headless run (tests, soaks, replay) blocking requests resolve instantly with their authored default, and the authoritative outcome is **identical** — scenes never touch battle state, and a choice resolves to `defaultOptionId` (or the first option) rather than a random pick.

---

## Factions

Different team ids are no longer automatically enemies. Relationships live in battle state and can be rewritten mid-battle.

```jsonc
"factions": {
  "relationships": [
    { "a": "player", "b": "foe",          "relationship": "hostile", "symmetric": true },
    { "a": "player", "b": "sectionSeven", "relationship": "hostile", "symmetric": true },
    { "a": "foe",    "b": "sectionSeven", "relationship": "allied",  "symmetric": true }
  ]
}
```

| | |
|---|---|
| `hostile` | Valid target both ways. |
| `allied` | Will not attack; counts as a friendly target for repairs and buffs. |
| `neutral` | Cannot attack and cannot be attacked, and is **not** a valid ally target either. Civilians and protected assets belong here. |

Anything unstated defaults to the old rule — same team allied, different team hostile — so every pre-existing encounter is unaffected.

Relationships affect legal targeting, AI target selection, threat evaluation, protection logic and the elimination check. Elimination now resolves on *hostility* rather than on team identity: a battle ends when nobody left alive is hostile to anybody else, which is what lets an allied third party survive to the end.

`changeUnitTeam` is the other half: it moves a unit between teams without recreating it. Use `changeFaction` when a whole side changes allegiance, `changeUnitTeam` when individuals defect into a team the player controls.

---

## Groups

```jsonc
"groups": [
  { "id": "escorts",         "name": "Government escorts", "teamId": "foe", "startsActive": true,  "deployment": "field" },
  { "id": "loyalistAce",     "name": "Loyalist ace",       "teamId": "foe", "startsActive": false, "deployment": "field" },
  { "id": "loyalistReserve", "name": "Loyalist reserve",   "teamId": "foe", "startsActive": false, "deployment": "reserve" }
]
```

- `deployment: "field"` — placed at battle start. `startsActive: false` makes them **dormant**: on the map, taking no turns, until `activateGroup`.
- `deployment: "reserve"` — held off the map entirely until `spawnGroup` places them. Reserve units are authored normally (with positions, used as fallback spawn tiles) and simply excluded from the starting encounter.

Assign a unit to a group with its `group` field on the Units tab. A group a unit names but the mission never declares is created implicitly as an ordinary field group.

---

## Objectives

Objectives are declared once in a library and then activated, completed, failed or replaced.

```jsonc
"objectives": [
  { "id": "surviveInterception", "type": "surviveActivations", "text": "Survive the interception",
    "required": true, "activations": 6 },
  { "id": "defeatLoyalists", "type": "defeatAllEnemies", "text": "Break the counterattack",
    "required": true },
  { "id": "protectSectionSeven", "type": "protectUnits", "text": "Keep Kell and Reyes alive",
    "required": false, "unitRefs": ["kell", "reyes"] }
]
```

The mission is won when every **required** active objective is complete, and lost when a required one fails or the player team is wiped out. Optional objectives record outcomes without ending anything.

Objective unit references stay symbolic and resolve against live state, so a unit spawned mid-battle can be an objective target.

**Ordering note that matters:** completing the last required objective only wins the battle once the mission script is idle. Otherwise a phase-one objective like "survive the interception" would end Grayfield at the exact moment it is supposed to hand over to the betrayal phase.

---

## Safety

Actions can produce events that fire more beats, which is intended — a scripted kill should be able to advance a phase — and is also the obvious way to write an infinite loop. Every path is bounded (`LIMITS` in `runtime.js`):

| | |
|---|---|
| `maxBeatsPerDrain` 64 | Beats fired while draining one batch of events. |
| `maxEventsPerDrain` 512 | Events processed before the runtime clears the inbox and reports. |
| `maxActionDepth` 8 | action → event → action recursion. |
| `maxActionsPerBeat` 64 | Actions in one beat. |

Breaking a loop is recorded in `state.mission.errors` and surfaced by the test suite, not swallowed.

Beyond the counters, several actions are **idempotent by construction**: an identical `changeFaction` is a no-op and emits no event, `spawnGroup` never spawns a wave twice, `setCampaignFlag` deduplicates by flag name, and `once: true` beats record themselves as fired *before* their actions run — which is what makes reloading a save safe.

---

## The Grayfield reversal, as an author writes it

This is the whole mid-battle turn from `fixture-grayfield-slice.json`. Nothing else is required to make it work.

```jsonc
{
  "startPhaseId": "interception",

  "phases": [
    {
      "id": "betrayal",
      "name": "The turn",
      "enterWhen": { "trigger": "objectiveCompleted", "objectiveRef": "surviveInterception" },
      "next": "counterattack",
      "onEnter": [
        { "type": "focusCamera", "unitRef": "kell", "hold": 400 },
        { "type": "showScene", "sceneRef": "grayfieldTurn" },

        { "type": "performAttack", "sourceRef": "kell", "targetRefs": ["prototype"],
          "power": 400, "formula": "physical", "lethal": true },

        { "type": "focusCamera", "unitRef": "reyes", "hold": 300 },
        { "type": "moveUnit", "unitRef": "reyes", "regionRef": "valeFallback", "mode": "path" },
        { "type": "performRepair", "sourceRef": "reyes", "targetRefs": ["vale"], "amount": 60 },
        { "type": "showScene", "sceneRef": "grayfieldReunion" },

        { "type": "changeFaction", "teamId": "sectionSeven", "otherTeamId": "player", "relationship": "allied" },
        { "type": "changeFaction", "teamId": "sectionSeven", "otherTeamId": "foe",    "relationship": "hostile" },

        { "type": "replaceObjectives", "objectiveRefs": ["defeatLoyalists", "protectSectionSeven"] },
        { "type": "activateGroup", "groupRef": "loyalistAce" },
        { "type": "spawnGroup", "groupRef": "loyalistReserve", "regionRef": "loyalistStaging" },

        { "type": "setMissionFact", "fact": "sectionSevenTurned", "value": true },
        { "type": "setCampaignFlag", "flag": "sectionSevenRejoined", "value": true },
        { "type": "requestMusicState", "context": "battle", "track": "grayfield-counterattack" },

        { "type": "completePhase" }
      ]
    }
  ]
}
```

What the engine actually does with it, verified by test and in a browser:

1. The phase-one objective completes; the phase machine enters `betrayal`.
2. The camera pans to Kell; the battle pauses on a portrait scene with a choice that sets a mission fact.
3. Kell's shot resolves through the real damage pipeline — the prototype goes from 145 HP to 0 and emits a genuine `unitDefeated`.
4. Reyes walks a real path to the fallback region and repairs Vale through the real heal path.
5. Section Seven's relationship to the player flips to allied and to the loyalists to hostile. **Kell and Reyes keep their runtime ids, their team, their damage and their timeline slots** — nothing is despawned or replaced.
6. The objective stack is replaced; the ace wakes; the reserve wave spawns.
7. Facts and a campaign flag are recorded; music changes.
8. The phase completes and hands off to `counterattack`; the battle resumes deterministically.

---

## Migration

Missions written before this layer keep working unchanged:

- No `phases` and no `beats` → the mission runtime is never created and the encounter behaves exactly as before.
- The single `objective` slot is still honoured when the objective stack is empty.
- Legacy `midBattle` dialogue beats still run through their own path, and can now carry real actions too.
- The old `phases[].actions` field is read as `onEnter`.
- A save from before this change loads: missing `factions`, `entries`, `ref` and `dormant` fields are filled in on load.
