import React from "react";
import {
  TERRAIN_CATALOG,
  UNIT_CATALOG,
  AI_PROFILE_IDS,
  LOOT_TABLE_IDS,
  FACINGS,
  SPEAKER_CATALOG,
  SCENE_KINDS,
  OBJECTIVE_TYPES,
  PHASE_OBJECTIVE_TYPE_IDS,
  TRIGGER_TYPES,
  objectiveTypeById,
  triggerTypeById,
  unitById
} from "../content/catalog.js";

/* =========================================================================
 * INSPECTOR PANELS
 * Every panel is a pure function of the mission plus an `update` callback
 * that receives a mutated draft. The editor shell owns undo.
 * =======================================================================*/

/* ---------------------------------------------------------------
 * PRIMITIVES
 * -------------------------------------------------------------*/

export function Section({ title, right, children, dense }) {
  return (
    <div className="border-b border-slate-800">
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{title}</h3>
        {right}
      </div>
      <div className={dense ? "px-3 pb-3" : "space-y-2 px-3 pb-3"}>{children}</div>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[10px] leading-snug text-slate-500">{hint}</div> : null}
    </label>
  );
}

const inputClass =
  "w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500";

export function Text({ value, onChange, placeholder, mono }) {
  return (
    <input
      className={inputClass + (mono ? " font-mono" : "")}
      value={value == null ? "" : value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Area({ value, onChange, rows = 3, placeholder }) {
  return (
    <textarea
      className={inputClass + " resize-y leading-relaxed"}
      rows={rows}
      value={value == null ? "" : value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function Num({ value, onChange, min, max, placeholder }) {
  return (
    <input
      type="number"
      className={inputClass + " font-mono"}
      value={value == null ? "" : value}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    />
  );
}

export function Select({ value, onChange, options, allowEmpty }) {
  return (
    <select
      className={inputClass}
      value={value == null ? "" : value}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      {allowEmpty ? <option value="">— none —</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Btn({ children, onClick, tone = "slate", disabled, title, full }) {
  const tones = {
    slate: "border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200",
    sky: "border-sky-600 bg-sky-900/70 hover:bg-sky-800 text-sky-100",
    rose: "border-rose-700 bg-rose-950/70 hover:bg-rose-900 text-rose-200",
    emerald: "border-emerald-600 bg-emerald-900/70 hover:bg-emerald-800 text-emerald-100"
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={
        "rounded border px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-40 " +
        tones[tone] +
        (full ? " w-full" : "")
      }
    >
      {children}
    </button>
  );
}

export function Check({ checked, onChange, label }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
      <input type="checkbox" className="accent-sky-500" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Multi-select over authored unit refs, used everywhere an objective or a
 *  trigger points at units. Shows the chassis so you can tell two grunts apart. */
function UnitRefPicker({ mission, value, onChange }) {
  const selected = new Set(value || []);
  if (!mission.units.length) {
    return <div className="text-[11px] text-slate-500">No units placed yet.</div>;
  }
  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-1">
      {mission.units.map((unit) => {
        const definition = unitById(unit.definitionId);
        return (
          <label
            key={unit.ref}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-slate-800"
          >
            <input
              type="checkbox"
              className="accent-sky-500"
              checked={selected.has(unit.ref)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(unit.ref);
                else next.delete(unit.ref);
                onChange([...next]);
              }}
            />
            <span className="font-mono text-slate-200">{unit.ref}</span>
            <span className="text-slate-500">
              {definition ? definition.name : unit.definitionId} · {unit.teamId} · {unit.x},{unit.y}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function regionOptions(mission) {
  return mission.regions.map((region) => ({ value: region.id, label: region.name + " (" + region.id + ")" }));
}

/* ---------------------------------------------------------------
 * MAP / TERRAIN
 * -------------------------------------------------------------*/

export function MapPanel({ mission, update, tool, setTool, activeTerrainId, setActiveTerrainId, brush, setBrush, elevationDelta, setElevationDelta }) {
  const [resize, setResize] = React.useState({ width: mission.map.width, height: mission.map.height });
  React.useEffect(() => {
    setResize({ width: mission.map.width, height: mission.map.height });
  }, [mission.map.width, mission.map.height]);

  return (
    <>
      <Section title="Tool">
        <div className="grid grid-cols-2 gap-1">
          {[
            ["paint", "Paint terrain"],
            ["elevation", "Raise / lower"],
            ["unit", "Place unit"],
            ["region", "Paint region"],
            ["erase", "Erase"],
            ["select", "Select"]
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTool(id)}
              className={
                "rounded border px-2 py-1.5 text-[11px] transition " +
                (tool === id
                  ? "border-sky-500 bg-sky-900/70 text-sky-100"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <Field label={"Brush size — " + (brush * 2 - 1) + "×" + (brush * 2 - 1)}>
          <input
            type="range"
            min={1}
            max={8}
            value={brush}
            className="w-full accent-sky-500"
            onChange={(event) => setBrush(Number(event.target.value))}
          />
        </Field>
        {tool === "elevation" ? (
          <Field label="Elevation step" hint="Steps bigger than one level between neighbouring walkable tiles become invisible walls; the canvas marks them in red.">
            <div className="flex gap-1">
              <Btn tone={elevationDelta === 1 ? "sky" : "slate"} onClick={() => setElevationDelta(1)}>
                Raise +1
              </Btn>
              <Btn tone={elevationDelta === -1 ? "sky" : "slate"} onClick={() => setElevationDelta(-1)}>
                Lower −1
              </Btn>
              <Btn tone={elevationDelta === 0 ? "sky" : "slate"} onClick={() => setElevationDelta(0)}>
                Flatten to 0
              </Btn>
            </div>
          </Field>
        ) : null}
      </Section>

      <Section title="Terrain">
        <div className="space-y-1">
          {TERRAIN_CATALOG.map((terrain) => (
            <button
              key={terrain.id}
              onClick={() => {
                setActiveTerrainId(terrain.id);
                setTool("paint");
              }}
              className={
                "flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-[11px] transition " +
                (activeTerrainId === terrain.id
                  ? "border-sky-500 bg-sky-900/40"
                  : "border-slate-700 bg-slate-900 hover:bg-slate-800")
              }
            >
              <span className="h-4 w-4 rounded-sm ring-1 ring-slate-600" style={{ background: terrain.paint }} />
              <span className="flex-1 text-slate-200">{terrain.name}</span>
              <span className="font-mono text-slate-500">
                {terrain.walkable ? "cost " + terrain.movementCost : "solid"}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Dimensions">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <Num value={resize.width} min={4} max={128} onChange={(v) => setResize((r) => ({ ...r, width: v }))} />
          </Field>
          <Field label="Height">
            <Num value={resize.height} min={4} max={128} onChange={(v) => setResize((r) => ({ ...r, height: v }))} />
          </Field>
        </div>
        <Btn
          full
          tone="sky"
          disabled={resize.width === mission.map.width && resize.height === mission.map.height}
          onClick={() =>
            update((draft) => {
              const w = Math.max(4, Math.min(128, resize.width || 4));
              const h = Math.max(4, Math.min(128, resize.height || 4));
              draft.map.terrain = conform(draft.map.terrain, w, h, "plain");
              draft.map.elevation = conform(draft.map.elevation, w, h, 0);
              draft.map.width = w;
              draft.map.height = h;
              draft.units = draft.units.filter((unit) => unit.x < w && unit.y < h);
              for (const region of draft.regions) {
                region.tiles = region.tiles.filter((tile) => tile.x < w && tile.y < h);
              }
            })
          }
        >
          Resize (crops units and regions outside the new bounds)
        </Btn>
        <div className="flex gap-1">
          <Btn
            full
            onClick={() =>
              update((draft) => {
                draft.map.terrain = draft.map.terrain.map((row) => row.map(() => "plain"));
              })
            }
          >
            Fill terrain
          </Btn>
          <Btn
            full
            onClick={() =>
              update((draft) => {
                draft.map.elevation = draft.map.elevation.map((row) => row.map(() => 0));
              })
            }
          >
            Flatten all
          </Btn>
        </div>
      </Section>
    </>
  );
}

function conform(grid, width, height, fill) {
  const out = [];
  for (let y = 0; y < height; y += 1) {
    const row = grid[y] || [];
    const next = [];
    for (let x = 0; x < width; x += 1) next.push(row[x] === undefined ? fill : row[x]);
    out.push(next);
  }
  return out;
}

/* ---------------------------------------------------------------
 * UNITS
 * -------------------------------------------------------------*/

export function UnitsPanel({
  mission,
  update,
  selectedUnitRef,
  setSelectedUnitRef,
  activeUnitDefinitionId,
  setActiveUnitDefinitionId,
  activeTeamId,
  setActiveTeamId,
  setTool
}) {
  const selected = mission.units.find((unit) => unit.ref === selectedUnitRef) || null;

  return (
    <>
      <Section title="Place" >
        <Field label="Team">
          <Select
            value={activeTeamId}
            onChange={setActiveTeamId}
            options={mission.teams.map((team) => ({ value: team.id, label: team.name + " (" + team.id + ")" }))}
          />
        </Field>
        <Field
          label="Chassis"
          hint="Player-team placements are start positions — the campaign roster overwrites the chassis at deploy time."
        >
          <Select
            value={activeUnitDefinitionId}
            onChange={setActiveUnitDefinitionId}
            options={UNIT_CATALOG.map((unit) => ({ value: unit.id, label: unit.glyph + "  " + unit.name }))}
          />
        </Field>
        <Btn full tone="sky" onClick={() => setTool("unit")}>
          Click the map to place
        </Btn>
      </Section>

      <Section title={"Units (" + mission.units.length + ")"}>
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {mission.units.map((unit) => {
            const definition = unitById(unit.definitionId);
            return (
              <button
                key={unit.ref}
                onClick={() => {
                  setSelectedUnitRef(unit.ref);
                  setTool("select");
                }}
                className={
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                  (selectedUnitRef === unit.ref ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
                }
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: unit.teamId === "player" ? "#34d399" : unit.teamId === "foe" ? "#fb7185" : "#fbbf24" }}
                />
                <span className="font-mono text-slate-200">{unit.ref}</span>
                <span className="flex-1 truncate text-slate-500">{definition ? definition.name : unit.definitionId}</span>
                <span className="font-mono text-slate-600">
                  {unit.x},{unit.y}
                </span>
              </button>
            );
          })}
          {!mission.units.length ? <div className="px-2 py-3 text-[11px] text-slate-500">No units placed.</div> : null}
        </div>
      </Section>

      {selected ? (
        <Section
          title={"Selected — " + selected.ref}
          right={
            <Btn
              tone="rose"
              onClick={() =>
                update((draft) => {
                  draft.units = draft.units.filter((unit) => unit.ref !== selected.ref);
                  setSelectedUnitRef(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Reference id" hint="Objectives and triggers point at this name. Renaming updates every reference.">
            <Text
              mono
              value={selected.ref}
              onChange={(value) =>
                update((draft) => {
                  const next = value.trim() || selected.ref;
                  if (draft.units.some((unit) => unit.ref === next && unit.ref !== selected.ref)) return;
                  renameUnitRef(draft, selected.ref, next);
                  setSelectedUnitRef(next);
                })
              }
            />
          </Field>
          <Field label="Chassis">
            <Select
              value={selected.definitionId}
              onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { definitionId: value }))}
              options={UNIT_CATALOG.map((unit) => ({ value: unit.id, label: unit.name }))}
            />
          </Field>
          <Field label="Team">
            <Select
              value={selected.teamId}
              onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { teamId: value }))}
              options={mission.teams.map((team) => ({ value: team.id, label: team.name }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="X">
              <Num value={selected.x} onChange={(v) => update((draft) => patchUnit(draft, selected.ref, { x: v || 0 }))} />
            </Field>
            <Field label="Y">
              <Num value={selected.y} onChange={(v) => update((draft) => patchUnit(draft, selected.ref, { y: v || 0 }))} />
            </Field>
          </div>
          <Field label="Facing" hint="Leave empty and the engine orients the unit at its nearest hostile on battle start.">
            <Select
              allowEmpty
              value={selected.facing}
              onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { facing: value }))}
              options={FACINGS.map((facing) => ({ value: facing, label: facing }))}
            />
          </Field>
          <Field label="AI profile" hint="Empty uses the chassis default.">
            <Select
              allowEmpty
              value={selected.aiProfile}
              onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { aiProfile: value }))}
              options={AI_PROFILE_IDS.map((id) => ({ value: id, label: id }))}
            />
          </Field>
          <Field
            label="Group"
            hint="Authoring metadata for reinforcement waves. The engine has no spawn-group system yet (SPN-01), so this is currently a label only."
          >
            <Text value={selected.group} onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { group: value || null }))} />
          </Field>
          <Field
            label="Drops"
            hint="What this particular placement is worth when defeated. Empty uses whatever its chassis drops — set it to make one named enemy worth hunting without duplicating a unit definition."
          >
            <Select
              allowEmpty
              value={selected.dropTableId}
              onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { dropTableId: value || null }))}
              options={LOOT_TABLE_IDS.map((id) => ({ value: id, label: id }))}
            />
          </Field>
          <Field label="Note">
            <Text value={selected.note} onChange={(value) => update((draft) => patchUnit(draft, selected.ref, { note: value }))} />
          </Field>
        </Section>
      ) : null}
    </>
  );
}

function patchUnit(draft, ref, patch) {
  const unit = draft.units.find((entry) => entry.ref === ref);
  if (unit) Object.assign(unit, patch);
}

function renameUnitRef(draft, from, to) {
  const unit = draft.units.find((entry) => entry.ref === from);
  if (unit) unit.ref = to;
  const swap = (list) => (list || []).map((value) => (value === from ? to : value));
  draft.objective.unitRefs = swap(draft.objective.unitRefs);
  for (const phase of draft.objective.phases) phase.unitRefs = swap(phase.unitRefs);
  for (const beat of draft.midBattle) {
    if (beat.trigger.unitRefs) beat.trigger.unitRefs = swap(beat.trigger.unitRefs);
  }
}

/* ---------------------------------------------------------------
 * REGIONS
 * -------------------------------------------------------------*/

export function RegionsPanel({ mission, update, selectedRegionId, setSelectedRegionId, setTool }) {
  const selected = mission.regions.find((region) => region.id === selectedRegionId) || null;

  return (
    <>
      <Section
        title={"Regions (" + mission.regions.length + ")"}
        right={
          <Btn
            tone="sky"
            onClick={() =>
              update((draft) => {
                const id = uniqueId(draft.regions.map((r) => r.id), "region");
                draft.regions.push({
                  id,
                  name: "Region " + (draft.regions.length + 1),
                  color: REGION_COLORS[draft.regions.length % REGION_COLORS.length],
                  kind: "trigger",
                  tiles: []
                });
                setSelectedRegionId(id);
                setTool("region");
              })
            }
          >
            + New
          </Btn>
        }
      >
        <div className="space-y-0.5">
          {mission.regions.map((region) => (
            <button
              key={region.id}
              onClick={() => {
                setSelectedRegionId(region.id);
                setTool("region");
              }}
              className={
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                (selectedRegionId === region.id ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
              }
            >
              <span className="h-3 w-3 rounded-sm" style={{ background: region.color }} />
              <span className="flex-1 truncate text-slate-200">{region.name}</span>
              <span className="font-mono text-slate-500">{region.tiles.length}</span>
            </button>
          ))}
          {!mission.regions.length ? (
            <div className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              Regions are named areas. Objectives use them as extraction or hold zones, and triggers fire when a unit
              walks into one.
            </div>
          ) : null}
        </div>
      </Section>

      {selected ? (
        <Section
          title="Selected region"
          right={
            <Btn
              tone="rose"
              onClick={() =>
                update((draft) => {
                  draft.regions = draft.regions.filter((region) => region.id !== selected.id);
                  if (draft.objective.regionRef === selected.id) draft.objective.regionRef = null;
                  for (const phase of draft.objective.phases) {
                    if (phase.regionRef === selected.id) phase.regionRef = null;
                  }
                  for (const beat of draft.midBattle) {
                    if (beat.trigger.regionRef === selected.id) delete beat.trigger.regionRef;
                  }
                  setSelectedRegionId(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Id" hint="Referenced by objectives and triggers.">
            <Text
              mono
              value={selected.id}
              onChange={(value) =>
                update((draft) => {
                  const next = value.trim();
                  if (!next || draft.regions.some((r) => r.id === next && r.id !== selected.id)) return;
                  renameRegion(draft, selected.id, next);
                  setSelectedRegionId(next);
                })
              }
            />
          </Field>
          <Field label="Name">
            <Text value={selected.name} onChange={(value) => update((draft) => patchRegion(draft, selected.id, { name: value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind">
              <Select
                value={selected.kind}
                onChange={(value) => update((draft) => patchRegion(draft, selected.id, { kind: value }))}
                options={["trigger", "deployment", "extraction", "hold", "hazard"].map((k) => ({ value: k, label: k }))}
              />
            </Field>
            <Field label="Colour">
              <input
                type="color"
                className="h-7 w-full cursor-pointer rounded border border-slate-700 bg-slate-900"
                value={selected.color}
                onChange={(event) => update((draft) => patchRegion(draft, selected.id, { color: event.target.value }))}
              />
            </Field>
          </div>
          <div className="flex gap-1">
            <Btn full tone="sky" onClick={() => setTool("region")}>
              Paint tiles
            </Btn>
            <Btn full onClick={() => update((draft) => patchRegion(draft, selected.id, { tiles: [] }))}>
              Clear
            </Btn>
          </div>
          <div className="text-[10px] leading-relaxed text-slate-500">
            {selected.tiles.length} tile(s). Hold the paint tool and drag to add; use Erase to remove.
          </div>
        </Section>
      ) : null}
    </>
  );
}

const REGION_COLORS = ["#38bdf8", "#f59e0b", "#f43f5e", "#a78bfa", "#34d399", "#fb923c"];

function patchRegion(draft, id, patch) {
  const region = draft.regions.find((entry) => entry.id === id);
  if (region) Object.assign(region, patch);
}

function renameRegion(draft, from, to) {
  const region = draft.regions.find((entry) => entry.id === from);
  if (region) region.id = to;
  if (draft.objective.regionRef === from) draft.objective.regionRef = to;
  for (const phase of draft.objective.phases) if (phase.regionRef === from) phase.regionRef = to;
  for (const beat of draft.midBattle) if (beat.trigger.regionRef === from) beat.trigger.regionRef = to;
}

function uniqueId(existing, prefix) {
  let index = existing.length + 1;
  let id = prefix + index;
  while (existing.includes(id)) {
    index += 1;
    id = prefix + index;
  }
  return id;
}

/* ---------------------------------------------------------------
 * OBJECTIVE
 * -------------------------------------------------------------*/

export function ObjectivePanel({ mission, update }) {
  const objective = mission.objective;
  const type = objectiveTypeById(objective.type);
  const isPhased = objective.type === "phasedObjective";

  return (
    <>
      <Section title="Objective">
        <Field label="Type" hint={type ? type.summary : ""}>
          <Select
            value={objective.type}
            onChange={(value) => update((draft) => { draft.objective.type = value; })}
            options={OBJECTIVE_TYPES.map((entry) => ({ value: entry.id, label: entry.name }))}
          />
        </Field>
        <Field label="Objective text" hint="Shown in the battle HUD.">
          <Text value={objective.text} onChange={(value) => update((draft) => { draft.objective.text = value; })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Player team">
            <Select
              value={objective.teamId}
              onChange={(value) => update((draft) => { draft.objective.teamId = value; })}
              options={mission.teams.map((team) => ({ value: team.id, label: team.id }))}
            />
          </Field>
          <Field label="Opposing team">
            <Select
              value={objective.opposingTeamId}
              onChange={(value) => update((draft) => { draft.objective.opposingTeamId = value; })}
              options={mission.teams.map((team) => ({ value: team.id, label: team.id }))}
            />
          </Field>
        </div>
        {!isPhased ? (
          <ObjectiveParams
            mission={mission}
            objective={objective}
            type={type}
            onPatch={(patch) => update((draft) => Object.assign(draft.objective, patch))}
          />
        ) : null}
      </Section>

      {isPhased ? (
        <Section
          title={"Phases (" + objective.phases.length + ")"}
          right={
            <Btn
              tone="sky"
              onClick={() =>
                update((draft) => {
                  draft.objective.phases.push({
                    id: uniqueId(draft.objective.phases.map((p) => p.id), "phase"),
                    type: "defeatAllEnemies",
                    label: "",
                    unitRefs: [],
                    regionRef: null,
                    activations: null,
                    allowElimination: false
                  });
                })
              }
            >
              + Phase
            </Btn>
          }
        >
          <div className="space-y-3">
            {objective.phases.map((phase, index) => {
              const phaseType = objectiveTypeById(phase.type);
              return (
                <div key={phase.id} className="rounded border border-slate-700 bg-slate-900/60 p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-sky-300">
                      {index + 1}. {phase.id}
                    </span>
                    <div className="flex gap-1">
                      <Btn
                        disabled={index === 0}
                        onClick={() => update((draft) => move(draft.objective.phases, index, index - 1))}
                      >
                        ↑
                      </Btn>
                      <Btn
                        disabled={index === objective.phases.length - 1}
                        onClick={() => update((draft) => move(draft.objective.phases, index, index + 1))}
                      >
                        ↓
                      </Btn>
                      <Btn
                        tone="rose"
                        onClick={() => update((draft) => { draft.objective.phases.splice(index, 1); })}
                      >
                        ×
                      </Btn>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Field label="Type" hint={phaseType ? phaseType.summary : ""}>
                      <Select
                        value={phase.type}
                        onChange={(value) => update((draft) => { draft.objective.phases[index].type = value; })}
                        options={PHASE_OBJECTIVE_TYPE_IDS.map((id) => ({
                          value: id,
                          label: objectiveTypeById(id).name
                        }))}
                      />
                    </Field>
                    <ObjectiveParams
                      mission={mission}
                      objective={phase}
                      type={phaseType}
                      onPatch={(patch) => update((draft) => Object.assign(draft.objective.phases[index], patch))}
                    />
                  </div>
                </div>
              );
            })}
            {!objective.phases.length ? (
              <div className="text-[11px] text-slate-500">Add at least one phase.</div>
            ) : null}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function ObjectiveParams({ mission, objective, type, onPatch }) {
  if (!type) return null;
  return (
    <>
      {type.params.includes("unitRefs") ? (
        <Field label="Target units">
          <UnitRefPicker mission={mission} value={objective.unitRefs} onChange={(value) => onPatch({ unitRefs: value })} />
        </Field>
      ) : null}
      {type.params.includes("regionRef") ? (
        <Field label="Region">
          <Select
            allowEmpty
            value={objective.regionRef}
            onChange={(value) => onPatch({ regionRef: value })}
            options={regionOptions(mission)}
          />
        </Field>
      ) : null}
      {type.params.includes("activations") ? (
        <Field label="Activations" hint="One activation is one unit taking its turn — not a full round.">
          <Num value={objective.activations} min={1} onChange={(value) => onPatch({ activations: value })} />
        </Field>
      ) : null}
      {objective.type === "reachExtraction" ? (
        <Check
          checked={objective.allowElimination}
          onChange={(value) => onPatch({ allowElimination: value })}
          label="Wiping out the enemy also wins"
        />
      ) : null}
    </>
  );
}

function move(list, from, to) {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

/* ---------------------------------------------------------------
 * SCENES (the cutscene editor)
 * -------------------------------------------------------------*/

export function ScenesPanel({ mission, update, selectedSceneId, setSelectedSceneId }) {
  const sceneIds = Object.keys(mission.scenes);
  const scene = selectedSceneId ? mission.scenes[selectedSceneId] : null;

  return (
    <>
      <Section
        title={"Scenes (" + sceneIds.length + ")"}
        right={
          <Btn
            tone="sky"
            onClick={() =>
              update((draft) => {
                const id = uniqueId(Object.keys(draft.scenes), "scene");
                draft.scenes[id] = {
                  title: "New Scene",
                  location: "",
                  kind: "dialogue",
                  lines: [{ speaker: "", text: "" }],
                  choices: []
                };
                setSelectedSceneId(id);
              })
            }
          >
            + New
          </Btn>
        }
      >
        <div className="space-y-0.5">
          {sceneIds.map((id) => (
            <button
              key={id}
              onClick={() => setSelectedSceneId(id)}
              className={
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                (selectedSceneId === id ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
              }
            >
              <span className="flex-1 truncate text-slate-200">{mission.scenes[id].title}</span>
              <span className="font-mono text-slate-600">{mission.scenes[id].lines.length}L</span>
            </button>
          ))}
          {!sceneIds.length ? <div className="px-2 py-3 text-[11px] text-slate-500">No scenes yet.</div> : null}
        </div>
      </Section>

      <Section title="Sequences">
        {["briefing", "victory", "defeat"].map((key) => (
          <Field
            key={key}
            label={key}
            hint={key === "briefing" ? "Plays before deployment. Victory and defeat play after the battle resolves." : undefined}
          >
            <div className="space-y-1">
              {mission.sequences[key].map((sceneId, index) => (
                <div key={index} className="flex items-center gap-1">
                  <Select
                    value={sceneId}
                    onChange={(value) =>
                      update((draft) => {
                        draft.sequences[key][index] = value;
                      })
                    }
                    options={sceneIds.map((id) => ({ value: id, label: mission.scenes[id].title + " (" + id + ")" }))}
                  />
                  <Btn tone="rose" onClick={() => update((draft) => { draft.sequences[key].splice(index, 1); })}>
                    ×
                  </Btn>
                </div>
              ))}
              <Btn
                full
                disabled={!sceneIds.length}
                onClick={() => update((draft) => { draft.sequences[key].push(sceneIds[0]); })}
              >
                + Add scene
              </Btn>
            </div>
          </Field>
        ))}
      </Section>

      {scene ? (
        <Section
          title={"Editing — " + selectedSceneId}
          right={
            <Btn
              tone="rose"
              onClick={() =>
                update((draft) => {
                  delete draft.scenes[selectedSceneId];
                  for (const key of ["briefing", "victory", "defeat"]) {
                    draft.sequences[key] = draft.sequences[key].filter((id) => id !== selectedSceneId);
                  }
                  setSelectedSceneId(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Title">
            <Text value={scene.title} onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].title = value; })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Location">
              <Text
                value={scene.location}
                onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].location = value; })}
              />
            </Field>
            <Field label="Kind">
              <Select
                value={scene.kind}
                onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].kind = value; })}
                options={SCENE_KINDS.map((kind) => ({ value: kind, label: kind }))}
              />
            </Field>
          </div>

          <div className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-slate-500">Lines</div>
          <div className="space-y-2">
            {scene.lines.map((line, index) => (
              <div key={index} className="rounded border border-slate-700 bg-slate-900/60 p-2">
                <div className="mb-1 flex items-center gap-1">
                  <div className="flex-1">
                    <Select
                      value={line.speaker}
                      onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].lines[index].speaker = value; })}
                      options={SPEAKER_CATALOG.map((s) => ({ value: s.id, label: s.glyph + "  " + s.name }))}
                    />
                  </div>
                  <Btn disabled={index === 0} onClick={() => update((draft) => move(draft.scenes[selectedSceneId].lines, index, index - 1))}>
                    ↑
                  </Btn>
                  <Btn
                    disabled={index === scene.lines.length - 1}
                    onClick={() => update((draft) => move(draft.scenes[selectedSceneId].lines, index, index + 1))}
                  >
                    ↓
                  </Btn>
                  <Btn tone="rose" onClick={() => update((draft) => { draft.scenes[selectedSceneId].lines.splice(index, 1); })}>
                    ×
                  </Btn>
                </div>
                <Area
                  rows={2}
                  value={line.text}
                  placeholder="Line of dialogue…"
                  onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].lines[index].text = value; })}
                />
              </div>
            ))}
            <Btn
              full
              tone="sky"
              onClick={() =>
                update((draft) => {
                  const lines = draft.scenes[selectedSceneId].lines;
                  lines.push({ speaker: lines.length ? lines[lines.length - 1].speaker : "", text: "" });
                })
              }
            >
              + Line
            </Btn>
          </div>

          <div className="mt-4 mb-1 text-[10px] uppercase tracking-wider text-slate-500">Choices</div>
          {scene.choices.map((choice, cIndex) => (
            <div key={choice.id} className="mb-2 rounded border border-slate-700 bg-slate-900/60 p-2">
              <div className="mb-1 flex items-center gap-1">
                <Text
                  mono
                  value={choice.id}
                  onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].choices[cIndex].id = value; })}
                />
                <Btn tone="rose" onClick={() => update((draft) => { draft.scenes[selectedSceneId].choices.splice(cIndex, 1); })}>
                  ×
                </Btn>
              </div>
              <Area
                rows={2}
                value={choice.prompt}
                placeholder="Prompt shown above the options…"
                onChange={(value) => update((draft) => { draft.scenes[selectedSceneId].choices[cIndex].prompt = value; })}
              />
              <div className="mt-2 space-y-1">
                {choice.options.map((option, oIndex) => (
                  <div key={oIndex} className="rounded bg-slate-950/60 p-1.5">
                    <div className="flex gap-1">
                      <Text
                        value={option.text}
                        placeholder="Option text"
                        onChange={(value) =>
                          update((draft) => { draft.scenes[selectedSceneId].choices[cIndex].options[oIndex].text = value; })
                        }
                      />
                      <Btn
                        tone="rose"
                        onClick={() =>
                          update((draft) => { draft.scenes[selectedSceneId].choices[cIndex].options.splice(oIndex, 1); })
                        }
                      >
                        ×
                      </Btn>
                    </div>
                    <div className="mt-1">
                      <Text
                        mono
                        value={option.flag}
                        placeholder="campaignFlagSetByThisOption"
                        onChange={(value) =>
                          update((draft) => { draft.scenes[selectedSceneId].choices[cIndex].options[oIndex].flag = value; })
                        }
                      />
                    </div>
                  </div>
                ))}
                <Btn
                  full
                  onClick={() =>
                    update((draft) => {
                      const options = draft.scenes[selectedSceneId].choices[cIndex].options;
                      options.push({ id: "option" + (options.length + 1), text: "", flag: "", detail: "" });
                    })
                  }
                >
                  + Option
                </Btn>
              </div>
            </div>
          ))}
          <Btn
            full
            onClick={() =>
              update((draft) => {
                const choices = draft.scenes[selectedSceneId].choices;
                choices.push({
                  id: selectedSceneId + "Choice" + (choices.length + 1),
                  prompt: "",
                  options: [
                    { id: "option1", text: "", flag: "", detail: "" },
                    { id: "option2", text: "", flag: "", detail: "" }
                  ]
                });
              })
            }
          >
            + Choice
          </Btn>
        </Section>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------
 * MID-BATTLE BEATS
 * -------------------------------------------------------------*/

export function BeatsPanel({ mission, update, selectedBeatId, setSelectedBeatId }) {
  const beat = mission.midBattle.find((entry) => entry.id === selectedBeatId) || null;
  const index = mission.midBattle.findIndex((entry) => entry.id === selectedBeatId);
  const triggerType = beat ? triggerTypeById(beat.trigger.type) : null;

  return (
    <>
      <Section
        title={"Mid-battle beats (" + mission.midBattle.length + ")"}
        right={
          <Btn
            tone="sky"
            onClick={() =>
              update((draft) => {
                const id = uniqueId(draft.midBattle.map((b) => b.id), "beat");
                draft.midBattle.push({
                  id,
                  trigger: { type: "battleStarted" },
                  speaker: "",
                  text: "",
                  followUpLines: [],
                  priority: 50,
                  pauseBattle: true,
                  once: true,
                  when: null,
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
          {mission.midBattle.map((entry) => {
            const type = triggerTypeById(entry.trigger.type);
            return (
              <button
                key={entry.id}
                onClick={() => setSelectedBeatId(entry.id)}
                className={
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] " +
                  (selectedBeatId === entry.id ? "bg-sky-900/60 ring-1 ring-sky-600" : "hover:bg-slate-800")
                }
              >
                <span className={"h-2 w-2 shrink-0 rounded-full " + (type && type.supported ? "bg-emerald-400" : "bg-amber-400")} />
                <span className="font-mono text-slate-300">{entry.id}</span>
                <span className="flex-1 truncate text-slate-500">{entry.trigger.type}</span>
              </button>
            );
          })}
          {!mission.midBattle.length ? (
            <div className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              Beats are lines that fire during the battle when a condition is met — a contact report, a civilian
              panicking, a commander changing the plan.
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
                  draft.midBattle.splice(index, 1);
                  setSelectedBeatId(null);
                })
              }
            >
              Delete
            </Btn>
          }
        >
          <Field label="Id">
            <Text mono value={beat.id} onChange={(value) => update((draft) => { draft.midBattle[index].id = value; })} />
          </Field>

          <Field
            label="Trigger"
            hint={
              triggerType && !triggerType.supported
                ? "⚠ The engine does not implement this trigger yet — it will never fire. Authored so the beat is ready when it lands."
                : undefined
            }
          >
            <Select
              value={beat.trigger.type}
              onChange={(value) =>
                update((draft) => {
                  draft.midBattle[index].trigger = { type: value };
                })
              }
              options={TRIGGER_TYPES.map((entry) => ({
                value: entry.id,
                label: (entry.supported ? "" : "⚠ ") + entry.name
              }))}
            />
          </Field>

          {triggerType
            ? triggerType.fields.map((field) => (
                <TriggerField
                  key={field}
                  field={field}
                  mission={mission}
                  trigger={beat.trigger}
                  onPatch={(patch) => update((draft) => Object.assign(draft.midBattle[index].trigger, patch))}
                />
              ))
            : null}

          <Field label="Speaker">
            <Select
              value={beat.speaker}
              onChange={(value) => update((draft) => { draft.midBattle[index].speaker = value; })}
              options={SPEAKER_CATALOG.map((s) => ({ value: s.id, label: s.glyph + "  " + s.name }))}
            />
          </Field>
          <Field label="Line">
            <Area rows={3} value={beat.text} onChange={(value) => update((draft) => { draft.midBattle[index].text = value; })} />
          </Field>

          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Follow-up lines</div>
          <div className="space-y-1">
            {beat.followUpLines.map((line, lineIndex) => (
              <div key={lineIndex} className="rounded border border-slate-700 bg-slate-900/60 p-1.5">
                <div className="mb-1 flex gap-1">
                  <Select
                    value={line.speaker}
                    onChange={(value) =>
                      update((draft) => { draft.midBattle[index].followUpLines[lineIndex].speaker = value; })
                    }
                    options={SPEAKER_CATALOG.map((s) => ({ value: s.id, label: s.name }))}
                  />
                  <Btn
                    tone="rose"
                    onClick={() => update((draft) => { draft.midBattle[index].followUpLines.splice(lineIndex, 1); })}
                  >
                    ×
                  </Btn>
                </div>
                <Area
                  rows={2}
                  value={line.text}
                  onChange={(value) => update((draft) => { draft.midBattle[index].followUpLines[lineIndex].text = value; })}
                />
              </div>
            ))}
            <Btn
              full
              onClick={() =>
                update((draft) => {
                  draft.midBattle[index].followUpLines.push({ speaker: "kell", text: "" });
                })
              }
            >
              + Follow-up
            </Btn>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label="Priority" hint="Higher wins when two beats fire together.">
              <Num value={beat.priority} onChange={(value) => update((draft) => { draft.midBattle[index].priority = value || 0; })} />
            </Field>
            <div className="space-y-2 pt-5">
              <Check
                checked={beat.pauseBattle}
                onChange={(value) => update((draft) => { draft.midBattle[index].pauseBattle = value; })}
                label="Pause battle"
              />
              <Check
                checked={beat.once}
                onChange={(value) => update((draft) => { draft.midBattle[index].once = value; })}
                label="Fire once"
              />
            </div>
          </div>
        </Section>
      ) : null}
    </>
  );
}

function TriggerField({ field, mission, trigger, onPatch }) {
  if (field === "regionRef") {
    return (
      <Field label="Region" hint="The engine tests the region's bounding box, so keep trigger regions rectangular.">
        <Select
          allowEmpty
          value={trigger.regionRef || null}
          onChange={(value) => onPatch({ regionRef: value })}
          options={regionOptions(mission)}
        />
      </Field>
    );
  }
  if (field === "unitRefs") {
    return (
      <Field label="Units">
        <UnitRefPicker mission={mission} value={trigger.unitRefs} onChange={(value) => onPatch({ unitRefs: value })} />
      </Field>
    );
  }
  if (field === "teamId") {
    return (
      <Field label="Team">
        <Select
          allowEmpty
          value={trigger.teamId || null}
          onChange={(value) => onPatch({ teamId: value })}
          options={mission.teams.map((team) => ({ value: team.id, label: team.id }))}
        />
      </Field>
    );
  }
  if (field === "definitionIds") {
    const selected = new Set(trigger.definitionIds || []);
    return (
      <Field label="Chassis types">
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-1">
          {UNIT_CATALOG.map((unit) => (
            <label key={unit.id} className="flex cursor-pointer items-center gap-2 px-1 text-[11px] hover:bg-slate-800">
              <input
                type="checkbox"
                className="accent-sky-500"
                checked={selected.has(unit.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(unit.id);
                  else next.delete(unit.id);
                  onPatch({ definitionIds: [...next] });
                }}
              />
              <span className="text-slate-300">{unit.name}</span>
            </label>
          ))}
        </div>
      </Field>
    );
  }
  const numeric = ["count", "remainingAtMost", "percent", "occurrence", "destroyed", "afterActivations", "time", "value"];
  if (numeric.includes(field)) {
    return (
      <Field label={field}>
        <Num value={trigger[field]} onChange={(value) => onPatch({ [field]: value })} />
      </Field>
    );
  }
  return (
    <Field label={field}>
      <Text mono value={trigger[field]} onChange={(value) => onPatch({ [field]: value || undefined })} />
    </Field>
  );
}

/* ---------------------------------------------------------------
 * VALIDATION
 * -------------------------------------------------------------*/

export function ValidationPanel({ report }) {
  return (
    <div className="flex h-full flex-col">
      <div
        className={
          "px-3 py-2 text-[11px] font-bold uppercase tracking-widest " +
          (report.errors.length
            ? "bg-rose-950/70 text-rose-300"
            : report.warnings.length
            ? "bg-amber-950/60 text-amber-300"
            : "bg-emerald-950/60 text-emerald-300")
        }
      >
        {report.errors.length
          ? report.errors.length + " error" + (report.errors.length === 1 ? "" : "s") + " — will not load"
          : report.warnings.length
          ? "Valid · " + report.warnings.length + " warning" + (report.warnings.length === 1 ? "" : "s")
          : "Valid · no warnings"}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {report.errors.map((message, index) => (
          <div key={"e" + index} className="rounded border-l-2 border-rose-500 bg-rose-950/30 px-2 py-1 text-[11px] leading-relaxed text-rose-200">
            {message}
          </div>
        ))}
        {report.warnings.map((message, index) => (
          <div key={"w" + index} className="rounded border-l-2 border-amber-500 bg-amber-950/20 px-2 py-1 text-[11px] leading-relaxed text-amber-200">
            {message}
          </div>
        ))}
        {!report.errors.length && !report.warnings.length ? (
          <div className="text-[11px] text-slate-500">Nothing to report. This mission will load and run.</div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
 * MISSION METADATA
 * -------------------------------------------------------------*/

export function MissionPanel({ mission, update }) {
  return (
    <Section title="Mission">
      <Field label="Id" hint="Becomes the filename and the encounter id. Lowercase, numbers and hyphens.">
        <Text mono value={mission.id} onChange={(value) => update((draft) => { draft.id = value; })} />
      </Field>
      <Field label="Name">
        <Text value={mission.name} onChange={(value) => update((draft) => { draft.name = value; })} />
      </Field>
      <Field label="Scale" hint="Production target from the GDD. Only used to warn when the map is far off that size.">
        <Select
          value={mission.scale}
          onChange={(value) => update((draft) => { draft.scale = value; })}
          options={["S", "M", "L", "XL"].map((id) => ({ value: id, label: id }))}
        />
      </Field>
      <Field label="Summary">
        <Area rows={3} value={mission.summary} onChange={(value) => update((draft) => { draft.summary = value; })} />
      </Field>
      {/* The mission owns what clearing it is worth. A campaign decides when
       *  an operation is offered; it does not get to redefine what it pays. */}
      <Field
        label="Clear reward"
        hint="Paid on every successful clear, including the first. A repeatable reward is simply this one."
      >
        <Select
          allowEmpty
          value={(mission.rewards && mission.rewards.clear) || null}
          onChange={(value) =>
            update((draft) => {
              draft.rewards = { ...(draft.rewards || {}), clear: value || null };
            })
          }
          options={LOOT_TABLE_IDS.map((id) => ({ value: id, label: id }))}
        />
      </Field>
      <Field
        label="First-clear reward"
        hint="Paid only the first time this operation is cleared. Entries inside it may still be repeatable — the claim policy on each entry decides, not this slot."
      >
        <Select
          allowEmpty
          value={(mission.rewards && mission.rewards.firstClear) || null}
          onChange={(value) =>
            update((draft) => {
              draft.rewards = { ...(draft.rewards || {}), firstClear: value || null };
            })
          }
          options={LOOT_TABLE_IDS.map((id) => ({ value: id, label: id }))}
        />
      </Field>
    </Section>
  );
}
