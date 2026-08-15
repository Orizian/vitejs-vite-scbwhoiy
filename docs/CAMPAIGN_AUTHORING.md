# Campaign authoring

How a campaign is described, and how to add an operation to one without
touching source.

- Authored content: `src/content/campaign/`
- Loader: `src/content/campaign-registry.js`
- Runtime: `src/campaign/progression.js` (pure)
- Editor: `src/editor/CampaignEditor.jsx`
- Regression fixture: `src/content/campaign/legacy-parity.json`

---

## The contract

```
Campaign content is authored data.
Campaign runtime consumes campaign content.
Campaign runtime does not own campaign definitions.
Mission content owns what a mission is and what it pays.
Campaign content owns when it is offered.
```

Every function in `progression.js` takes campaign content as an argument and
imports none. That is the difference between a campaign engine and one campaign
that happens to run — and it is checked: the test suite drives a three-node
synthetic campaign, with no mission, pilot, flag or currency this project ships,
through the same availability, edge-derivation, reachability and validation code
the real campaign uses.

---

## Files

```
src/content/campaign/
  campaign.json          identity, starting state, chapters, base stages
  nodes/<id>.json        one campaign node per file
  facilities.json        what the squad can build
  contacts.json          who they come to know
  speakers.json          everyone a script can give a line to
  dialogue/<id>.json     a node's story script
  legacy-parity.json     regression fixture; goes when the prototype does
```

Files are **discovered, not listed**. Adding a node is dropping a file into
`nodes/`. There is no manifest to update and no registration step.

---

## A node

```json
{
  "format": "statuszero.campaign",
  "formatVersion": 1,
  "kind": "node",
  "id": "act1-02-border-outpost-defense",
  "missionId": "act1-02-border-outpost-defense",
  "order": 2,
  "name": "Border Outpost Defense",
  "requires": ["hollowmereOperationComplete"],
  "grantsFlags": ["outpostDefended"],
  "deployment": { "deploymentSize": 3, "requiredOperatorIds": ["vale", "reyes", "kell"] },
  "rewardTables": { "firstClear": "clear_act1_02_border_outpost_defense" }
}
```

`order` is presentation on the mission board. It is **not** a dependency —
what gates a node is what it requires.

### What a node must not contain

Anything the mission already owns: the map, the enemies, the objectives, the
tactical phases. The node *references* a mission; it does not clone one.

Validation refuses a node that defines `rewards` outright, because mission
content owns what a mission pays.

---

## Requirements

One kind today: a campaign flag that some earlier node granted.

```json
"requires": ["quarryReached"]
"requires": [{ "kind": "flag", "flag": "quarryReached" }]
```

Both forms mean the same thing; the short one is what the prototype uses and
round-trips unchanged. The long form is what a second kind will need.

A second requirement kind — a rank, a facility, an owned operator — is one
entry in `REQUIREMENT_KINDS` plus a clause in authored data. It is not a new
branch at every call site, which is the entire reason the registry shape exists
for a vocabulary that currently has one member.

There is deliberately **no expression language**. A closed, validated vocabulary
is checkable; authored JavaScript is not.

---

## Edges are derived, never authored

A node says what it needs and what it grants. Every arrow in the editor, every
edge in the validator, and the whole reachability analysis comes from those two
lists.

```
alpha  grantsFlags: ["alphaDone"]
beta   requires:    ["alphaDone"]      →  alpha ──alphaDone──▶ beta
```

The prototype also carried an `unlocks` array. It was **empty on all thirteen
missions** and read by two display sites that consumed an always-empty array —
so it was deleted rather than migrated. A second graph authority that nobody
maintains is exactly how a campaign editor starts drawing a campaign that does
not exist.

A requirement no node grants becomes a **dangling edge**: an arrow with no
source, reported by validation and drawn in red. That is one representation of
one problem, not two.

---

## Progression effects

Small and declarative, because that is what the prototype proved it needs:

| | |
|---|---|
| `grantsFlags` | flags set on completion — this is what drives the graph |
| `recruits` | operators who join |
| `contacts` | people introduced |
| `deployment` | who may be fielded, and how many |

Campaign effects are not tactical effects. The two vocabularies stay separate.

### Roster selectors

`"optionalOperatorIds": "owned"` means *whoever is on the roster when this
runs*. Late operations cannot list their optional pilots, because who survived
and who was recruited is a property of the playthrough. It is named vocabulary
(`ROSTER_SELECTORS`) rather than a magic string, so validation can tell a
selector from a mistyped operator id.

---

## Rewards

One authority per mission:

- the **mission file's** `rewards` block, if the mission has a file
- the **node's** `rewardTables`, if it does not

Validation refuses both at once. This is a single authority, not a fallback:
several prototype operations exist only as a campaign node and an engine
encounter, so there is no mission file for them to own anything. When one gains
a real mission file, its reward reference moves into it and comes out of the
node.

The legacy `CAMPAIGN`-literal reward adapter is **deleted**. `legacy-parity.json`
records what it used to pay, read out of the running build before the literal
was removed, and a test asserts the authored campaign reproduces every value.

---

## Adding an operation

No source file is edited at any point.

1. **Mission Editor** — build the map, place enemies, author objectives and
   triggers, and set the mission's `rewards` tables.
2. **Gameplay Data Studio** — if it needs new equipment, a loot table or a
   material, author them there.
3. **Scene Editor** — author any scenes it plays.
4. **Campaign Editor** — *New node*, give it a stable id, pick the mission,
   tick the flags it requires and type the flags it grants.
5. Watch the graph: the new arrows appear as soon as the flags match.
6. Use the availability preview to confirm it opens when you expect.
7. *Play from here* to run the mission.
8. Export from each editor and commit the files.

---

## Play from here

Launches the **mission**, into the playtest slot the Mission Editor already
uses. It does not touch the real save.

It deliberately does not fabricate a campaign state. Inventing which flags are
set, who survived and what was recruited would test a state no playthrough can
reach, and a green result would mean nothing. The question "would this be
offered, and when" is answered by the availability preview instead, which calls
the runtime's own evaluator rather than an editor's opinion.

A node whose mission has no file cannot be played from here, and says so.

---

## Validation

| | |
|---|---|
| ids | non-slug node id, two files claiming one id, a filename that disagrees with the id inside |
| refs | unknown mission, operator, contact, facility, currency; unknown roster selector |
| graph | dangling requirement, self-dependency, cycles, no root, unreachable node |
| deployment | non-positive size, more required operators than seats |
| ownership | a node defining rewards |

Errors name the node. Unreachable nodes are warnings — a work-in-progress
campaign legitimately has them.

---

## Runtime state is not content

`CAMPAIGN_CONTENT` is loaded once, normalized once and frozen. The save holds
flags, completion, attempts, roster, inventory, materials, claims and applied
receipts — and none of that lives in a content file.

---

## Known debt

- **Currencies are still campaign fields**, not a registry. `supplies`, `funds`
  and `intel` are top-level numbers on campaign state, and authored grants
  already say `{ kind: "currency", itemId: "funds" }`. Generalizing to a
  `currencies` map is a save migration this phase did not need and therefore
  did not force; the authored shape will not change when it happens.
- **Twelve operations have no mission file.** Their maps and encounters are
  still App.jsx literals (`MAPS`, `ENCOUNTERS`). Their campaign nodes are fully
  authored; the tactical content is the next extraction, and it is mission
  work, not campaign work.
- **No replay UI on the mission board.** The reward layer supports repeat
  clears; the board still filters completed operations out.
- **Node deletion refuses rather than refactors.** There is no rename-with-
  references tool; the editor blocks the destructive case instead of silently
  orphaning anything.
- **Campaign export writes node files only.** Facilities, contacts and the
  manifest are hand-edited, as they were before.
