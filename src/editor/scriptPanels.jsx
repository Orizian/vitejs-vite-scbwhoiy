import React from "react";
import { Section, Field, Text, Area, Num, Select, Btn, Check } from "./panels.jsx";
import {
  ACTION_REGISTRY,
  SIMULATION_ACTION_IDS,
  PRESENTATION_ACTION_IDS,
  actionById
} from "../mission/actions.js";
import { MISSION_EVENT_TYPES, missionEventTypeById } from "../mission/events.js";
import { CONDITION_REGISTRY } from "../mission/conditions.js";
import { RELATIONSHIPS, RELATIONSHIP_LABELS } from "../mission/factions.js";
import {
  OBJECTIVE_TYPES,
  objectiveTypeById,
  SPEAKER_CATALOG,
  TERRAIN_CATALOG,
  ABILITY_IDS,
  STATUS_IDS
} from "../content/catalog.js";

/* =========================================================================
 * SCRIPTING PANELS
 *
 * Phases, triggers, actions, factions, groups and the objective library.
 *
 * Every control is generated from the same registry the runtime executes —
 * ACTION_REGISTRY for actions, MISSION_EVENT_TYPES for triggers,
 * CONDITION_REGISTRY for conditions. That is deliberate: it means the editor
 * physically cannot offer an action the engine has no handler for, and a field
 * that appears in a form is a field the trigger actually carries.
 * =======================================================================*/

/* ---------------------------------------------------------------
 * SHARED PICKERS
 * -------------------------------------------------------------*/

function refOptions(list, labelKey) {
  return list.map((entry) => ({
    value: entry.id || entry.ref,
    label: (entry[labelKey] || entry.name || entry.id || entry.ref) + " (" + (entry.id || entry.ref) + ")"
  }));
}

function MultiRefPicker({ mission, kind, value, onChange }) {
  const source =
    kind === "unit"
      ? mission.units.map((unit) => ({ id: unit.ref, name: unit.ref + " · " + unit.definitionId }))
      : kind === "objective"
      ? mission.objectives.map((entry) => ({ id: entry.id, name: entry.text || entry.id }))
      : [];
  const selected = new Set(value || []);
  if (!source.length) {
    return <div className="text-[11px] text-slate-500">Nothing to pick yet.</div>;
  }
  return (
    <div className="max-h-36 space-y-0.5 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-1">
      {source.map((entry) => (
        <label key={entry.id} className="flex cursor-pointer items-center gap-2 px-1 text-[11px] hover:bg-slate-800">
          <input
            type="checkbox"
            className="accent-sky-500"
            checked={selected.has(entry.id)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(entry.id);
              else next.delete(entry.id);
              onChange([...next]);
            }}
          />
          <span className="font-mono text-slate-200">{entry.id}</span>
          <span className="truncate text-slate-500">{entry.name}</span>
        </label>
      ))}
    </div>
  );
}

/** One field of one action, typed from the registry's field name. */
function ActionField({ field, mission, action, onPatch }) {
  const patch = (value) => onPatch({ [field]: value });

  if (field === "unitRefs" || field === "targetRefs") {
    return (
      <Field label={field === "targetRefs" ? "Targets" : "Units"}>
        <MultiRefPicker mission={mission} kind="unit" value={action[field]} onChange={patch} />
      </Field>
    );
  }
  if (field === "objectiveRefs") {
    return (
      <Field label="Objectives">
        <MultiRefPicker mission={mission} kind="objective" value={action[field]} onChange={patch} />
      </Field>
    );
  }
  if (field === "unitRef" || field === "sourceRef") {
    return (
      <Field label={field === "sourceRef" ? "Source unit" : "Unit"}>
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={mission.units.map((unit) => ({ value: unit.ref, label: unit.ref + " · " + unit.definitionId }))}
        />
      </Field>
    );
  }
  if (field === "regionRef") {
    return (
      <Field label="Region">
        <Select allowEmpty value={action[field] || null} onChange={patch} options={refOptions(mission.regions, "name")} />
      </Field>
    );
  }
  if (field === "objectiveRef") {
    return (
      <Field label="Objective">
        <Select allowEmpty value={action[field] || null} onChange={patch} options={refOptions(mission.objectives, "text")} />
      </Field>
    );
  }
  if (field === "phaseRef") {
    return (
      <Field label="Phase">
        <Select allowEmpty value={action[field] || null} onChange={patch} options={refOptions(mission.phases, "name")} />
      </Field>
    );
  }
  if (field === "groupRef") {
    return (
      <Field label="Group">
        <Select allowEmpty value={action[field] || null} onChange={patch} options={refOptions(mission.groups, "name")} />
      </Field>
    );
  }
  if (field === "sceneRef") {
    return (
      <Field label="Scene">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={Object.keys(mission.scenes).map((id) => ({ value: id, label: (mission.scenes[id].title || id) + " (" + id + ")" }))}
        />
      </Field>
    );
  }
  if (field === "teamId" || field === "otherTeamId" || field === "toTeamId") {
    return (
      <Field label={field === "otherTeamId" ? "Other team" : field === "toTeamId" ? "Move to team" : "Team"}>
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={mission.teams.map((team) => ({ value: team.id, label: team.name + " (" + team.id + ")" }))}
        />
      </Field>
    );
  }
  if (field === "relationship") {
    return (
      <Field label="Relationship" hint={RELATIONSHIP_LABELS[action[field]] || ""}>
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={RELATIONSHIPS.map((id) => ({ value: id, label: id }))}
        />
      </Field>
    );
  }
  if (field === "terrainId") {
    return (
      <Field label="Terrain">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={TERRAIN_CATALOG.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      </Field>
    );
  }
  if (field === "speaker") {
    return (
      <Field label="Speaker">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={SPEAKER_CATALOG.map((entry) => ({ value: entry.id, label: entry.glyph + "  " + entry.name }))}
        />
      </Field>
    );
  }
  if (field === "text") {
    return (
      <Field label="Text">
        <Area rows={2} value={action[field]} onChange={patch} />
      </Field>
    );
  }
  if (field === "aiProfile") {
    return (
      <Field label="AI profile">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={patch}
          options={["aggressive", "cautious", "support"].map((id) => ({ value: id, label: id }))}
        />
      </Field>
    );
  }
  if (field === "symmetric" || field === "lethal") {
    return (
      <div className="pt-1">
        <Check
          checked={action[field] !== false}
          onChange={patch}
          label={field === "symmetric" ? "Apply both ways" : "Ignore shields"}
        />
      </div>
    );
  }
  if (["power", "amount", "hold", "value", "factValue"].includes(field)) {
    return (
      <Field label={field}>
        <Num value={action[field]} onChange={patch} />
      </Field>
    );
  }
  if (field === "abilityId") {
    return (
      <Field label="Ability" hint="Leave empty to use the action's own power/amount instead of an authored ability.">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={(v) => patch(v || undefined)}
          options={ABILITY_IDS.map((id) => ({ value: id, label: id }))}
        />
      </Field>
    );
  }
  if (field === "statusId") {
    return (
      <Field label="Status">
        <Select
          allowEmpty
          value={action[field] || null}
          onChange={(v) => patch(v || undefined)}
          options={STATUS_IDS.map((id) => ({ value: id, label: id }))}
        />
      </Field>
    );
  }
  return (
    <Field label={field}>
      <Text mono value={action[field]} onChange={(v) => patch(v === "" ? undefined : v)} />
    </Field>
  );
}

/** The action list editor, reused by phases and by triggers. */
export function ActionListEditor({ mission, actions, onChange, label }) {
  const patchAction = (index, patch) => {
    const next = actions.map((action, i) => (i === index ? { ...action, ...patch } : action));
    onChange(next);
  };
  const move = (from, to) => {
    if (to < 0 || to >= actions.length) return;
    const next = actions.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label || "Actions"}</div>
      <div className="space-y-2">
        {actions.map((action, index) => {
          const definition = actionById(action.type);
          const isSimulation = definition && definition.authority === "simulation";
          return (
            <div
              key={index}
              className={
                "rounded border p-2 " +
                (definition
                  ? isSimulation
                    ? "border-emerald-800/70 bg-emerald-950/20"
                    : "border-sky-800/70 bg-sky-950/20"
                  : "border-rose-700 bg-rose-950/30")
              }
            >
              <div className="mb-1 flex items-center gap-1">
                <span className="font-mono text-[10px] text-slate-500">{index + 1}</span>
                <div className="flex-1">
                  <Select
                    value={action.type}
                    onChange={(value) => onChange(actions.map((a, i) => (i === index ? { type: value } : a)))}
                    options={[
                      ...SIMULATION_ACTION_IDS.map((id) => ({ value: id, label: "◆ " + ACTION_REGISTRY[id].name })),
                      ...PRESENTATION_ACTION_IDS.map((id) => ({ value: id, label: "▷ " + ACTION_REGISTRY[id].name }))
                    ]}
                  />
                </div>
                <Btn disabled={index === 0} onClick={() => move(index, index - 1)}>↑</Btn>
                <Btn disabled={index === actions.length - 1} onClick={() => move(index, index + 1)}>↓</Btn>
                <Btn tone="rose" onClick={() => onChange(actions.filter((_, i) => i !== index))}>×</Btn>
              </div>
              {definition ? (
                <>
                  <div className="mb-2 text-[10px] leading-snug text-slate-500">
                    <span className={isSimulation ? "text-emerald-400" : "text-sky-400"}>
                      {isSimulation ? "changes battle state" : "presentation only"}
                      {definition.blocking ? " · pauses the battle" : ""}
                    </span>
                    {" — "}
                    {definition.summary}
                  </div>
                  <div className="space-y-2">
                    {definition.fields.map((field) => (
                      <ActionField
                        key={field}
                        field={field}
                        mission={mission}
                        action={action}
                        onPatch={(patch) => patchAction(index, patch)}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-[11px] text-rose-300">
                  Unknown action "{String(action.type)}". The engine has no handler for it.
                </div>
              )}
            </div>
          );
        })}
        <Btn
          full
          tone="sky"
          onClick={() => onChange(actions.concat([{ type: "setMissionFact", fact: "" }]))}
        >
          + Action
        </Btn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
 * TRIGGER EDITOR
 * -------------------------------------------------------------*/

function TriggerEditor({ mission, trigger, onChange }) {
  const definition = trigger ? missionEventTypeById(trigger.trigger) : null;

  return (
    <>
      <Field
        label="Trigger event"
        hint={definition ? "Fields below are exactly what this event carries." : "Pick the event that fires this beat."}
      >
        <Select
          allowEmpty
          value={trigger ? trigger.trigger : null}
          onChange={(value) => onChange(value ? { trigger: value } : null)}
          options={MISSION_EVENT_TYPES.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      </Field>
      {definition
        ? definition.fields.map((field) => (
            <ActionField
              key={field}
              field={field}
              mission={mission}
              action={trigger}
              onPatch={(patch) => onChange({ ...trigger, ...patch })}
            />
          ))
        : null}
      {definition && !definition.fields.length ? (
        <div className="text-[10px] text-slate-500">This event carries no fields — it fires on any occurrence.</div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------
 * CONDITION EDITOR
 *
 * Deliberately a small structured editor rather than a free-text expression
 * box: the point is that an author cannot write something unparseable.
 * -------------------------------------------------------------*/

function ConditionEditor({ mission, condition, onChange }) {
  const kind = condition ? Object.keys(condition).find((key) => CONDITION_REGISTRY[key]) : null;
  const definition = kind ? CONDITION_REGISTRY[kind] : null;

  const setKind = (nextKind) => {
    if (!nextKind) return onChange(null);
    if (nextKind === "all" || nextKind === "any") return onChange({ [nextKind]: [] });
    if (nextKind === "not") return onChange({ not: null });
    onChange({ [nextKind]: null });
  };

  return (
    <div className="rounded border border-slate-700 bg-slate-900/50 p-2">
      <Field label="Condition" hint={definition ? definition.summary : "Optional. Checked against current state when the trigger fires."}>
        <Select
          allowEmpty
          value={kind}
          onChange={setKind}
          options={Object.keys(CONDITION_REGISTRY).map((id) => ({ value: id, label: id }))}
        />
      </Field>

      {kind === "all" || kind === "any" ? (
        <div className="mt-2 space-y-2 border-l-2 border-slate-700 pl-2">
          {(condition[kind] || []).map((entry, index) => (
            <div key={index}>
              <ConditionEditor
                mission={mission}
                condition={entry}
                onChange={(next) => {
                  const list = (condition[kind] || []).slice();
                  if (next == null) list.splice(index, 1);
                  else list[index] = next;
                  onChange({ [kind]: list });
                }}
              />
            </div>
          ))}
          <Btn full onClick={() => onChange({ [kind]: (condition[kind] || []).concat([{ phase: null }]) })}>
            + Sub-condition
          </Btn>
        </div>
      ) : null}

      {kind === "not" ? (
        <div className="mt-2 border-l-2 border-slate-700 pl-2">
          <ConditionEditor mission={mission} condition={condition.not} onChange={(next) => onChange({ not: next })} />
        </div>
      ) : null}

      {kind && kind !== "all" && kind !== "any" && kind !== "not" ? (
        <div className="mt-2 space-y-2">
          {definition.fields.map((field) => {
            const asAction = { ...condition };
            const mapped =
              field === kind
                ? kind === "phase"
                  ? "phaseRef"
                  : kind === "unitAlive" || kind === "unitHpBelow" || kind === "unitInRegion"
                  ? "unitRef"
                  : kind === "objectiveStatus"
                  ? "objectiveRef"
                  : kind === "groupActive"
                  ? "groupRef"
                  : kind === "teamUnitsAlive" || kind === "factionRelationship"
                  ? "teamId"
                  : field
                : field;
            asAction[mapped] = condition[field];
            return (
              <ActionField
                key={field}
                field={mapped}
                mission={mission}
                action={asAction}
                onPatch={(patch) => {
                  const value = patch[mapped];
                  onChange({ ...condition, [field]: value });
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------
 * FACTIONS
 * -------------------------------------------------------------*/

export function FactionsPanel({ mission, update }) {
  const teams = mission.teams;
  const relationshipFor = (a, b) => {
    if (a === b) return "allied";
    const entry = mission.factions.relationships.find(
      (rel) => (rel.a === a && rel.b === b) || (rel.symmetric !== false && rel.a === b && rel.b === a)
    );
    return entry ? entry.relationship : "hostile";
  };

  const setRelationship = (a, b, relationship) =>
    update((draft) => {
      const list = draft.factions.relationships.filter(
        (rel) => !((rel.a === a && rel.b === b) || (rel.a === b && rel.b === a))
      );
      list.push({ a, b, relationship, symmetric: true });
      draft.factions.relationships = list;
    });

  return (
    <>
      <Section title="Teams">
        <div className="space-y-1">
          {teams.map((team, index) => (
            <div key={team.id} className="rounded border border-slate-700 bg-slate-900/60 p-2">
              <div className="flex items-center gap-1">
                <Text
                  mono
                  value={team.id}
                  onChange={(value) =>
                    update((draft) => {
                      const from = draft.teams[index].id;
                      const to = value.trim();
                      if (!to || draft.teams.some((t, i) => t.id === to && i !== index)) return;
                      draft.teams[index].id = to;
                      for (const unit of draft.units) if (unit.teamId === from) unit.teamId = to;
                      for (const rel of draft.factions.relationships) {
                        if (rel.a === from) rel.a = to;
                        if (rel.b === from) rel.b = to;
                      }
                      if (draft.objective.teamId === from) draft.objective.teamId = to;
                      if (draft.objective.opposingTeamId === from) draft.objective.opposingTeamId = to;
                    })
                  }
                />
                <Btn
                  tone="rose"
                  disabled={teams.length <= 2}
                  onClick={() =>
                    update((draft) => {
                      const removed = draft.teams[index].id;
                      draft.teams.splice(index, 1);
                      draft.units = draft.units.filter((unit) => unit.teamId !== removed);
                      draft.factions.relationships = draft.factions.relationships.filter(
                        (rel) => rel.a !== removed && rel.b !== removed
                      );
                    })
                  }
                >
                  ×
                </Btn>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <Field label="Name">
                  <Text value={team.name} onChange={(value) => update((draft) => { draft.teams[index].name = value; })} />
                </Field>
                <Field label="Controller" hint={team.controller === "human" ? "The player moves these units." : ""}>
                  <Select
                    value={team.controller}
                    onChange={(value) => update((draft) => { draft.teams[index].controller = value; })}
                    options={[
                      { value: "human", label: "human" },
                      { value: "ai", label: "ai" }
                    ]}
                  />
                </Field>
              </div>
            </div>
          ))}
          <Btn
            full
            tone="sky"
            onClick={() =>
              update((draft) => {
                let n = draft.teams.length + 1;
                let id = "team" + n;
                while (draft.teams.some((team) => team.id === id)) id = "team" + ++n;
                draft.teams.push({ id, name: "Team " + n, controller: "ai", marker: "●", accent: "amber" });
              })
            }
          >
            + Team
          </Btn>
        </div>
      </Section>

      <Section
        title="Relationships"
        right={<span className="text-[10px] text-slate-500">at battle start</span>}
      >
        <div className="space-y-1">
          {teams.map((a, i) =>
            teams.slice(i + 1).map((b) => (
              <div key={a.id + b.id} className="flex items-center gap-2 rounded bg-slate-900/60 px-2 py-1">
                <span className="flex-1 truncate text-[11px] text-slate-300">
                  {a.id} <span className="text-slate-600">↔</span> {b.id}
                </span>
                <div className="w-32">
                  <Select
                    value={relationshipFor(a.id, b.id)}
                    onChange={(value) => setRelationship(a.id, b.id, value)}
                    options={RELATIONSHIPS.map((id) => ({ value: id, label: id }))}
                  />
                </div>
              </div>
            ))
          )}
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-slate-500">
          Relationships can be rewritten mid-battle with the <span className="text-slate-300">changeFaction</span> action;
          units are never recreated. A <span className="text-slate-300">neutral</span> pair cannot attack each other and
          cannot target each other with ally abilities.
        </div>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------
 * GROUPS
 * -------------------------------------------------------------*/

export function GroupsPanel({ mission, update }) {
  const counts = {};
  for (const unit of mission.units) {
    if (unit.group) counts[unit.group] = (counts[unit.group] || 0) + 1;
  }

  return (
    <Section
      title={"Groups (" + mission.groups.length + ")"}
      right={
        <Btn
          tone="sky"
          onClick={() =>
            update((draft) => {
              let n = draft.groups.length + 1;
              let id = "group" + n;
              while (draft.groups.some((group) => group.id === id)) id = "group" + ++n;
              draft.groups.push({ id, name: "Group " + n, teamId: null, startsActive: true, deployment: "field" });
            })
          }
        >
          + New
        </Btn>
      }
    >
      <div className="space-y-2">
        {mission.groups.map((group, index) => (
          <div key={group.id} className="rounded border border-slate-700 bg-slate-900/60 p-2">
            <div className="mb-1 flex items-center gap-1">
              <Text
                mono
                value={group.id}
                onChange={(value) =>
                  update((draft) => {
                    const from = draft.groups[index].id;
                    const to = value.trim();
                    if (!to || draft.groups.some((g, i) => g.id === to && i !== index)) return;
                    draft.groups[index].id = to;
                    for (const unit of draft.units) if (unit.group === from) unit.group = to;
                    for (const phase of draft.phases) {
                      phase.activateGroups = phase.activateGroups.map((ref) => (ref === from ? to : ref));
                      phase.deactivateGroups = phase.deactivateGroups.map((ref) => (ref === from ? to : ref));
                    }
                  })
                }
              />
              <span className="font-mono text-[11px] text-slate-500">{counts[group.id] || 0}u</span>
              <Btn tone="rose" onClick={() => update((draft) => { draft.groups.splice(index, 1); })}>×</Btn>
            </div>
            <Field label="Name">
              <Text value={group.name} onChange={(value) => update((draft) => { draft.groups[index].name = value; })} />
            </Field>
            <Field
              label="Deployment"
              hint={
                group.deployment === "reserve"
                  ? "Held off the map until a spawnGroup action places it."
                  : "Placed on the map at battle start."
              }
            >
              <Select
                value={group.deployment}
                onChange={(value) => update((draft) => { draft.groups[index].deployment = value; })}
                options={[
                  { value: "field", label: "field — starts on the map" },
                  { value: "reserve", label: "reserve — spawned later" }
                ]}
              />
            </Field>
            <div className="pt-1">
              <Check
                checked={group.startsActive}
                onChange={(value) => update((draft) => { draft.groups[index].startsActive = value; })}
                label="Starts awake (dormant groups take no turns)"
              />
            </div>
          </div>
        ))}
        {!mission.groups.length ? (
          <div className="text-[11px] leading-relaxed text-slate-500">
            Groups let a phase wake a sleeping formation or drop in a reinforcement wave. Assign units to a group on the
            Units tab.
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------
 * OBJECTIVE LIBRARY
 * -------------------------------------------------------------*/

export function ObjectiveLibraryPanel({ mission, update }) {
  return (
    <Section
      title={"Objective library (" + mission.objectives.length + ")"}
      right={
        <Btn
          tone="sky"
          onClick={() =>
            update((draft) => {
              let n = draft.objectives.length + 1;
              let id = "objective" + n;
              while (draft.objectives.some((entry) => entry.id === id)) id = "objective" + ++n;
              draft.objectives.push({
                id,
                type: "defeatAllEnemies",
                text: "",
                required: true,
                hidden: false,
                startsActive: false,
                teamId: draft.objective.teamId,
                opposingTeamId: draft.objective.opposingTeamId,
                unitRefs: [],
                regionRef: null,
                activations: null,
                allowElimination: true,
                phases: []
              });
            })
          }
        >
          + New
        </Btn>
      }
    >
      <div className="mb-2 text-[10px] leading-relaxed text-slate-500">
        Objectives are declared here once, then activated, completed, failed or replaced by phases and triggers. A
        mission wins when every <span className="text-slate-300">required</span> active objective is complete.
      </div>
      <div className="space-y-2">
        {mission.objectives.map((objective, index) => {
          const type = objectiveTypeById(objective.type);
          return (
            <div key={objective.id} className="rounded border border-slate-700 bg-slate-900/60 p-2">
              <div className="mb-1 flex items-center gap-1">
                <Text
                  mono
                  value={objective.id}
                  onChange={(value) =>
                    update((draft) => {
                      const from = draft.objectives[index].id;
                      const to = value.trim();
                      if (!to || draft.objectives.some((o, i) => o.id === to && i !== index)) return;
                      draft.objectives[index].id = to;
                      for (const phase of draft.phases) {
                        phase.objectives = phase.objectives.map((ref) => (ref === from ? to : ref));
                      }
                      const swap = (action) => {
                        if (action.objectiveRef === from) action.objectiveRef = to;
                        if (Array.isArray(action.objectiveRefs)) {
                          action.objectiveRefs = action.objectiveRefs.map((ref) => (ref === from ? to : ref));
                        }
                      };
                      for (const phase of draft.phases) {
                        phase.onEnter.forEach(swap);
                        phase.onExit.forEach(swap);
                      }
                      for (const beat of draft.beats) beat.actions.forEach(swap);
                    })
                  }
                />
                <Btn tone="rose" onClick={() => update((draft) => { draft.objectives.splice(index, 1); })}>×</Btn>
              </div>
              <Field label="Display text">
                <Text value={objective.text} onChange={(value) => update((draft) => { draft.objectives[index].text = value; })} />
              </Field>
              <Field label="Type" hint={type ? type.summary : ""}>
                <Select
                  value={objective.type}
                  onChange={(value) => update((draft) => { draft.objectives[index].type = value; })}
                  options={OBJECTIVE_TYPES.filter((entry) => entry.id !== "phasedObjective").map((entry) => ({
                    value: entry.id,
                    label: entry.name
                  }))}
                />
              </Field>
              {type && type.params.includes("unitRefs") ? (
                <Field label="Units">
                  <MultiRefPicker
                    mission={mission}
                    kind="unit"
                    value={objective.unitRefs}
                    onChange={(value) => update((draft) => { draft.objectives[index].unitRefs = value; })}
                  />
                </Field>
              ) : null}
              {type && type.params.includes("regionRef") ? (
                <Field label="Region">
                  <Select
                    allowEmpty
                    value={objective.regionRef}
                    onChange={(value) => update((draft) => { draft.objectives[index].regionRef = value; })}
                    options={refOptions(mission.regions, "name")}
                  />
                </Field>
              ) : null}
              {type && type.params.includes("activations") ? (
                <Field label="Activations">
                  <Num
                    value={objective.activations}
                    min={1}
                    onChange={(value) => update((draft) => { draft.objectives[index].activations = value; })}
                  />
                </Field>
              ) : null}
              <div className="mt-2 space-y-1">
                <Check
                  checked={objective.required}
                  onChange={(value) => update((draft) => { draft.objectives[index].required = value; })}
                  label="Required — failing it loses the mission"
                />
                <Check
                  checked={objective.startsActive}
                  onChange={(value) => update((draft) => { draft.objectives[index].startsActive = value; })}
                  label="Active from battle start"
                />
                <Check
                  checked={objective.hidden}
                  onChange={(value) => update((draft) => { draft.objectives[index].hidden = value; })}
                  label="Hidden from the HUD"
                />
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------
 * PHASES
 * -------------------------------------------------------------*/

export function PhasesPanel({ mission, update, selectedPhaseId, setSelectedPhaseId }) {
  const phase = mission.phases.find((entry) => entry.id === selectedPhaseId) || null;
  const index = mission.phases.findIndex((entry) => entry.id === selectedPhaseId);

  return (
    <>
      <Section
        title={"Phases (" + mission.phases.length + ")"}
        right={
          <Btn
            tone="sky"
            onClick={() =>
              update((draft) => {
                let n = draft.phases.length + 1;
                let id = "phase" + n;
                while (draft.phases.some((entry) => entry.id === id)) id = "phase" + ++n;
                draft.phases.push({
                  id,
                  name: "Phase " + n,
                  enterWhen: null,
                  next: null,
                  objectives: [],
                  activateGroups: [],
                  deactivateGroups: [],
                  onEnter: [],
                  onExit: [],
                  music: null
                });
                if (!draft.startPhaseId) draft.startPhaseId = id;
                setSelectedPhaseId(id);
              })
            }
          >
            + New
          </Btn>
        }
      >
        <div className="space-y-0.5">
          {mission.phases.map((entry, i) => (
            <button
              key={entry.id}
              onClick={() => setSelectedPhaseId(entry.id)}
              className={
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                (selectedPhaseId === entry.id ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
              }
            >
              <span className="font-mono text-slate-500">{i + 1}</span>
              <span className="flex-1 truncate text-slate-200">{entry.name}</span>
              {mission.startPhaseId === entry.id ? (
                <span className="rounded bg-emerald-900/70 px-1 text-[9px] text-emerald-300">START</span>
              ) : null}
              {entry.next ? <span className="text-[9px] text-slate-500">→ {entry.next}</span> : null}
            </button>
          ))}
          {!mission.phases.length ? (
            <div className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              A phase owns a set of objectives, which groups are awake, and a list of actions that run when it begins.
              Phases are how a mission changes shape mid-battle.
            </div>
          ) : null}
        </div>
        {mission.phases.length ? (
          <Field label="Starting phase">
            <Select
              value={mission.startPhaseId || mission.phases[0].id}
              onChange={(value) => update((draft) => { draft.startPhaseId = value; })}
              options={refOptions(mission.phases, "name")}
            />
          </Field>
        ) : null}
      </Section>

      {phase ? (
        <Section
          title={"Editing — " + phase.id}
          right={
            <Btn
              tone="rose"
              onClick={() =>
                update((draft) => {
                  draft.phases.splice(index, 1);
                  if (draft.startPhaseId === phase.id) draft.startPhaseId = draft.phases[0] ? draft.phases[0].id : null;
                  setSelectedPhaseId(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Id">
            <Text
              mono
              value={phase.id}
              onChange={(value) =>
                update((draft) => {
                  const from = draft.phases[index].id;
                  const to = value.trim();
                  if (!to || draft.phases.some((p, i) => p.id === to && i !== index)) return;
                  draft.phases[index].id = to;
                  if (draft.startPhaseId === from) draft.startPhaseId = to;
                  for (const other of draft.phases) if (other.next === from) other.next = to;
                  const swap = (action) => {
                    if (action.phaseRef === from) action.phaseRef = to;
                  };
                  for (const other of draft.phases) {
                    other.onEnter.forEach(swap);
                    other.onExit.forEach(swap);
                  }
                  for (const beat of draft.beats) {
                    beat.actions.forEach(swap);
                    if (beat.phase === from) beat.phase = to;
                  }
                  setSelectedPhaseId(to);
                })
              }
            />
          </Field>
          <Field label="Name">
            <Text value={phase.name} onChange={(value) => update((draft) => { draft.phases[index].name = value; })} />
          </Field>

          <div className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-slate-500">Entered when</div>
          <div className="rounded border border-slate-700 bg-slate-900/50 p-2">
            <TriggerEditor
              mission={mission}
              trigger={phase.enterWhen}
              onChange={(value) =>
                update((draft) => {
                  draft.phases[index].enterWhen = value
                    ? { ...draft.phases[index].enterWhen, ...value }
                    : null;
                })
              }
            />
            <div className="mt-2">
              <ConditionEditor
                mission={mission}
                condition={phase.enterWhen ? phase.enterWhen.when : null}
                onChange={(value) =>
                  update((draft) => {
                    const current = draft.phases[index].enterWhen || {};
                    draft.phases[index].enterWhen = { ...current, when: value };
                  })
                }
              />
            </div>
            <div className="mt-1 text-[10px] text-slate-500">
              Leave both empty for a phase that is only entered by an explicit <span className="text-slate-300">startPhase</span> action.
            </div>
          </div>

          <Field label="Objectives active in this phase" hint="Replaces the active set when the phase begins. Leave empty to keep whatever is active.">
            <MultiRefPicker
              mission={mission}
              kind="objective"
              value={phase.objectives}
              onChange={(value) => update((draft) => { draft.phases[index].objectives = value; })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Wake groups">
              <div className="max-h-28 space-y-0.5 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-1">
                {mission.groups.map((group) => (
                  <label key={group.id} className="flex cursor-pointer items-center gap-1 px-1 text-[11px]">
                    <input
                      type="checkbox"
                      className="accent-sky-500"
                      checked={phase.activateGroups.includes(group.id)}
                      onChange={(event) =>
                        update((draft) => {
                          const list = new Set(draft.phases[index].activateGroups);
                          if (event.target.checked) list.add(group.id);
                          else list.delete(group.id);
                          draft.phases[index].activateGroups = [...list];
                        })
                      }
                    />
                    <span className="truncate text-slate-300">{group.id}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Sleep groups">
              <div className="max-h-28 space-y-0.5 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-1">
                {mission.groups.map((group) => (
                  <label key={group.id} className="flex cursor-pointer items-center gap-1 px-1 text-[11px]">
                    <input
                      type="checkbox"
                      className="accent-sky-500"
                      checked={phase.deactivateGroups.includes(group.id)}
                      onChange={(event) =>
                        update((draft) => {
                          const list = new Set(draft.phases[index].deactivateGroups);
                          if (event.target.checked) list.add(group.id);
                          else list.delete(group.id);
                          draft.phases[index].deactivateGroups = [...list];
                        })
                      }
                    />
                    <span className="truncate text-slate-300">{group.id}</span>
                  </label>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Next phase" hint="Where completePhase hands off to.">
            <Select
              allowEmpty
              value={phase.next}
              onChange={(value) => update((draft) => { draft.phases[index].next = value; })}
              options={refOptions(mission.phases.filter((entry) => entry.id !== phase.id), "name")}
            />
          </Field>

          <div className="mt-3">
            <ActionListEditor
              mission={mission}
              actions={phase.onEnter}
              label="On enter"
              onChange={(value) => update((draft) => { draft.phases[index].onEnter = value; })}
            />
          </div>
          <div className="mt-3">
            <ActionListEditor
              mission={mission}
              actions={phase.onExit}
              label="On exit"
              onChange={(value) => update((draft) => { draft.phases[index].onExit = value; })}
            />
          </div>
        </Section>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------
 * TRIGGERS (beats)
 * -------------------------------------------------------------*/

export function TriggersPanel({ mission, update, selectedBeatId, setSelectedBeatId }) {
  const beat = mission.beats.find((entry) => entry.id === selectedBeatId) || null;
  const index = mission.beats.findIndex((entry) => entry.id === selectedBeatId);

  return (
    <>
      <Section
        title={"Triggers (" + mission.beats.length + ")"}
        right={
          <Btn
            tone="sky"
            onClick={() =>
              update((draft) => {
                let n = draft.beats.length + 1;
                let id = "beat" + n;
                while (draft.beats.some((entry) => entry.id === id)) id = "beat" + ++n;
                draft.beats.push({
                  id,
                  name: "",
                  trigger: { trigger: "battleStarted" },
                  when: null,
                  phase: null,
                  once: true,
                  maxFires: null,
                  priority: 50,
                  actions: []
                });
                setSelectedBeatId(id);
              })
            }
          >
            + New
          </Btn>
        }
      >
        <div className="space-y-0.5">
          {mission.beats.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelectedBeatId(entry.id)}
              className={
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                (selectedBeatId === entry.id ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
              }
            >
              <span className="font-mono text-slate-300">{entry.id}</span>
              <span className="flex-1 truncate text-slate-500">
                {entry.trigger ? entry.trigger.trigger : "condition only"}
              </span>
              <span className="font-mono text-slate-600">{entry.actions.length}a</span>
            </button>
          ))}
          {!mission.beats.length ? (
            <div className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              A trigger watches the battle's event stream and runs a list of actions when its event arrives and its
              conditions hold.
            </div>
          ) : null}
        </div>
      </Section>

      {beat ? (
        <Section
          title={"Editing — " + beat.id}
          right={
            <Btn
              tone="rose"
              onClick={() =>
                update((draft) => {
                  draft.beats.splice(index, 1);
                  setSelectedBeatId(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Id">
            <Text
              mono
              value={beat.id}
              onChange={(value) =>
                update((draft) => {
                  const to = value.trim();
                  if (!to || draft.beats.some((b, i) => b.id === to && i !== index)) return;
                  draft.beats[index].id = to;
                  setSelectedBeatId(to);
                })
              }
            />
          </Field>

          <TriggerEditor
            mission={mission}
            trigger={beat.trigger}
            onChange={(value) => update((draft) => { draft.beats[index].trigger = value; })}
          />

          <div className="mt-2">
            <ConditionEditor
              mission={mission}
              condition={beat.when}
              onChange={(value) => update((draft) => { draft.beats[index].when = value; })}
            />
          </div>

          <Field label="Only during phase" hint="Optional. Leave empty for any phase.">
            <Select
              allowEmpty
              value={Array.isArray(beat.phase) ? beat.phase[0] : beat.phase}
              onChange={(value) => update((draft) => { draft.beats[index].phase = value; })}
              options={refOptions(mission.phases, "name")}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Priority" hint="Higher runs first when several fire together.">
              <Num value={beat.priority} onChange={(value) => update((draft) => { draft.beats[index].priority = value || 0; })} />
            </Field>
            <div className="space-y-2 pt-5">
              <Check
                checked={beat.once}
                onChange={(value) => update((draft) => { draft.beats[index].once = value; })}
                label="Fire once"
              />
            </div>
          </div>

          <div className="mt-3">
            <ActionListEditor
              mission={mission}
              actions={beat.actions}
              onChange={(value) => update((draft) => { draft.beats[index].actions = value; })}
            />
          </div>
        </Section>
      ) : null}
    </>
  );
}
