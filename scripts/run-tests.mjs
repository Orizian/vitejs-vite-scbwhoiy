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
import { setTimeout as sleep } from "node:timers/promises";

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

  console.log("tests      " + result.passed + "/" + result.total + " passed");
  console.log("audit      " + (result.auditPass ? "PASS" : "FAIL"));
  console.log("content    " + (result.contentErrors.length ? result.contentErrors.length + " errors" : "clean"));
  console.log("missions   " + (result.missionIds.join(", ") || "none"));
  for (const warning of result.missionWarnings) console.log("  warn  " + warning);
  for (const failure of result.failures) console.log("  FAIL  " + failure);
  for (const failure of result.auditFailures) console.log("  AUDIT " + failure);
  for (const error of result.missionErrors) console.log("  MISSION " + error);
  for (const error of pageErrors) console.log("  PAGEERROR " + error);

  if (result.failed || !result.auditPass || result.contentErrors.length || result.missionErrors.length) exitCode = 1;
} catch (error) {
  console.error("runner failed:", error.message);
  exitCode = 1;
} finally {
  await browser.close();
  if (server) process.kill(-server.pid < 0 ? server.pid : server.pid, "SIGTERM");
}

process.exit(exitCode);
