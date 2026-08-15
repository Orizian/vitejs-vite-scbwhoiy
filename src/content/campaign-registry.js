/* =========================================================================
 * CAMPAIGN CONTENT REGISTRY
 *
 * The one path by which authored campaign data reaches the game.
 *
 * Files are discovered rather than listed, so adding a campaign node is
 * dropping a file into `nodes/` — not editing a manifest, and certainly not
 * editing source. That is the property this whole phase exists to buy.
 *
 *   campaign.json        the manifest: identity, starting state, chapters
 *   nodes/<id>.json      one campaign node per file
 *   facilities.json      what the squad can build
 *   contacts.json        who they come to know
 *   speakers.json        everyone a script can give a line to
 *   dialogue/<id>.json   a node's story script
 *
 * Loaded once, normalized once, frozen. Runtime campaign *state* is a
 * different thing entirely and lives in the save.
 * =======================================================================*/

import { normalizeNode, orderedNodes } from "../campaign/progression.js";

const manifestFiles = import.meta.glob("./campaign/campaign.json", { eager: true });
const nodeFiles = import.meta.glob("./campaign/nodes/*.json", { eager: true });
const dialogueFiles = import.meta.glob("./campaign/dialogue/*.json", { eager: true });
const registryFiles = import.meta.glob("./campaign/*.json", { eager: true });

function unwrap(module) {
  return module && module.default ? module.default : module;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function collect() {
  const manifest = unwrap(Object.values(manifestFiles)[0]) || {};
  const errors = [];

  const nodes = {};
  for (const [path, module] of Object.entries(nodeFiles)) {
    const raw = unwrap(module);
    const fallbackId = path.split("/").pop().replace(/\.json$/, "");
    const id = raw.id || fallbackId;
    if (nodes[id]) {
      errors.push('Two campaign nodes claim the id "' + id + '" (' + path + ").");
      continue;
    }
    // The filename is not the id, but a file whose name disagrees with the id
    // inside it is a rename that went half-finished, and the next person to
    // search for it by filename will not find it.
    if (raw.id && raw.id !== fallbackId) {
      errors.push('Campaign node "' + raw.id + '" lives in ' + path + ", which names something else.");
    }
    nodes[id] = normalizeNode(raw, id);
  }

  const dialogue = {};
  for (const [path, module] of Object.entries(dialogueFiles)) {
    const raw = unwrap(module);
    const id = raw.id || path.split("/").pop().replace(/\.json$/, "");
    const { format, formatVersion, kind, id: _id, ...script } = raw;
    dialogue[id] = script;
  }

  const registryOf = (name) => {
    const entry = Object.entries(registryFiles).find(([path]) => path.endsWith("/" + name + ".json"));
    return entry ? unwrap(entry[1]).entries || {} : {};
  };

  const content = {
    id: manifest.id || "campaign",
    name: manifest.name || "Campaign",
    description: manifest.description || "",
    startingChapter: manifest.startingChapter || null,
    startingCurrencies: manifest.startingCurrencies || {},
    startingFlags: manifest.startingFlags || [],
    startingRoster: manifest.startingRoster || [],
    chapters: manifest.chapters || {},
    baseStages: manifest.baseStages || [],
    facilities: registryOf("facilities"),
    contacts: registryOf("contacts"),
    speakers: registryOf("speakers"),
    nodes,
    dialogue,
    errors
  };
  return deepFreeze(content);
}

export const CAMPAIGN_CONTENT = collect();

/* ---------------------------------------------------------------
 * QUERIES
 *
 * Pure lookups over the loaded content. Nothing here mutates, and nothing
 * here reaches for runtime campaign state — a question about what the
 * campaign *is* must be answerable without a save.
 * -------------------------------------------------------------*/

export function campaignNodes() {
  return orderedNodes(CAMPAIGN_CONTENT);
}

export function campaignNode(nodeId) {
  return CAMPAIGN_CONTENT.nodes[nodeId] || null;
}

/** The node that offers a given mission, if any node does. */
export function nodeForMission(missionId) {
  return campaignNodes().find((node) => node.missionId === missionId) || null;
}

export function campaignScript(nodeId) {
  return CAMPAIGN_CONTENT.dialogue[nodeId] || null;
}
