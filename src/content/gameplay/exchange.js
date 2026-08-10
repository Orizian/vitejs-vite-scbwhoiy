/* =========================================================================
 * GAMEPLAY DATA EXCHANGE
 *
 * Getting authored data out of the Studio and back in.
 *
 * The design goal is narrow and specific: someone should be able to press
 * EXPORT CHANGES, hand the bundle to another Claude Code session, and have it
 * update the repository without reconstructing what changed. Everything here
 * serves that.
 *
 *   · bundles mirror repository-relative paths, so a file's destination is
 *     stated rather than inferred
 *   · modified entities are exported as complete replacements, not patches —
 *     a whole entity applies deterministically, a line-number patch does not
 *   · a manifest names every entity, its registry, and the operation
 *   · the same serializer writes these files and the canonical ones, so an
 *     unmodified entity exports byte-identically to what is already on disk
 *
 * Import is the inverse and is deliberately *not* an install: a bundle becomes
 * a draft to inspect, validate and test. Nothing is accepted by loading it.
 * =======================================================================*/

import {
  REGISTRY_IDS,
  REGISTRY_KINDS,
  GAMEPLAY_FORMAT_ID,
  GAMEPLAY_FORMAT_VERSION,
  serializeRegistryFile,
  parseRegistryFile,
  canonicalEntity,
  entitiesEqual
} from "./format.js";

export const BUNDLE_FORMAT_ID = "statuszero.gameplay.bundle";
export const BUNDLE_FORMAT_VERSION = 1;

/* ---------------------------------------------------------------
 * DIFF
 * -------------------------------------------------------------*/

/**
 * What the draft changes, per entity.
 *
 * Compares canonical forms, so re-serializing or reordering keys never counts
 * as a change. An entity is dirty when it *means* something different.
 */
export function diffAgainstCanonical(canonical, draft) {
  const changes = [];
  for (const kindId of REGISTRY_IDS) {
    const before = (canonical && canonical[kindId]) || {};
    const after = (draft && draft[kindId]) || {};
    const ids = new Set(Object.keys(before).concat(Object.keys(after)));
    for (const id of Array.from(ids).sort()) {
      const hadIt = Object.prototype.hasOwnProperty.call(before, id);
      const hasIt = Object.prototype.hasOwnProperty.call(after, id);
      if (hadIt && !hasIt) {
        changes.push({ kind: kindId, id, operation: "delete", before: before[id], after: null });
      } else if (!hadIt && hasIt) {
        changes.push({ kind: kindId, id, operation: "add", before: null, after: after[id] });
      } else if (hadIt && hasIt && !entitiesEqual(kindId, before[id], after[id])) {
        changes.push({ kind: kindId, id, operation: "modify", before: before[id], after: after[id] });
      }
    }
  }
  return changes;
}

export function isDirty(canonical, draft) {
  return diffAgainstCanonical(canonical, draft).length > 0;
}

/** Which entities differ, as a set the Studio can highlight cheaply. */
export function dirtyIds(canonical, draft) {
  const out = {};
  for (const change of diffAgainstCanonical(canonical, draft)) {
    if (!out[change.kind]) out[change.kind] = {};
    out[change.kind][change.id] = change.operation;
  }
  return out;
}

/* ---------------------------------------------------------------
 * FIELD-LEVEL COMPARISON
 * -------------------------------------------------------------*/

/** Leaf-by-leaf differences between two entities, for the compare view. */
export function compareEntities(kindId, before, after) {
  const rows = [];
  const walk = (path, a, b) => {
    const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    if (isObject(a) || isObject(b)) {
      const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
      for (const key of Array.from(keys).sort()) {
        walk(path ? path + "." + key : key, (a || {})[key], (b || {})[key]);
      }
      return;
    }
    const left = JSON.stringify(a === undefined ? null : a);
    const right = JSON.stringify(b === undefined ? null : b);
    if (left !== right) rows.push({ path, before: left, after: right });
  };
  walk("", canonicalEntity(kindId, before || {}), canonicalEntity(kindId, after || {}));
  return rows;
}

/* ---------------------------------------------------------------
 * EXPORT
 * -------------------------------------------------------------*/

function manifestHeader(mode, changes) {
  return {
    format: BUNDLE_FORMAT_ID,
    formatVersion: BUNDLE_FORMAT_VERSION,
    dataFormat: GAMEPLAY_FORMAT_ID,
    dataFormatVersion: GAMEPLAY_FORMAT_VERSION,
    mode,
    // No timestamp: two exports of the same authored state must be identical
    // bytes, and a clock would make that false. The content is the identity.
    entityCount: changes.length,
    registries: REGISTRY_IDS.filter((kindId) => changes.some((change) => change.kind === kindId)).map(
      (kindId) => ({ registry: kindId, path: REGISTRY_KINDS[kindId].path })
    ),
    entities: changes.map((change) => ({
      registry: change.kind,
      id: change.id,
      operation: change.operation,
      path: REGISTRY_KINDS[change.kind].path
    }))
  };
}

const INTEGRATION_INSTRUCTIONS = [
  "Replace or update the canonical authored gameplay data represented by this bundle.",
  "",
  "For each entry in manifest.entities:",
  "  add / modify — write files/<path> over the repository file at <path>. Each",
  "                 included file is the complete canonical registry file, already",
  "                 in the project's deterministic format; a whole-file replacement",
  "                 is intended and safe.",
  "  delete       — the entity has been removed from the included file already.",
  "                 Check referencesTo() before accepting a delete.",
  "",
  "Do not modify engine behaviour unless schema compatibility requires it.",
  "Preserve stable refs: an operator's `ref`, and every registry key, are what",
  "missions, combat links, reactions and saves address. A display name may change",
  "freely; an id may not, except as an explicit migration.",
  "",
  "Afterwards run, and expect green:",
  "  npm test                  full suite plus the architecture audit",
  "  npm run check:gameplay    the Studio's own acceptance run",
  "  npm run build"
].join("\n");

/**
 * A repository-integration bundle.
 *
 * `files` maps repository-relative paths to complete file contents. Full and
 * changes-only differ only in which entities are in scope: both emit whole,
 * valid registry files, because a partial registry file is not a thing the
 * game could load and not a thing anyone should have to merge by hand.
 */
export function buildBundle(canonical, draft, options) {
  const mode = (options && options.mode) === "full" ? "full" : "changes";
  const changes = mode === "full"
    ? REGISTRY_IDS.flatMap((kindId) =>
        Object.keys(draft[kindId] || {})
          .sort()
          .map((id) => ({ kind: kindId, id, operation: "modify", after: draft[kindId][id] }))
      )
    : diffAgainstCanonical(canonical, draft);

  const touched = REGISTRY_IDS.filter((kindId) => changes.some((change) => change.kind === kindId));
  const files = {};
  for (const kindId of touched) {
    files[REGISTRY_KINDS[kindId].path] = serializeRegistryFile(kindId, draft[kindId] || {});
  }

  const manifest = manifestHeader(mode, changes);
  files["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  files["README.md"] = renderHandoff(manifest, changes);

  return { mode, manifest, changes, files };
}

/** The human half of the handoff. */
function renderHandoff(manifest, changes) {
  const lines = [];
  lines.push("# STATUS ZERO — gameplay data export");
  lines.push("");
  lines.push(
    manifest.mode === "full"
      ? "Complete authored gameplay data."
      : "Only the entities that differ from the canonical data this draft was loaded from."
  );
  lines.push("");

  if (!changes.length) {
    lines.push("Nothing was modified.");
    lines.push("");
  } else {
    lines.push("## Changed");
    lines.push("");
    for (const kindId of REGISTRY_IDS) {
      const forKind = changes.filter((change) => change.kind === kindId);
      if (!forKind.length) continue;
      lines.push("**" + REGISTRY_KINDS[kindId].label + "** — `" + REGISTRY_KINDS[kindId].path + "`");
      lines.push("");
      for (const change of forKind) {
        lines.push("- " + change.operation + ": `" + change.id + "`");
      }
      lines.push("");
    }
  }

  lines.push("## Files in this bundle");
  lines.push("");
  for (const entry of manifest.registries) {
    lines.push("- `files/" + entry.path + "` → repository `" + entry.path + "`");
  }
  lines.push("");
  lines.push("## Integration");
  lines.push("");
  lines.push("```");
  lines.push(INTEGRATION_INSTRUCTIONS);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * The bundle as one text document.
 *
 * A ZIP would be tidier for a filesystem, but a single reviewable file is
 * better for the actual workflow — it can be pasted into a session, read
 * without tooling, and diffed. Boundaries are unambiguous so parsing back is
 * exact rather than heuristic.
 */
export function bundleToText(bundle) {
  const parts = [];
  parts.push("=== STATUS ZERO GAMEPLAY BUNDLE v" + BUNDLE_FORMAT_VERSION + " ===");
  for (const path of Object.keys(bundle.files).sort()) {
    parts.push("");
    parts.push("--- file: " + path + " ---");
    parts.push(bundle.files[path].replace(/\n$/, ""));
  }
  parts.push("");
  parts.push("=== END BUNDLE ===");
  return parts.join("\n") + "\n";
}

export function bundleFromText(text) {
  const files = {};
  const lines = String(text).split("\n");
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) {
      // The writer puts exactly one blank line between a file's contents and
      // whatever follows it. Dropping it here is what makes the round trip
      // byte-exact rather than "close enough".
      if (buffer.length && buffer[buffer.length - 1] === "") buffer.pop();
      files[current] = buffer.join("\n") + "\n";
    }
    current = null;
    buffer = [];
  };
  for (const line of lines) {
    const match = line.match(/^--- file: (.+) ---$/);
    if (match) {
      flush();
      current = match[1];
      continue;
    }
    if (line === "=== END BUNDLE ===") {
      flush();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return files;
}

/* ---------------------------------------------------------------
 * IMPORT
 * -------------------------------------------------------------*/

/**
 * Turns a bundle back into a draft, over the canonical data it applies to.
 *
 * Deliberately not an install. The result is something to inspect, validate
 * and test; accepting it is a separate, explicit act. Nothing here can touch a
 * campaign save — this layer has no access to one.
 */
export function draftFromBundle(canonical, files) {
  const draft = {};
  for (const kindId of REGISTRY_IDS) draft[kindId] = { ...canonical[kindId] };

  const applied = [];
  const problems = [];
  for (const path of Object.keys(files)) {
    if (path === "manifest.json" || path === "README.md") continue;
    const kindId = REGISTRY_IDS.find((id) => REGISTRY_KINDS[id].path === path || path.endsWith(REGISTRY_KINDS[id].path));
    if (!kindId) {
      problems.push('Ignored "' + path + '": not a known gameplay registry path.');
      continue;
    }
    try {
      const parsed = parseRegistryFile(files[path]);
      draft[kindId] = { ...parsed.entries };
      applied.push({ registry: kindId, path, entries: Object.keys(parsed.entries).length });
    } catch (error) {
      problems.push('Could not read "' + path + '": ' + error.message);
    }
  }
  return { draft, applied, problems };
}

/** Reads the manifest out of a bundle's files, if it carries one. */
export function manifestFromFiles(files) {
  if (!files || !files["manifest.json"]) return null;
  try {
    return JSON.parse(files["manifest.json"]);
  } catch {
    return null;
  }
}
