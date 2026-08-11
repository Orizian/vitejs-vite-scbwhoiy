/* Rewrites the authored gameplay registries through the one canonical
 * serializer.
 *
 * Hand-edited JSON is not canonical by construction — key order and entity
 * order are whatever the editor happened to type. The Studio's export goes
 * through `serializeRegistryFile`, and a file on disk that disagrees with what
 * an export would produce breaks dirty-tracking, so this puts hand edits back
 * in step. Safe to run at any time: it is a no-op when nothing is off.
 *
 *   node scripts/canonicalize-gameplay.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  REGISTRY_KINDS,
  parseRegistryFile,
  serializeRegistryFile
} from "../src/content/gameplay/format.js";

let changed = 0;
for (const kindId of Object.keys(REGISTRY_KINDS)) {
  const path = REGISTRY_KINDS[kindId].path;
  const before = readFileSync(path, "utf8");
  const after = serializeRegistryFile(kindId, parseRegistryFile(before).entries);
  if (before === after) continue;
  writeFileSync(path, after);
  console.log("canonicalised " + path);
  changed += 1;
}
console.log(changed ? changed + " file(s) rewritten" : "already canonical");
