/* Headless runner for the in-app test suite.
 *
 * App.jsx registers ~315 tests that are renderer-independent, but until now
 * the only way to see them was the in-game developer panel. This boots the
 * dev server's page in headless Chromium and calls window.STATUS_ZERO.runTests().
 *
 *   npm test              run against a dev server you already have on :5173
 *   npm test -- --serve   start and stop vite automatically
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* ---------------------------------------------------------------
 * CHARACTER-NAME TRIPWIRE
 *
 * Generic combat machinery must not know who its first users are. Content is
 * where "kell" belongs; an engine module that names him has grown a special
 * case, and the next operator will need a second one.
 *
 * Scans the directories that are supposed to be generic. `src/content/` is
 * deliberately not among them — that is where these names are meant to live —
 * and neither is App.jsx, which still holds the campaign tables. Its engine
 * half is covered by `auditArchitecture()` in the browser.
 *
 * Comments are stripped before scanning. The rule is about behaviour, and a
 * comment cannot have any: "this is the shape Nyx's cloak will need" is design
 * rationale worth keeping, while `if (id === "nyx")` is the thing to catch.
 *
 * What counts is a *whole string literal* equal to a forbidden name, because
 * that is the shape every hard-coded content check takes: `=== "nyx"`,
 * `["burst"]`, `statuses["conductive"]`. Matching the bare word anywhere would
 * be stricter in theory and useless in practice — "cascade stopped" in a
 * diagnostic message is English, not a special case, and a tripwire that cries
 * about prose is one people learn to skip.
 * -------------------------------------------------------------*/
const GENERIC_DIRS = ["src/combat", "src/reactions", "src/mission", "src/perception", "src/scene"];

/* Operator names, and the ids that belong to one operator's kit.
 *
 * The second group is the newer half of the rule. `burst` and `machStrike` are
 * not people, but an engine that mentions either has grown the same special
 * case a name would: the next operator with a stored-power resource will need
 * a second one. Content is where these live. The interdictor's canonical name
 * is deliberately not here — engine code must not learn it either, and the way
 * to guarantee that is for the engine never to see a name at all. */
const FORBIDDEN_NAMES = [
  "vale",
  "kell",
  "nyx",
  "aegis",
  "burst",
  "machStrike",
  "mach-strike",
  "vectorRoute",
  "impactChain",
  "spoolDrive",
  "interdictor",
  "interdictorFrame",
  "commandPoints",
  "capacitor",
  "chainDischarge",
  "surgeDischarge",
  "arcLance",
  "groundingCycle",
  "ioniseTarget",
  "cascade",
  "cascadeFrame",
  "conductive",
  "pressureMine",
  "remoteCharge",
  "placeMine",
  "placeCharge",
  "detonate",
  "defuse",
  "ordnance",
  "sapper",
  "sapperFrame",
  "duelist",
  "duelistFrame",
  "loyalistDuelist",
  "challenge",
  "challenged",
  "onGuard",
  "riposte",
  "guardBreak",
  "poise",
  "duelIntercept",
  "duelHoldTheLine",
  "duelTakeTheHit",
  "duelPunish",
  "battlePlan",
  "assaultMech",
  "commandSequence",
  "reyes",
  "supportMech",
  "supportCharge",
  "powerTransfer",
  "coolantTransfer",
  "tacticalRelay",
  "systemRepair",
  "fieldRepair",
  "arcWelder",
  "emergencyPatch",
  "fieldReady",
  "thrustersImpaired",
  "sensorsImpaired"
];

function sourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(js|jsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Replaces comment bodies with blanks, keeping line numbers intact. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/./g, " "));
}

/** Every complete string literal on a line, without its quotes. */
function stringLiterals(line) {
  const found = [];
  const pattern = /"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`/g;
  let match = pattern.exec(line);
  while (match) {
    found.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
    match = pattern.exec(line);
  }
  return found;
}

function characterNameLeaks() {
  const leaks = [];
  const forbidden = new Set(FORBIDDEN_NAMES.map((name) => name.toLowerCase()));
  for (const dir of GENERIC_DIRS) {
    for (const path of sourceFiles(dir)) {
      const lines = stripComments(readFileSync(path, "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const literal of stringLiterals(line)) {
          if (!forbidden.has(literal.trim().toLowerCase())) continue;
          leaks.push(
            path + ":" + (index + 1) + ' names "' + literal + '": ' + line.trim().slice(0, 90)
          );
        }
      });
    }
  }
  return leaks;
}

const shouldServe = process.argv.includes("--serve");
const port = Number(process.env.PORT || 5173);
const url = process.env.URL || "http://localhost:" + port + "/";

let server = null;
if (shouldServe) {
  server = spawn("npx", ["vite", "--port", String(port)], { stdio: "ignore", detached: false });
  await sleep(6000);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium"
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

let exitCode = 0;
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.STATUS_ZERO, { timeout: 90000 });

  const result = await page.evaluate(() => {
    const tests = window.STATUS_ZERO.runTests();
    const audit = window.STATUS_ZERO.auditArchitecture();
    const content = window.STATUS_ZERO.validateContent();
    const missions = window.STATUS_ZERO.missionContent;
    return {
      total: tests.total,
      passed: tests.passed,
      failed: tests.failed,
      failures: tests.results.filter((entry) => !entry.ok).map((entry) => entry.group + " / " + entry.name + ": " + entry.error),
      auditPass: audit.pass,
      auditFailures: audit.failures,
      contentErrors: content.errors || [],
      missionErrors: missions.errors,
      missionWarnings: missions.warnings,
      missionIds: Object.keys(missions.missions)
    };
  });

  const leaks = characterNameLeaks();

  console.log("tests      " + result.passed + "/" + result.total + " passed");
  console.log("tripwire   " + (leaks.length ? leaks.length + " character names in generic code" : "clean"));
  console.log("audit      " + (result.auditPass ? "PASS" : "FAIL"));
  console.log("content    " + (result.contentErrors.length ? result.contentErrors.length + " errors" : "clean"));
  console.log("missions   " + (result.missionIds.join(", ") || "none"));
  for (const warning of result.missionWarnings) console.log("  warn  " + warning);
  for (const failure of result.failures) console.log("  FAIL  " + failure);
  for (const failure of result.auditFailures) console.log("  AUDIT " + failure);
  for (const error of result.missionErrors) console.log("  MISSION " + error);
  for (const error of pageErrors) console.log("  PAGEERROR " + error);
  for (const leak of leaks) console.log("  NAME  " + leak);

  if (
    result.failed ||
    !result.auditPass ||
    result.contentErrors.length ||
    result.missionErrors.length ||
    leaks.length
  ) {
    exitCode = 1;
  }
} catch (error) {
  console.error("runner failed:", error.message);
  exitCode = 1;
} finally {
  await browser.close();
  if (server) process.kill(-server.pid < 0 ? server.pid : server.pid, "SIGTERM");
}

process.exit(exitCode);
