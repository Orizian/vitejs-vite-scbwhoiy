import React from "react";
import { Btn } from "./panels.jsx";
import {
  REGISTRY_IDS,
  REGISTRY_KINDS,
  canonicalEntity
} from "../content/gameplay/format.js";
import { registrySchema, blankEntity } from "../content/gameplay/schema.js";
import { validateGameplayData, referencesTo } from "../content/gameplay/validate.js";
import {
  diffAgainstCanonical,
  dirtyIds,
  compareEntities,
  buildBundle,
  bundleToText,
  bundleFromText,
  draftFromBundle,
  manifestFromFiles
} from "../content/gameplay/exchange.js";
import {
  CANONICAL_GAMEPLAY,
  writeGameplayDraft,
  clearGameplayDraft
} from "../content/gameplay/registry.js";
import { resolveTestSubject } from "../content/gameplay/arena.js";
import { REACTION_EVENT_TYPE_IDS } from "../reactions/events.js";
import { REACTION_EFFECT_IDS } from "../reactions/effects.js";
import { REACTION_CONDITION_IDS } from "../reactions/conditions.js";

/** Option lists a schema field can name instead of restating. Keeps the
 *  editor's vocabulary and the engine's registries the same list. */
const DYNAMIC_OPTIONS = {
  reactionEvents: REACTION_EVENT_TYPE_IDS,
  reactionEffects: REACTION_EFFECT_IDS,
  reactionConditions: REACTION_CONDITION_IDS
};

/* =========================================================================
 * STATUS ZERO — GAMEPLAY DATA STUDIO
 *
 * The authoring surface for tactical game entities: units, abilities,
 * equipment, statuses, AI profiles, operators, perks and terrain.
 *
 * Three columns, matching the other two editors:
 *
 *   library     which registry, which entity
 *   overview    what this entity is, and what it composes into
 *   inspector   schema-driven fields for the selected section
 *
 * The inspector contains no entity ids. It renders whatever
 * `REGISTRY_SCHEMAS[kind].sections[].fields` declares, which is why adding a
 * field to a registry needs no change here.
 *
 * Draft isolation: edits live in editor state and, on Test, in a storage slot
 * the registry overlays at load. Canonical files are never written by the
 * Studio — the way data reaches the repository is an export.
 * =======================================================================*/

const DRAFT_KEY = "statuszero.gameplay.editorDraft";
const HISTORY_LIMIT = 60;

function cloneRegistries(source) {
  const out = {};
  for (const kindId of REGISTRY_IDS) out[kindId] = JSON.parse(JSON.stringify(source[kindId] || {}));
  return out;
}

function getPath(entity, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), entity);
}

function setPath(entity, path, value) {
  const keys = path.split(".");
  const next = JSON.parse(JSON.stringify(entity));
  let cursor = next;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cursor[keys[i]] == null || typeof cursor[keys[i]] !== "object") cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === "" || value === null) delete cursor[last];
  else cursor[last] = value;
  return next;
}

export default function GameplayStudio({ onTestUnit }) {
  const [data, setData] = React.useState(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const merged = cloneRegistries(CANONICAL_GAMEPLAY);
        for (const kindId of REGISTRY_IDS) {
          if (parsed[kindId]) merged[kindId] = parsed[kindId];
        }
        return merged;
      }
    } catch {
      /* fall through to canonical */
    }
    return cloneRegistries(CANONICAL_GAMEPLAY);
  });
  const [kindId, setKindId] = React.useState("units");
  const [entityId, setEntityId] = React.useState(null);
  const [sectionId, setSectionId] = React.useState(null);
  const [filter, setFilter] = React.useState("");
  const [note, setNote] = React.useState("");
  const [showSource, setShowSource] = React.useState(false);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const [pane, setPane] = React.useState("edit");
  const history = React.useRef({ past: [], future: [] });
  const fileInput = React.useRef(null);

  const flash = (message) => {
    setNote(message);
    setTimeout(() => setNote((current) => (current === message ? "" : current)), 3200);
  };

  React.useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch {
      /* storage may be unavailable */
    }
  }, [data]);

  const commit = React.useCallback((next) => {
    setData((current) => {
      history.current.past.push(current);
      if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
      history.current.future = [];
      return typeof next === "function" ? next(current) : next;
    });
  }, []);

  const undo = () => {
    const previous = history.current.past.pop();
    if (!previous) return;
    setData((current) => {
      history.current.future.push(current);
      return previous;
    });
  };

  /* ---- derived ---- */

  const entries = data[kindId] || {};
  const entity = entityId ? entries[entityId] : null;
  const schema = registrySchema(kindId);
  const kind = REGISTRY_KINDS[kindId];
  const section = schema && (schema.sections.find((s) => s.id === sectionId) || schema.sections[0]);

  const changes = React.useMemo(() => diffAgainstCanonical(CANONICAL_GAMEPLAY, data), [data]);
  const dirty = React.useMemo(() => dirtyIds(CANONICAL_GAMEPLAY, data), [data]);
  const report = React.useMemo(() => validateGameplayData(data), [data]);

  const grouped = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const groups = {};
    for (const id of Object.keys(entries).sort()) {
      const value = entries[id];
      if (needle) {
        const haystack = (id + " " + (value.name || "") + " " + (value.tags || []).join(" ")).toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      const groupName = schema && schema.categorize ? schema.categorize(value) : "All";
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(id);
    }
    return groups;
  }, [entries, filter, schema]);

  React.useEffect(() => {
    if (entityId && entries[entityId]) return;
    const first = Object.keys(entries).sort()[0] || null;
    setEntityId(first);
    setSectionId(null);
  }, [kindId, entries, entityId]);

  /* ---- entity operations ---- */

  const patchEntity = (path, value) => {
    if (!entityId) return;
    commit((current) => ({
      ...current,
      [kindId]: { ...current[kindId], [entityId]: setPath(current[kindId][entityId], path, value) }
    }));
  };

  const createEntity = () => {
    const id = prompt("New " + kind.singular + " id (stable, referenced by other data)");
    if (!id) return;
    const clean = id.trim();
    if (entries[clean]) {
      flash('"' + clean + '" already exists.');
      return;
    }
    commit((current) => ({ ...current, [kindId]: { ...current[kindId], [clean]: blankEntity(kindId) } }));
    setEntityId(clean);
    flash("Created " + clean);
  };

  const duplicateEntity = () => {
    if (!entityId) return;
    const id = prompt("New id for the copy", entityId + "-mk2");
    if (!id) return;
    const clean = id.trim();
    if (entries[clean]) {
      flash('"' + clean + '" already exists.');
      return;
    }
    const copy = JSON.parse(JSON.stringify(entries[entityId]));
    if (copy.name) copy.name = copy.name + " Mk II";
    commit((current) => ({ ...current, [kindId]: { ...current[kindId], [clean]: copy } }));
    setEntityId(clean);
    flash("Duplicated as " + clean);
  };

  const deleteEntity = () => {
    if (!entityId) return;
    const references = referencesTo(data, kindId, entityId, {});
    if (references.length) {
      flash(
        "Cannot delete " + entityId + " — referenced by " +
          references.map((entry) => entry.where).join(", ")
      );
      return;
    }
    if (!confirm("Delete " + entityId + "?")) return;
    commit((current) => {
      const next = { ...current[kindId] };
      delete next[entityId];
      return { ...current, [kindId]: next };
    });
    setEntityId(null);
    flash("Deleted " + entityId);
  };

  const revertEntity = () => {
    if (!entityId) return;
    const canonical = (CANONICAL_GAMEPLAY[kindId] || {})[entityId];
    commit((current) => {
      const next = { ...current[kindId] };
      if (canonical) next[entityId] = JSON.parse(JSON.stringify(canonical));
      else delete next[entityId];
      return { ...current, [kindId]: next };
    });
    flash("Reverted " + entityId);
  };

  const revertAll = () => {
    if (!confirm("Discard every change in this session?")) return;
    commit(cloneRegistries(CANONICAL_GAMEPLAY));
    clearGameplayDraft();
    flash("Reverted to canonical data.");
  };

  /* ---- export / import ---- */

  const download = (name, text) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const doExport = (mode) => {
    if (!report.ok) {
      flash("Fix " + report.errors.length + " data error(s) before exporting.");
      return;
    }
    const bundle = buildBundle(CANONICAL_GAMEPLAY, data, { mode });
    if (mode === "changes" && !bundle.changes.length) {
      flash("Nothing has changed — nothing to export.");
      return;
    }
    download("status-zero-gameplay-" + mode + ".txt", bundleToText(bundle));
    flash(
      "Exported " + mode + " bundle: " + bundle.changes.length + " entit" +
        (bundle.changes.length === 1 ? "y" : "ies") + " across " +
        Object.keys(bundle.files).length + " files."
    );
  };

  const doImport = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const files = bundleFromText(String(reader.result));
      const manifest = manifestFromFiles(files);
      const result = draftFromBundle(CANONICAL_GAMEPLAY, files);
      if (!result.applied.length) {
        flash("That bundle contained no gameplay registry files.");
        return;
      }
      // Imported as a draft, never installed: inspect, validate and test it
      // before anything is accepted.
      commit(result.draft);
      flash(
        "Imported as a draft: " + result.applied.map((entry) => entry.registry).join(", ") +
          (manifest ? " (" + manifest.mode + " bundle, " + manifest.entityCount + " entities)" : "") +
          (result.problems.length ? " · " + result.problems.length + " ignored" : "")
      );
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const testUnit = () => {
    if (!onTestUnit || !entityId) return;
    if (!report.ok) {
      flash("Fix " + report.errors.length + " data error(s) before testing.");
      return;
    }
    // Not everything in these registries is a thing you can deploy. The arena
    // resolver decides which unit actually exercises the selection and says
    // so; a silent substitution would make the reading worthless.
    const plan = resolveTestSubject(data, kindId, entityId);
    if (plan.error) {
      flash(plan.error);
      return;
    }
    // The draft goes to the slot the registry overlays at load, so the battle
    // runs on the real engine reading the real registry — with this change in
    // it. Nothing has to be exported first.
    writeGameplayDraft({
      registries: data,
      test: {
        kind: kindId,
        id: entityId,
        subject: plan.subject,
        reason: plan.reason,
        caveat: plan.caveat || null,
        changed: changes.length
      }
    });
    onTestUnit({ kind: kindId, id: entityId, plan });
    flash(plan.reason + (plan.caveat ? " " + plan.caveat : ""));
  };

  /* ---- render ---- */

  const dirtyCount = changes.length;

  return (
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        {REGISTRY_IDS.map((id) => (
          <button
            key={id}
            onClick={() => {
              setKindId(id);
              setEntityId(null);
              setSectionId(null);
            }}
            className={
              "rounded border px-3 py-1 text-[11px] uppercase tracking-wider transition " +
              (kindId === id
                ? "border-sky-400 bg-sky-900/60 text-sky-100"
                : "border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200")
            }
          >
            {REGISTRY_KINDS[id].label}
            {dirty[id] ? (
              <span className="ml-2 text-amber-300">●</span>
            ) : null}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-slate-700" />
        <Btn onClick={undo} title="Undo">↶</Btn>
        <Btn tone="sky" onClick={testUnit} disabled={!onTestUnit || !entityId}>
          ▶ Test Unit
        </Btn>
        <span className="mx-1 h-5 w-px bg-slate-700" />
        <Btn onClick={() => setPane(pane === "changes" ? "edit" : "changes")}>
          Changes{dirtyCount ? " (" + dirtyCount + ")" : ""}
        </Btn>
        <Btn tone="emerald" onClick={() => doExport("changes")} disabled={!report.ok || !dirtyCount}>
          Export changes
        </Btn>
        <Btn onClick={() => doExport("full")} disabled={!report.ok}>
          Export full
        </Btn>
        <Btn onClick={() => fileInput.current.click()}>Import…</Btn>
        <input ref={fileInput} type="file" accept=".txt,.json" className="hidden" onChange={doImport} />
        <span className="ml-auto max-w-[520px] truncate text-[11px] text-slate-500">
          {note ||
            (report.ok
              ? dirtyCount
                ? dirtyCount + " modified entit" + (dirtyCount === 1 ? "y" : "ies")
                : "Matches canonical data"
              : report.errors.length + " data error(s)")}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- library ---- */}
        <aside className="flex w-[270px] shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
          <div className="border-b border-slate-800 p-2">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={"Filter " + kind.label.toLowerCase() + "…"}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px]"
            />
            <div className="mt-2 flex gap-1">
              <Btn onClick={createEntity}>New</Btn>
              <Btn onClick={duplicateEntity} disabled={!entityId}>Duplicate</Btn>
              <Btn tone="rose" onClick={deleteEntity} disabled={!entityId}>Delete</Btn>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {Object.keys(grouped).sort().map((groupName) => (
              <div key={groupName}>
                <p className="sticky top-0 bg-slate-900/90 px-3 py-1 text-[10px] uppercase tracking-widest text-slate-600">
                  {groupName}
                </p>
                {grouped[groupName].map((id) => {
                  const value = entries[id];
                  const state = (dirty[kindId] || {})[id];
                  return (
                    <button
                      key={id}
                      onClick={() => setEntityId(id)}
                      className={
                        "block w-full border-b border-slate-800/60 px-3 py-2 text-left " +
                        (id === entityId ? "bg-sky-950/40" : "hover:bg-slate-800/40")
                      }
                    >
                      <p className="flex items-center gap-2 truncate text-[12px] text-slate-200">
                        {value.name || id}
                        {state ? <span className="text-[10px] text-amber-300">{state}</span> : null}
                      </p>
                      <p className="truncate font-mono text-[10px] text-sky-300/70">{id}</p>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* ---- centre ---- */}
        {pane === "changes" ? (
          <ChangesPane
            changes={changes}
            onOpen={(change) => {
              setKindId(change.kind);
              setEntityId(change.id);
              setPane("edit");
            }}
            onRevertAll={revertAll}
            report={report}
          />
        ) : entity ? (
          <section className="flex min-w-0 flex-1 flex-col overflow-auto">
            <EntityOverview
              kindId={kindId}
              entityId={entityId}
              entity={entity}
              data={data}
              onNavigate={(nextKind, nextId) => {
                setKindId(nextKind);
                setEntityId(nextId);
                setSectionId(null);
              }}
            />
            {showSource ? (
              <div className="border-t border-slate-800 p-3">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">
                  Canonical representation
                </p>
                <pre className="max-h-72 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-[10px] text-slate-400">
                  {JSON.stringify(canonicalEntity(kindId, entity), null, 2)}
                </pre>
              </div>
            ) : null}
            {compareOpen ? (
              <ComparePane kindId={kindId} entityId={entityId} entity={entity} />
            ) : null}
          </section>
        ) : (
          <section className="flex-1 p-6 text-[12px] text-slate-500">
            Select {kind.label.toLowerCase()} on the left, or create one.
          </section>
        )}

        {/* ---- inspector ---- */}
        <aside className="flex w-[400px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
          {entity && schema ? (
            <>
              <div className="flex flex-wrap gap-1 border-b border-slate-800 p-2">
                {schema.sections.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => setSectionId(entry.id)}
                    className={
                      "rounded border px-2 py-1 text-[10px] uppercase tracking-wider " +
                      (section && entry.id === section.id
                        ? "border-sky-500 bg-sky-900/50 text-sky-100"
                        : "border-slate-700 bg-slate-900 text-slate-400")
                    }
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <p className="mb-1 font-mono text-[11px] text-sky-300">{entityId}</p>
                <p className="mb-3 text-[10px] text-slate-600">{kind.singular}</p>
                {section ? (
                  <>
                    {section.note ? (
                      <p className="mb-3 border-l-2 border-slate-700 pl-2 text-[10px] leading-relaxed text-slate-500">
                        {section.note}
                      </p>
                    ) : null}
                    <div className="space-y-3">
                      {section.fields.map((field) => (
                        <SchemaField
                          key={field.key}
                          field={field}
                          value={field.key === "*" ? entity : getPath(entity, field.key)}
                          data={data}
                          onChange={(value) =>
                            field.key === "*"
                              ? commit((current) => ({
                                  ...current,
                                  [kindId]: { ...current[kindId], [entityId]: value }
                                }))
                              : patchEntity(field.key, value)
                          }
                        />
                      ))}
                    </div>
                  </>
                ) : null}
                <div className="mt-5 flex flex-wrap gap-1 border-t border-slate-800 pt-3">
                  <Btn onClick={revertEntity} disabled={!(dirty[kindId] || {})[entityId]}>
                    Revert entity
                  </Btn>
                  <Btn onClick={() => setCompareOpen((value) => !value)}>
                    {compareOpen ? "Hide compare" : "Compare"}
                  </Btn>
                  <Btn onClick={() => setShowSource((value) => !value)}>
                    {showSource ? "Hide source" : "Source"}
                  </Btn>
                </div>
              </div>
            </>
          ) : null}

          <div className="max-h-[38%] overflow-auto border-t border-slate-800">
            <div
              className={
                "px-3 py-2 text-[11px] font-bold uppercase tracking-widest " +
                (report.errors.length
                  ? "bg-rose-950/60 text-rose-200"
                  : report.warnings.length
                  ? "bg-amber-950/40 text-amber-200"
                  : "bg-emerald-950/40 text-emerald-200")
              }
            >
              {report.errors.length
                ? report.errors.length + " error" + (report.errors.length === 1 ? "" : "s") + " — will not export"
                : report.warnings.length
                ? "Valid · " + report.warnings.length + " warning" + (report.warnings.length === 1 ? "" : "s")
                : "Valid · no warnings"}
            </div>
            <div className="space-y-1 p-2">
              {report.errors.slice(0, 40).map((message, index) => (
                <p key={"e" + index} className="border-l-2 border-rose-500 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-200">
                  {message}
                </p>
              ))}
              {report.warnings.slice(0, 40).map((message, index) => (
                <p key={"w" + index} className="border-l-2 border-amber-500 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-200">
                  {message}
                </p>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
 * OVERVIEW
 * -------------------------------------------------------------*/

function Ref({ label, onClick, missing }) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded border px-2 py-0.5 text-[11px] " +
        (missing
          ? "border-rose-700 bg-rose-950/40 text-rose-300"
          : "border-slate-700 bg-slate-900 text-sky-300 hover:border-sky-500 hover:text-sky-100")
      }
    >
      {label}
      {missing ? " — missing" : ""}
    </button>
  );
}

function EntityOverview({ kindId, entityId, entity, data, onNavigate }) {
  const rows = [];

  if (kindId === "units") {
    rows.push(["Class", entity.classId || "—"]);
    rows.push(["AI profile", entity.aiProfile || "—"]);
    const pilots = Object.keys(data.operators || {}).filter(
      (id) => data.operators[id].chassis === entityId
    );
    rows.push(["Piloted by", pilots.length ? pilots.join(", ") : "no operator — an enemy or NPC frame"]);
  }
  if (kindId === "equipment") {
    rows.push(["Slot", entity.slot || "—"]);
    const classes = entity.compatibleClasses || [];
    const usable = Object.keys(data.units || {}).filter((id) => {
      const unit = data.units[id];
      return !classes.length || classes.includes(unit.classId);
    });
    rows.push([
      "Who can use this",
      classes.length
        ? "class " + classes.join(" or ") + " → " + usable.length + " unit(s)"
        : "any chassis → " + usable.length + " unit(s)"
    ]);
  }
  if (kindId === "operators") {
    rows.push(["Stable ref", entity.ref || entityId]);
  }
  if (kindId === "terrain") {
    rows.push(["Map character", entity.char ? '"' + entity.char + '"' : "— cannot be written to a map"]);
    rows.push([
      "Crossing it",
      entity.walkable === false
        ? "impassable"
        : "costs " + (entity.movementCost == null ? 1 : entity.movementCost) +
          (Number(entity.movementCost) > 1 ? " — half speed or worse" : "")
    ]);
    rows.push(["Line of sight", entity.blocksLineOfSight ? "blocked" : "clear"]);
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="font-display text-[24px] uppercase tracking-[0.04em] text-slate-100">
          {entity.name || entityId}
        </h2>
        <span className="font-mono text-[12px] text-sky-300/70">{entityId}</span>
      </div>
      {entity.description || entity.role ? (
        <p className="mb-5 max-w-[70ch] text-[12px] leading-relaxed text-slate-400">
          {entity.description || entity.role}
        </p>
      ) : null}

      {rows.length ? (
        <table className="mb-6 text-[12px]">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="py-1 pr-6 text-[10px] uppercase tracking-wider text-slate-600">{label}</td>
                <td className="py-1 text-slate-300">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {kindId === "units" || kindId === "operators" ? (
        <CompositionPanel kindId={kindId} entityId={entityId} entity={entity} data={data} onNavigate={onNavigate} />
      ) : null}

      <RelatedRefs kindId={kindId} entity={entity} data={data} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Composition, computed by the game.
 *
 * `window.STATUS_ZERO.composeUnitPreview` is the engine's own stat pipeline —
 * the Studio deliberately has no second calculator, because two calculators
 * eventually disagree and the wrong one is always the one you were reading.
 * When the engine is not present (the standalone editor page), the panel says
 * so rather than inventing numbers.
 */
function CompositionPanel({ kindId, entityId, entity, data, onNavigate }) {
  const chassisId = kindId === "operators" ? entity.chassis : entityId;
  const [preview, setPreview] = React.useState(null);

  // Keyed on the draft's own content, so typing a number moves the total. The
  // engine resolves `registries` ahead of its frozen CONTENT, which is what
  // lets an unsaved change be composed by the real pipeline.
  const signature = JSON.stringify([chassisId, data.units[chassisId], data.equipment, entity.defaultEquipment]);
  React.useEffect(() => {
    const api = typeof window !== "undefined" && window.STATUS_ZERO;
    if (!api || !api.composeUnitPreview) {
      setPreview({ unavailable: true });
      return;
    }
    setPreview(
      api.composeUnitPreview({
        definitionId: chassisId,
        equipment: entity.defaultEquipment || {},
        registries: { units: data.units, equipment: data.equipment, statuses: data.statuses }
      })
    );
  }, [signature]);

  const chassis = (data.units || {})[chassisId];

  return (
    <div className="mb-6">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-slate-600">Derived combat values</p>
      {kindId === "operators" ? (
        <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-500">
          <span>Frame</span>
          <Ref
            label={chassis ? chassis.name || chassisId : chassisId}
            missing={!chassis}
            onClick={() => onNavigate("units", chassisId)}
          />
        </div>
      ) : null}
      {!preview ? null : preview.unavailable ? (
        <p className="text-[11px] text-slate-600">
          Composition needs the running game. Open the editor from the main menu to see derived values.
        </p>
      ) : preview.error ? (
        <p className="text-[11px] text-rose-300">{preview.error}</p>
      ) : (
        <table className="text-[12px] tabular-nums">
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.stat}>
                <td className="py-0.5 pr-6 text-[10px] uppercase tracking-wider text-slate-600">{row.stat}</td>
                <td className="py-0.5 pr-6 text-slate-100">{row.total}</td>
                <td className="py-0.5 text-[10px] text-slate-600">{row.sources}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Clickable references out of this entity, so navigation is one hop. */
function RelatedRefs({ kindId, entity, data, onNavigate }) {
  const groups = [];
  const add = (label, registry, ids) => {
    if (!ids || !ids.length) return;
    groups.push({ label, registry, ids });
  };

  if (kindId === "units") {
    add("Abilities", "abilities", entity.abilities);
    add("AI profile", "aiProfiles", entity.aiProfile ? [entity.aiProfile] : []);
    add("Default equipment", "equipment", Object.values(entity.defaultEquipment || {}).filter(Boolean));
  }
  if (kindId === "equipment") {
    add("Grants", "abilities", entity.grantsAbilities);
    add("Removes", "abilities", entity.removesAbilities);
  }
  if (kindId === "abilities") {
    const statuses = (entity.effects || []).map((effect) => effect && effect.statusId).filter(Boolean);
    add("Applies statuses", "statuses", Array.from(new Set(statuses)));
    const summons = (entity.effects || []).map((effect) => effect && effect.definitionId).filter(Boolean);
    add("Summons", "units", Array.from(new Set(summons)));
  }
  if (kindId === "operators") {
    add("Perks", "perks", entity.perkChoices);
  }

  if (!groups.length) return null;
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1 text-[10px] uppercase tracking-widest text-slate-600">{group.label}</p>
          <div className="flex flex-wrap gap-2">
            {group.ids.map((id) => (
              <Ref
                key={id}
                label={((data[group.registry] || {})[id] || {}).name || id}
                missing={!(data[group.registry] || {})[id]}
                onClick={() => onNavigate(group.registry, id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
 * CHANGES AND COMPARE
 * -------------------------------------------------------------*/

function ChangesPane({ changes, onOpen, onRevertAll, report }) {
  return (
    <section className="min-w-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="font-display text-[20px] uppercase tracking-[0.04em] text-slate-100">
          Modified this session
        </h2>
        <Btn onClick={onRevertAll} disabled={!changes.length}>Revert all</Btn>
      </div>
      {!changes.length ? (
        <p className="text-[12px] text-slate-500">
          Nothing has changed. The draft matches the canonical data it was loaded from.
        </p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-600">
              <th className="py-1 text-left">Registry</th>
              <th className="py-1 text-left">Entity</th>
              <th className="py-1 text-left">Operation</th>
              <th className="py-1 text-left">Canonical file</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.kind + ":" + change.id} className="border-t border-slate-800/70">
                <td className="py-1 pr-4 text-slate-400">{REGISTRY_KINDS[change.kind].label}</td>
                <td className="py-1 pr-4">
                  <button onClick={() => onOpen(change)} className="font-mono text-sky-300 hover:text-sky-100">
                    {change.id}
                  </button>
                </td>
                <td className="py-1 pr-4 text-amber-300">{change.operation}</td>
                <td className="py-1 font-mono text-[10px] text-slate-600">
                  {REGISTRY_KINDS[change.kind].path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!report.ok ? (
        <p className="mt-6 border-l-2 border-rose-500 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">
          Export is blocked until the {report.errors.length} data error(s) are fixed.
        </p>
      ) : null}
    </section>
  );
}

function ComparePane({ kindId, entityId, entity }) {
  const canonical = (CANONICAL_GAMEPLAY[kindId] || {})[entityId];
  const rows = compareEntities(kindId, canonical, entity);
  return (
    <div className="border-t border-slate-800 p-4">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">
        Canonical vs draft
      </p>
      {!rows.length ? (
        <p className="text-[11px] text-slate-600">Identical to canonical.</p>
      ) : (
        <table className="text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-600">
              <th className="py-1 pr-6 text-left">Field</th>
              <th className="py-1 pr-6 text-left">Canonical</th>
              <th className="py-1 text-left">Draft</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.path} className="border-t border-slate-800/60">
                <td className="py-1 pr-6 font-mono text-[11px] text-slate-400">{row.path}</td>
                <td className="py-1 pr-6 text-slate-500">{row.before}</td>
                <td className="py-1 text-sky-200">{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
 * SCHEMA-DRIVEN FIELDS
 * -------------------------------------------------------------*/

const CHANNELS = ["optical", "thermal", "signal", "acoustic", "intel"];

function SchemaField({ field, value, data, onChange }) {
  const box = "w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[12px] text-slate-100";
  const label = (
    <span className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
      {field.label}
      {field.behaviour ? (
        <span
          title="Selects engine behaviour. The parameter is authored; the behaviour behind it is code."
          className="rounded border border-slate-700 px-1 text-[9px] text-slate-500"
        >
          engine
        </span>
      ) : null}
    </span>
  );
  const help = field.help ? (
    <span className="mt-1 block text-[10px] leading-relaxed text-slate-600">{field.help}</span>
  ) : null;

  if (field.kind === "text") {
    return (
      <label className="block">
        {label}
        <textarea
          rows={field.rows || 3}
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          className={box + " resize-y leading-relaxed"}
        />
        {help}
      </label>
    );
  }

  if (field.kind === "number") {
    return (
      <label className="block">
        {label}
        <input
          type="number"
          value={value == null ? "" : value}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          className={box}
        />
        {help}
      </label>
    );
  }

  if (field.kind === "boolean") {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
    );
  }

  if (field.kind === "enum") {
    const options = field.optionsFrom
      ? DYNAMIC_OPTIONS[field.optionsFrom] || []
      : field.options || [];
    return (
      <label className="block">
        {label}
        <select value={value == null ? "" : value} onChange={(event) => onChange(event.target.value)} className={box}>
          <option value="">—</option>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        {help}
      </label>
    );
  }

  if (field.kind === "tags") {
    return (
      <label className="block">
        {label}
        <input
          value={(value || []).join(", ")}
          onChange={(event) =>
            onChange(event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean))
          }
          className={box}
          placeholder="comma, separated"
        />
        {help}
      </label>
    );
  }

  if (field.kind === "ref" || field.kind === "refList") {
    // Some registries are addressed by a stable field rather than by their
    // key — an operator's `ref` is what reactions and links name, and it is
    // deliberately allowed to differ from the key it is filed under.
    const entries = data[field.registry] || {};
    const options = Object.keys(entries)
      .map((key) => (field.refField ? entries[key][field.refField] || key : key))
      .sort();
    const isList = field.kind === "refList";
    const current = isList ? value || [] : value == null ? "" : value;
    return (
      <div>
        {label}
        {isList ? (
          <>
            <div className="mb-1 flex flex-wrap gap-1">
              {current.map((id) => (
                <span
                  key={id}
                  className={
                    "flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] " +
                    (data[field.registry][id]
                      ? "border-slate-700 bg-slate-900 text-slate-200"
                      : "border-rose-700 bg-rose-950/40 text-rose-300")
                  }
                >
                  {id}
                  <button
                    onClick={() => onChange(current.filter((entry) => entry !== id))}
                    className="text-slate-500 hover:text-rose-300"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <select
              value=""
              onChange={(event) => {
                if (!event.target.value) return;
                if (current.includes(event.target.value)) return;
                onChange(current.concat(event.target.value));
              }}
              className={box}
            >
              <option value="">add…</option>
              {options.map((id) => (
                <option key={id} value={id}>
                  {(data[field.registry][id] || {}).name || id}
                </option>
              ))}
            </select>
          </>
        ) : (
          <select value={current} onChange={(event) => onChange(event.target.value)} className={box}>
            <option value="">—</option>
            {options.map((id) => (
              <option key={id} value={id}>
                {(data[field.registry][id] || {}).name || id}
              </option>
            ))}
            {current && !options.includes(current) ? (
              <option value={current}>{current} (missing)</option>
            ) : null}
          </select>
        )}
        {help}
      </div>
    );
  }

  if (field.kind === "statBlock") {
    const stats = value || {};
    return (
      <div>
        {label}
        <div className="grid grid-cols-2 gap-2">
          {(field.stats || []).map((stat) => (
            <label key={stat.key} className="block">
              <span className="mb-0.5 block text-[10px] text-slate-500">{stat.label}</span>
              <input
                type="number"
                value={stats[stat.key] == null ? "" : stats[stat.key]}
                onChange={(event) =>
                  onChange({
                    ...stats,
                    [stat.key]: event.target.value === "" ? undefined : Number(event.target.value)
                  })
                }
                className={box}
              />
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.kind === "channelMap") {
    const map = value || {};
    return (
      <div>
        {label}
        <div className="grid grid-cols-2 gap-2">
          {CHANNELS.map((channel) => {
            const raw = field.factor ? map[channel] : (map[channel] || {}).range;
            return (
              <label key={channel} className="block">
                <span className="mb-0.5 block text-[10px] text-slate-500">{channel}</span>
                <input
                  type="number"
                  step={field.factor ? "0.1" : "1"}
                  value={raw == null ? "" : raw}
                  onChange={(event) => {
                    const next = { ...map };
                    if (event.target.value === "") delete next[channel];
                    else if (field.factor) next[channel] = Number(event.target.value);
                    else next[channel] = { range: Number(event.target.value) };
                    onChange(Object.keys(next).length ? next : undefined);
                  }}
                  className={box}
                />
              </label>
            );
          })}
        </div>
        {help}
      </div>
    );
  }

  if (field.kind === "resourceMap") {
    const map = value || {};
    const setPool = (key, patch) =>
      onChange({ ...map, [key]: { ...map[key], ...patch } });
    return (
      <div>
        {label}
        <div className="space-y-2">
          {Object.keys(map).sort().map((key) => (
            <div key={key} className="flex items-end gap-2">
              <span className="w-28 shrink-0 truncate pb-1 text-[11px] text-slate-300">{key}</span>
              <label className="block">
                <span className="mb-0.5 block text-[10px] text-slate-500">max</span>
                <input
                  type="number"
                  value={map[key].max == null ? "" : map[key].max}
                  onChange={(event) => setPool(key, { max: Number(event.target.value) })}
                  className={box}
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] text-slate-500">starts at</span>
                <input
                  type="number"
                  placeholder="full"
                  value={map[key].startsAt == null ? "" : map[key].startsAt}
                  onChange={(event) => {
                    const next = { ...map, [key]: { ...map[key] } };
                    if (event.target.value === "") delete next[key].startsAt;
                    else next[key].startsAt = Number(event.target.value);
                    onChange(next);
                  }}
                  className={box}
                />
              </label>
              <button
                onClick={() => {
                  const next = { ...map };
                  delete next[key];
                  onChange(Object.keys(next).length ? next : undefined);
                }}
                className="pb-1 text-[11px] text-slate-500 hover:text-rose-300"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            const key = prompt("Pool name (abilities spend it by this id)");
            if (key) onChange({ ...map, [key.trim()]: { max: 100 } });
          }}
          className="mt-1 text-[10px] text-sky-400 hover:text-sky-200"
        >
          + add pool
        </button>
        {help}
      </div>
    );
  }

  if (field.kind === "numberMap") {
    const map = value || {};
    return (
      <div>
        {label}
        <div className="space-y-1">
          {Object.keys(map).sort().map((key) => (
            <div key={key} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-[11px] text-slate-400">{key}</span>
              <input
                type="number"
                step="any"
                value={map[key]}
                onChange={(event) => onChange({ ...map, [key]: Number(event.target.value) })}
                className={box}
              />
              <button
                onClick={() => {
                  const next = { ...map };
                  delete next[key];
                  onChange(next);
                }}
                className="text-[11px] text-slate-500 hover:text-rose-300"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            const key = prompt("New key");
            if (key) onChange({ ...map, [key.trim()]: 0 });
          }}
          className="mt-1 text-[10px] text-sky-400 hover:text-sky-200"
        >
          + add
        </button>
        {help}
      </div>
    );
  }

  if (field.kind === "modifierList") {
    const list = value || [];
    return (
      <div>
        {label}
        <div className="space-y-1">
          {list.map((modifier, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                value={modifier.stat || ""}
                onChange={(event) => {
                  const next = list.slice();
                  next[index] = { ...modifier, stat: event.target.value };
                  onChange(next);
                }}
                className={box + " w-28"}
                placeholder="stat"
              />
              <select
                value={modifier.mode || "flat"}
                onChange={(event) => {
                  const next = list.slice();
                  next[index] = { ...modifier, mode: event.target.value };
                  onChange(next);
                }}
                className={box + " w-24"}
              >
                <option value="flat">flat</option>
                <option value="percent">percent</option>
              </select>
              <input
                type="number"
                value={modifier.value == null ? "" : modifier.value}
                onChange={(event) => {
                  const next = list.slice();
                  next[index] = { ...modifier, value: Number(event.target.value) };
                  onChange(next);
                }}
                className={box + " w-20"}
              />
              <button
                onClick={() => onChange(list.filter((_, i) => i !== index))}
                className="text-[11px] text-slate-500 hover:text-rose-300"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => onChange(list.concat({ stat: "attack", mode: "flat", value: 0 }))}
          className="mt-1 text-[10px] text-sky-400 hover:text-sky-200"
        >
          + add modifier
        </button>
      </div>
    );
  }

  if (field.kind === "slotMap") {
    const map = value || {};
    const slots = ["primaryWeapon", "armor", "utilitySystem", "coreSystem"];
    const options = Object.keys(data[field.registry] || {}).sort();
    return (
      <div>
        {label}
        <div className="space-y-2">
          {slots.map((slot) => (
            <label key={slot} className="block">
              <span className="mb-0.5 block text-[10px] text-slate-500">{slot}</span>
              <select
                value={map[slot] || ""}
                onChange={(event) => {
                  const next = { ...map };
                  if (!event.target.value) delete next[slot];
                  else next[slot] = event.target.value;
                  onChange(Object.keys(next).length ? next : undefined);
                }}
                className={box}
              >
                <option value="">—</option>
                {options
                  .filter((id) => (data[field.registry][id] || {}).slot === slot)
                  .map((id) => (
                    <option key={id} value={id}>
                      {(data[field.registry][id] || {}).name || id}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        {help}
      </div>
    );
  }

  if (field.kind === "objectList") {
    // `single` fields hold one object rather than a list — a reaction has one
    // effect, not a sequence of them.
    const current = field.single ? value || {} : value || [];
    const vocabulary =
      field.typeKey === "type"
        ? REACTION_EFFECT_IDS
        : field.typeKey === "*"
        ? REACTION_CONDITION_IDS
        : null;
    return (
      <div>
        {label}
        <p className="mb-2 text-[10px] leading-relaxed text-slate-600">
          {field.typeKey === "*" ? (
            <>Each entry names one condition kind. The values beside it are authored.</>
          ) : (
            <>
              The <code>{field.typeKey || "type"}</code> selects engine behaviour; the values beside
              it are authored.
            </>
          )}{" "}
          Edited as canonical JSON, so the editor cannot claim a handler accepts something it does
          not.
        </p>
        {vocabulary ? (
          <p className="mb-2 break-words text-[10px] leading-relaxed text-slate-700">
            Available: {vocabulary.join(", ")}
          </p>
        ) : null}
        <textarea
          rows={Math.min(20, Math.max(4, JSON.stringify(current, null, 2).split("\n").length))}
          value={JSON.stringify(current, null, 2)}
          onChange={(event) => {
            try {
              const parsed = JSON.parse(event.target.value);
              if (field.single ? parsed && typeof parsed === "object" && !Array.isArray(parsed) : Array.isArray(parsed)) {
                onChange(parsed);
              }
            } catch {
              /* keep the last valid value while mid-edit */
            }
          }}
          className={box + " font-mono text-[11px] leading-relaxed"}
        />
      </div>
    );
  }

  return (
    <label className="block">
      {label}
      <input value={value == null ? "" : value} onChange={(event) => onChange(event.target.value)} className={box} />
      {help}
    </label>
  );
}
