import React from "react";
import { Btn } from "./panels.jsx";
import { CAMPAIGN_CONTENT } from "../content/campaign-registry.js";
import {
  normalizeNode,
  orderedNodes,
  deriveEdges,
  rootNodeIds,
  reachability,
  findNodeCycles,
  nodeAvailability,
  availableNodeIds,
  validateCampaign,
  ROSTER_SELECTORS
} from "../campaign/progression.js";
import { GAMEPLAY_CONTENT } from "../content/gameplay/registry.js";
import { MISSION_CONTENT } from "../content/mission-registry.js";

/* =========================================================================
 * CAMPAIGN EDITOR
 *
 * The progression graph, edited as the same data the game runs.
 *
 * Three things this deliberately does not do:
 *
 *   It does not author edges. Every arrow is derived from what a node
 *   `requires` and what other nodes `grantsFlags`. Dragging a connection
 *   would create a second graph authority, and the moment those two disagree
 *   the editor is showing a campaign that does not exist.
 *
 *   It does not evaluate availability itself. The preview calls the same
 *   `nodeAvailability` the mission board calls, so "why is this locked" has
 *   one answer rather than an editor's opinion and a runtime's.
 *
 *   It does not own a database. Edits live in a draft; canonical files change
 *   only through an export, exactly as the other three editors work.
 * =======================================================================*/

const DRAFT_KEY = "statuszero.campaign.editorDraft";

/** Layout is editor metadata. Nothing in the runtime may read it, so a node
 *  without a stored position simply gets a computed one. */
const COLUMN_WIDTH = 230;
const ROW_HEIGHT = 96;

function cloneContent(source) {
  return {
    ...source,
    nodes: Object.fromEntries(
      Object.entries(source.nodes).map(([id, node]) => [id, JSON.parse(JSON.stringify(node))])
    )
  };
}

/**
 * Where each node sits, derived from the graph when the author has not said.
 *
 * Depth is "how many steps from a root", which puts prerequisites left of the
 * things that need them without anybody positioning anything.
 */
function layoutNodes(content) {
  const nodes = orderedNodes(content);
  const edges = deriveEdges(content).filter((edge) => !edge.dangling);
  const depth = {};
  for (const node of nodes) depth[node.id] = 0;
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const edge of edges) {
      const next = depth[edge.from] + 1;
      if (next > depth[edge.to]) {
        depth[edge.to] = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const perDepth = {};
  const placed = {};
  for (const node of nodes) {
    const d = depth[node.id] || 0;
    perDepth[d] = (perDepth[d] || 0) + 1;
    const authored = node.editor;
    placed[node.id] = {
      x: authored && Number.isFinite(authored.x) ? authored.x : 40 + d * COLUMN_WIDTH,
      y: authored && Number.isFinite(authored.y) ? authored.y : 30 + (perDepth[d] - 1) * ROW_HEIGHT,
      depth: d
    };
  }
  return placed;
}

export default function CampaignEditor({ onOpenMission, onPlayNode }) {
  const [content, setContent] = React.useState(() => {
    try {
      const stored = localStorage.getItem(DRAFT_KEY);
      if (stored) return { ...CAMPAIGN_CONTENT, ...JSON.parse(stored) };
    } catch {
      /* fall through to canonical */
    }
    return cloneContent(CAMPAIGN_CONTENT);
  });
  const [selectedId, setSelectedId] = React.useState(() => orderedNodes(CAMPAIGN_CONTENT)[0]?.id || null);
  const [previewFlags, setPreviewFlags] = React.useState({});
  const [note, setNote] = React.useState("");

  const flash = (message) => {
    setNote(message);
    setTimeout(() => setNote((current) => (current === message ? "" : current)), 3200);
  };

  React.useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ nodes: content.nodes }));
    } catch {
      /* storage may be unavailable */
    }
  }, [content]);

  const nodes = orderedNodes(content);
  const edges = deriveEdges(content);
  const positions = React.useMemo(() => layoutNodes(content), [content]);
  const selected = selectedId ? content.nodes[selectedId] : null;

  const report = React.useMemo(
    () =>
      validateCampaign(content, {
        missionIds: Object.keys(MISSION_CONTENT.missions).concat(nodes.map((node) => node.missionId)),
        operatorIds: Object.keys(GAMEPLAY_CONTENT.operators),
        contactIds: Object.keys(content.contacts || {}),
        facilityIds: Object.keys(content.facilities || {}),
        currencyIds: Object.keys(content.startingCurrencies || {})
      }),
    [content, nodes]
  );

  const analysis = React.useMemo(
    () => ({
      roots: rootNodeIds(content),
      ...reachability(content),
      cycles: findNodeCycles(content)
    }),
    [content]
  );

  const dirty = React.useMemo(
    () => JSON.stringify(content.nodes) !== JSON.stringify(CAMPAIGN_CONTENT.nodes),
    [content]
  );

  const problemsFor = (nodeId) =>
    report.errors.concat(report.warnings).filter((message) => message.includes('"' + nodeId + '"'));

  /* ---- editing ---- */

  const patch = (nodeId, changes) =>
    setContent((current) => ({
      ...current,
      nodes: {
        ...current.nodes,
        [nodeId]: normalizeNode({ ...current.nodes[nodeId], ...changes }, nodeId)
      }
    }));

  const createNode = () => {
    const id = prompt("New campaign node id (stable, becomes the filename)");
    if (!id) return;
    const clean = id.trim();
    if (content.nodes[clean]) {
      flash('"' + clean + '" already exists.');
      return;
    }
    const highest = nodes.reduce((max, node) => Math.max(max, node.order), 0);
    setContent((current) => ({
      ...current,
      nodes: {
        ...current.nodes,
        [clean]: normalizeNode(
          { id: clean, name: clean, missionId: null, order: highest + 1, nodeKind: "battle" },
          clean
        )
      }
    }));
    setSelectedId(clean);
    flash("Created " + clean);
  };

  const duplicateNode = () => {
    if (!selected) return;
    const id = prompt("New id for the copy", selected.id + "-copy");
    if (!id) return;
    const clean = id.trim();
    if (content.nodes[clean]) {
      flash('"' + clean + '" already exists.');
      return;
    }
    const copy = normalizeNode({ ...JSON.parse(JSON.stringify(selected)), id: clean }, clean);
    // A duplicate must not grant the same flags: two nodes granting one flag
    // would silently make either of them satisfy everything downstream.
    copy.grantsFlags = [];
    setContent((current) => ({ ...current, nodes: { ...current.nodes, [clean]: copy } }));
    setSelectedId(clean);
    flash("Duplicated as " + clean + " (granted flags cleared)");
  };

  /**
   * Deleting a node that something waits on would orphan it.
   *
   * Refused rather than cascaded: the author knows whether the dependent
   * should now be a root or should wait on something else, and guessing is how
   * a campaign quietly loses a mission.
   */
  const deleteNode = () => {
    if (!selected) return;
    const dependents = edges
      .filter((edge) => edge.from === selected.id)
      .map((edge) => edge.to)
      .filter((id, index, list) => list.indexOf(id) === index);
    if (dependents.length) {
      flash("Cannot delete: " + dependents.join(", ") + " wait on it.");
      return;
    }
    setContent((current) => {
      const next = { ...current.nodes };
      delete next[selected.id];
      return { ...current, nodes: next };
    });
    setSelectedId(orderedNodes(content).find((node) => node.id !== selected.id)?.id || null);
    flash("Deleted " + selected.id);
  };

  const revert = () => {
    setContent(cloneContent(CAMPAIGN_CONTENT));
    flash("Reverted to the shipped campaign");
  };

  const exportDraft = () => {
    const files = orderedNodes(content).map((node) => ({
      path: "src/content/campaign/nodes/" + node.id + ".json",
      contents: serializeNode(node)
    }));
    const blob = new Blob([JSON.stringify({ files }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "campaign-nodes.json";
    link.click();
    URL.revokeObjectURL(url);
    flash("Exported " + files.length + " node files");
  };

  /* ---- preview ---- */

  const previewState = { flags: previewFlags, completed: [] };
  const previewAvailable = availableNodeIds(content, previewState);
  const allFlags = Array.from(new Set(nodes.flatMap((node) => node.grantsFlags))).sort();

  const box =
    "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-500";

  return (
    <div className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      <header className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2">
        <span className="mr-2 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">Campaign</span>
        <Btn onClick={createNode}>New node</Btn>
        <Btn onClick={duplicateNode} disabled={!selected}>Duplicate</Btn>
        <Btn onClick={deleteNode} disabled={!selected}>Delete</Btn>
        <span className="mx-2 h-5 w-px bg-slate-700" />
        <Btn onClick={exportDraft}>Export…</Btn>
        <Btn onClick={revert} disabled={!dirty}>Revert</Btn>
        {dirty ? <span className="text-[11px] text-amber-300">unsaved changes</span> : null}
        <span className="flex-1" />
        <span className={report.errors.length ? "text-[11px] text-rose-300" : "text-[11px] text-emerald-300"}>
          {report.errors.length
            ? report.errors.length + " problem" + (report.errors.length === 1 ? "" : "s")
            : "valid"}
        </span>
        {note ? <span className="ml-3 text-[11px] text-sky-300">{note}</span> : null}
      </header>

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "220px 1fr 320px" }}>
        {/* ---- browser ---- */}
        <div className="min-h-0 overflow-auto border-r border-slate-800">
          <p className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-slate-600">
            Nodes · {nodes.length}
          </p>
          {nodes.map((node) => (
            <button
              key={node.id}
              onClick={() => setSelectedId(node.id)}
              className={
                "block w-full border-b border-slate-800/60 px-3 py-2 text-left " +
                (node.id === selectedId ? "bg-sky-950/40" : "hover:bg-slate-800/40")
              }
            >
              <p className="flex items-center gap-2 truncate text-[12px] text-slate-200">
                {node.name || node.id}
                {problemsFor(node.id).length ? <span className="text-[10px] text-rose-300">!</span> : null}
              </p>
              <p className="truncate font-mono text-[10px] text-sky-300/70">{node.id}</p>
            </button>
          ))}
          <p className="px-3 pb-1 pt-4 text-[10px] uppercase tracking-[0.2em] text-slate-600">Reachability</p>
          <div className="space-y-1 px-3 pb-4 text-[11px] text-slate-400">
            <p>Roots: {analysis.roots.length ? analysis.roots.join(", ") : "none"}</p>
            <p className={analysis.unreachable.length ? "text-rose-300" : ""}>
              Unreachable: {analysis.unreachable.length || "none"}
            </p>
            <p className={analysis.cycles.length ? "text-rose-300" : ""}>
              Cycles: {analysis.cycles.length || "none"}
            </p>
          </div>
        </div>

        {/* ---- graph ---- */}
        <div className="relative min-h-0 overflow-auto bg-slate-950/60">
          <GraphView
            nodes={nodes}
            edges={edges}
            positions={positions}
            selectedId={selectedId}
            available={previewAvailable}
            onSelect={setSelectedId}
            problemsFor={problemsFor}
          />
        </div>

        {/* ---- inspector ---- */}
        <div className="min-h-0 overflow-auto border-l border-slate-800 p-3">
          {selected ? (
            <NodeInspector
              node={selected}
              content={content}
              patch={patch}
              box={box}
              problems={problemsFor(selected.id)}
              availability={nodeAvailability(content, previewState, selected.id)}
              onOpenMission={onOpenMission}
              onPlayNode={onPlayNode}
            />
          ) : (
            <p className="text-[12px] text-slate-600">Select a node.</p>
          )}

          <div className="mt-6 border-t border-slate-800 pt-3">
            <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-slate-600">Availability preview</p>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
              Tick flags to simulate a playthrough. This calls the same availability the
              mission board calls, so it cannot disagree with the game.
            </p>
            <div className="max-h-48 space-y-1 overflow-auto">
              {allFlags.map((flag) => (
                <label key={flag} className="flex items-center gap-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={previewFlags[flag] === true}
                    onChange={(event) =>
                      setPreviewFlags((current) => ({ ...current, [flag]: event.target.checked }))
                    }
                  />
                  <span className="font-mono">{flag}</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-emerald-300">
              Offered now: {previewAvailable.length ? previewAvailable.join(", ") : "nothing"}
            </p>
          </div>

          {report.errors.length ? (
            <div className="mt-6 border-t border-slate-800 pt-3">
              <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-rose-400">Problems</p>
              <ul className="space-y-1 text-[11px] leading-relaxed text-rose-300">
                {report.errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
 * GRAPH
 * -------------------------------------------------------------*/

function GraphView({ nodes, edges, positions, selectedId, available, onSelect, problemsFor }) {
  const width = Math.max(600, ...nodes.map((node) => positions[node.id].x + 260));
  const height = Math.max(400, ...nodes.map((node) => positions[node.id].y + 90));

  return (
    <svg width={width} height={height} className="block">
      {edges.map((edge, index) => {
        const to = positions[edge.to];
        if (!to) return null;
        if (edge.dangling) {
          return (
            <g key={"d" + index}>
              <line
                x1={to.x - 24}
                y1={to.y + 26}
                x2={to.x}
                y2={to.y + 26}
                stroke="#f43f5e"
                strokeWidth="2"
                strokeDasharray="4 3"
              />
              <text x={to.x - 90} y={to.y + 22} fill="#f43f5e" fontSize="9">
                {edge.flag}?
              </text>
            </g>
          );
        }
        const from = positions[edge.from];
        if (!from) return null;
        const x1 = from.x + 190;
        const y1 = from.y + 26;
        const x2 = to.x;
        const y2 = to.y + 26;
        const mid = (x1 + x2) / 2;
        return (
          <g key={edge.from + edge.to + edge.flag + index}>
            <path
              d={"M " + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + mid + " " + y2 + ", " + x2 + " " + y2}
              fill="none"
              stroke="#334155"
              strokeWidth="1.5"
            />
            <circle cx={x2} cy={y2} r="2.5" fill="#475569" />
          </g>
        );
      })}
      {nodes.map((node) => {
        const at = positions[node.id];
        const selected = node.id === selectedId;
        const offered = available.includes(node.id);
        const broken = problemsFor(node.id).length > 0;
        return (
          <g
            key={node.id}
            transform={"translate(" + at.x + "," + at.y + ")"}
            onClick={() => onSelect(node.id)}
            style={{ cursor: "pointer" }}
          >
            <rect
              width="190"
              height="52"
              rx="3"
              fill={selected ? "#0c4a6e" : "#0f172a"}
              stroke={broken ? "#f43f5e" : selected ? "#38bdf8" : offered ? "#34d399" : "#334155"}
              strokeWidth={selected ? 2 : 1}
            />
            <text x="10" y="20" fill="#e2e8f0" fontSize="11">
              {(node.name || node.id).slice(0, 26)}
            </text>
            <text x="10" y="36" fill="#7dd3fc" fontSize="9" fontFamily="monospace">
              {node.id.slice(0, 30)}
            </text>
            <text x="178" y="20" fill="#64748b" fontSize="9" textAnchor="end">
              {node.order}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------------------------------------------------------
 * INSPECTOR
 * -------------------------------------------------------------*/

function NodeInspector({ node, content, patch, box, problems, availability, onOpenMission, onPlayNode }) {
  const missionIds = Object.keys(MISSION_CONTENT.missions).sort();
  const grantedElsewhere = Array.from(
    new Set(
      orderedNodes(content)
        .filter((other) => other.id !== node.id)
        .flatMap((other) => other.grantsFlags)
    )
  ).sort();

  const field = (label, help, control) => (
    <div className="mb-3">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {control}
      {help ? <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{help}</p> : null}
    </div>
  );

  const toggleIn = (list, value) =>
    list.includes(value) ? list.filter((entry) => entry !== value) : list.concat(value);

  return (
    <div>
      <p className="mb-1 font-mono text-[11px] text-sky-300">{node.id}</p>
      {problems.length ? (
        <ul className="mb-3 space-y-1 text-[11px] text-rose-300">
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {field(
        "Name",
        null,
        <input className={box} value={node.name || ""} onChange={(e) => patch(node.id, { name: e.target.value })} />
      )}
      {field(
        "Mission",
        "The operation this node offers. Mission content owns the map, the enemies and what clearing it pays; the node says when it appears.",
        <select
          className={box}
          value={node.missionId || ""}
          onChange={(e) => patch(node.id, { missionId: e.target.value || null })}
        >
          <option value="">— none —</option>
          {missionIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          {node.missionId && !missionIds.includes(node.missionId) ? (
            <option value={node.missionId}>{node.missionId} (no mission file)</option>
          ) : null}
        </select>
      )}
      <div className="mb-3 flex gap-2">
        <Btn onClick={() => onOpenMission && onOpenMission(node.missionId)} disabled={!node.missionId}>
          Open mission
        </Btn>
        <Btn onClick={() => onPlayNode && onPlayNode(node)} disabled={!node.missionId}>
          Play from here
        </Btn>
      </div>

      {field(
        "Order",
        "Presentation order on the mission board. Not a dependency — what gates a node is what it requires.",
        <input
          className={box}
          type="number"
          value={node.order}
          onChange={(e) => patch(node.id, { order: Number(e.target.value) || 0 })}
        />
      )}

      {field(
        "Requires",
        availability.available
          ? "Every requirement is met in the current preview."
          : "Waiting on: " + (availability.unmet.join(", ") || "nothing"),
        <div className="max-h-40 space-y-1 overflow-auto rounded border border-slate-800 p-2">
          {grantedElsewhere.length ? (
            grantedElsewhere.map((flag) => (
              <label key={flag} className="flex items-center gap-2 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={node.requires.some((requirement) => requirement.flag === flag)}
                  onChange={() =>
                    patch(node.id, {
                      requires: node.requires.some((requirement) => requirement.flag === flag)
                        ? node.requires.filter((requirement) => requirement.flag !== flag)
                        : node.requires.concat({ kind: "flag", flag })
                    })
                  }
                />
                <span className="font-mono">{flag}</span>
              </label>
            ))
          ) : (
            <p className="text-[11px] text-slate-600">No other node grants a flag yet.</p>
          )}
        </div>
      )}

      {field(
        "Grants flags",
        "What completing this sets. Every arrow into another node is derived from these — there are no edges to draw.",
        <input
          className={box + " font-mono"}
          value={node.grantsFlags.join(", ")}
          onChange={(e) =>
            patch(node.id, {
              grantsFlags: e.target.value.split(",").map((flag) => flag.trim()).filter(Boolean)
            })
          }
        />
      )}

      {field(
        "Recruits",
        "Operators who join when this is cleared.",
        <div className="space-y-1 rounded border border-slate-800 p-2">
          {Object.keys(GAMEPLAY_CONTENT.operators).sort().map((operatorId) => (
            <label key={operatorId} className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={node.recruits.includes(operatorId)}
                onChange={() => patch(node.id, { recruits: toggleIn(node.recruits, operatorId) })}
              />
              <span className="font-mono">{operatorId}</span>
            </label>
          ))}
        </div>
      )}

      {field(
        "Contacts",
        "People introduced by this operation.",
        <div className="space-y-1 rounded border border-slate-800 p-2">
          {Object.keys(content.contacts || {}).sort().map((contactId) => (
            <label key={contactId} className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={node.contacts.includes(contactId)}
                onChange={() => patch(node.id, { contacts: toggleIn(node.contacts, contactId) })}
              />
              <span className="font-mono">{contactId}</span>
            </label>
          ))}
        </div>
      )}

      {field(
        "Deployment",
        'Who may be fielded. "' + ROSTER_SELECTORS.join('" / "') +
          '" means whoever is on the roster at the time, which no author can list in advance.',
        <textarea
          rows={7}
          className={box + " font-mono text-[11px]"}
          value={JSON.stringify(node.deployment || null, null, 2)}
          onChange={(e) => {
            try {
              patch(node.id, { deployment: JSON.parse(e.target.value) });
            } catch {
              /* keep the last valid value while mid-edit */
            }
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
 * SERIALIZATION
 *
 * Deterministic: fixed key order, and layout metadata written last so a
 * position change produces a one-line diff rather than a reshuffle.
 * -------------------------------------------------------------*/

const NODE_FIELD_ORDER = [
  "format", "formatVersion", "kind", "id", "missionId", "order", "name", "chapter",
  "summary", "objectiveText", "nodeKind", "requires", "grantsFlags", "encounterId",
  "encounterVariants", "deployment", "outcomeTracking", "recruits", "contacts",
  "orderChoice", "rewardTables", "editor"
];

export function serializeNode(node) {
  const source = {
    format: "statuszero.campaign",
    formatVersion: 1,
    kind: "node",
    ...node,
    // Requirements round-trip in whichever form they were authored: the short
    // string is what thirteen nodes already use and there is no reason to make
    // a file longer for a shape it never asked for.
    requires: node.requires.map((requirement) =>
      requirement.kind === "flag" && Object.keys(requirement).length === 2
        ? requirement.flag
        : requirement
    )
  };
  const out = {};
  for (const key of NODE_FIELD_ORDER) {
    if (source[key] === undefined || source[key] === null) continue;
    if (Array.isArray(source[key]) && !source[key].length) continue;
    out[key] = source[key];
  }
  for (const key of Object.keys(source).sort()) {
    if (out[key] === undefined && source[key] != null) out[key] = source[key];
  }
  return JSON.stringify(out, null, 2) + "\n";
}
