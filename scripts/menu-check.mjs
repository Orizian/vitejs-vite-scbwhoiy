/* Browser acceptance for the front door.
 *
 * The unit suite covers startup routing and the campaign slot as functions.
 * This covers the part that is only true in a real browser: that launching the
 * project lands on a title screen, that every option goes somewhere real, and
 * that you can get into the editor and back out without a reload.
 *
 *   npm run check:menu
 */
import { chromium } from "playwright";

const base = process.env.URL || "http://localhost:5173";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail == null ? "" : "  [" + detail + "]"));
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];

const openApp = async (query) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base + "/" + (query || ""), { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return page;
};

const text = (page) => page.locator("body").innerText();
const onMenu = async (page) => /STATUS\s*ZERO/i.test(await text(page)) && /NEW GAME/i.test(await text(page));
const onBase = async (page) => /MISSION BOARD/i.test(await text(page));

/* ---- a clean first launch ---- */
console.log("first launch");
let page = await openApp();
await page.evaluate(() => {
  localStorage.removeItem("statuszero.campaign.save");
  localStorage.removeItem("statuszero.playtest.mission");
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);

check("1. the application starts on the main menu", await onMenu(page));
check("   it does not drop into the base", !(await onBase(page)));

const continueBtn = page.getByRole("button", { name: /^CONTINUE/i });
check("   Continue is disabled with no save", await continueBtn.isDisabled());
check(
  "   and says so",
  /No saved campaign yet/i.test(await text(page)),
  (await text(page)).match(/No saved campaign yet/i) ? "shown" : "missing"
);

/* ---- editor round trip ---- */
console.log("editor");
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1600);
const editorVisible = (await page.locator("canvas").count()) > 0 && /STATUS ZERO · EDITOR/i.test(await text(page));
check("2. the editor opens from the menu", editorVisible);
check("   with a Back to Main Menu control", await page.getByRole("button", { name: /Main Menu/i }).isVisible());

const urlInEditor = page.url();
await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(800);
check("   leaving returns to the menu", await onMenu(page));
check("   without a page reload", page.url() === urlInEditor, page.url());

/* ---- settings from the menu ---- */
console.log("settings");
await page.getByRole("button", { name: /^SETTINGS/i }).first().click();
await page.waitForTimeout(500);
const settingsText = await text(page);
check("3. settings open from the menu", /UI scale/i.test(settingsText) && /Master volume/i.test(settingsText));
check(
  "   no Return to Main Menu while already there",
  !/Return to main menu/i.test(settingsText),
  "correctly absent"
);
await page.getByRole("button", { name: /Resume/i }).click();
await page.waitForTimeout(400);

/* ---- new game ---- */
console.log("new game");
await page.getByRole("button", { name: /^NEW GAME/i }).click();
await page.waitForTimeout(1400);
check("4. New Game reaches the base", await onBase(page));
const freshState = await page.evaluate(() => ({
  saved: localStorage.getItem("statuszero.campaign.save"),
  note: /campaign not saved yet/i.test(document.body.innerText)
}));
check("   starting a campaign writes no save by itself", freshState.saved === null);
check("   and the base reports it as unsaved", freshState.note);

/* ---- gameplay back to the menu ---- */
console.log("return to title");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("5. Escape opens settings in game", /UI scale/i.test(await text(page)));
check("   Return to Main Menu is offered here", /Return to main menu/i.test(await text(page)));
await page.getByRole("button", { name: /Return to main menu/i }).click();
await page.waitForTimeout(400);
check("   it confirms before leaving", /anything since your last save is discarded/i.test(await text(page)));
await page.getByRole("button", { name: /Return to main menu/i }).click();
await page.waitForTimeout(700);
check("   confirming lands back on the menu", await onMenu(page));

/* ---- continue with a save ---- */
console.log("continue");
// A real campaign built by the game itself, then nudged so it is provably not
// a fresh one. Hand-writing the JSON would only test the shape of my guess.
await page.evaluate(() => {
  const api = window.STATUS_ZERO.campaign;
  const campaign = { ...api.create(), supplies: 7777 };
  api.write(api.serialize(campaign));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
check("6. a launch with a save still starts on the menu", await onMenu(page));
check(
  "   Continue is now enabled",
  await page.getByRole("button", { name: /^CONTINUE/i }).isEnabled()
);
await page.getByRole("button", { name: /^CONTINUE/i }).click();
await page.waitForTimeout(1400);
check("   Continue reaches the base", await onBase(page));
check(
  "   with the saved campaign, not a fresh one",
  /7777/.test(await text(page)),
  (await text(page)).match(/7777/) ? "supplies 7777 restored" : "saved resources missing"
);

/* ---- New Game over an existing save asks first ---- */
console.log("new game over a save");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /Return to main menu/i }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /Return to main menu/i }).click();
await page.waitForTimeout(700);
await page.getByRole("button", { name: /^NEW GAME/i }).click();
await page.waitForTimeout(400);
check("7. New Game over a save asks first", /A saved campaign already exists/i.test(await text(page)));
const savedDuringPrompt = await page.evaluate(() => window.STATUS_ZERO.campaign.read());
check("   and has not touched the save yet", /7777/.test(savedDuringPrompt || ""));
await page.getByRole("button", { name: /Start new campaign/i }).click();
await page.waitForTimeout(1400);
check("   confirming reaches a fresh base", (await onBase(page)) && !/7777/.test(await text(page)));
const afterNew = await page.evaluate(() => window.STATUS_ZERO.campaign.read());
check("   the old save is still on disk until overwritten", /7777/.test(afterNew || ""));

/* ---- the harness escape hatch ---- */
console.log("harness routes");
const direct = await openApp("?boot=game");
check("8. ?boot=game bypasses the menu", await onBase(direct));
const directEditor = await openApp("?boot=editor");
await directEditor.waitForTimeout(1200);
check("   ?boot=editor opens the editor directly", (await directEditor.locator("canvas").count()) > 0);

/* ---- the editor must not be able to touch a campaign ---- */
const slotAfterEditor = await directEditor.evaluate(() => localStorage.getItem("statuszero.campaign.save"));
check("   and using it leaves the campaign slot alone", /7777/.test(slotAfterEditor || ""));

/* ---- standalone editor entry still works ---- */
const standalone = await ctx.newPage();
standalone.on("pageerror", (e) => pageErrors.push(e.message));
await standalone.goto(base + "/editor.html", { waitUntil: "networkidle" });
await standalone.waitForTimeout(1200);
check(
  "9. editor.html still works on its own",
  (await standalone.locator("canvas").count()) > 0 &&
    (await standalone.getByRole("button", { name: /Main Menu/i }).isVisible())
);

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((r) => r.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
