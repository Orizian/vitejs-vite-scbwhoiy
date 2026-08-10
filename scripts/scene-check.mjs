/* Browser acceptance for the scene editor.
 *
 * The unit suite covers the format, the fold and the round trip as functions.
 * This covers the claim the phase is actually about: that a person can open
 * the editor, build a linear cutscene without touching source, watch it in the
 * real game player, and get a file out.
 *
 *   npm run check:scene
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
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(e.message));

const text = () => page.locator("body").innerText();
const rows = () => page.locator("ol li");

await page.goto(base + "/", { waitUntil: "networkidle" });
await page.evaluate(() => {
  localStorage.removeItem("statuszero.scene.draft");
  localStorage.removeItem("statuszero.scene.library");
  localStorage.removeItem("statuszero.playtest.mission");
});

/* ---- reaching the scene editor from the menu ---- */
console.log("navigation");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.getByRole("button", { name: /^EDITOR\b/i }).click();
await page.waitForTimeout(1500);
check("1. the editor opens from the main menu", /STATUS ZERO · EDITOR/i.test(await text()));
check("   with Missions and Scenes modes", /MISSIONS/.test(await text()) && /SCENES/.test(await text()));

await page.getByRole("button", { name: /^Scenes$/ }).first().click();
await page.waitForTimeout(700);
check("2. the scene editor opens", /SCENE LIBRARY/i.test(await text()));
check("   the shipped scene is in the library", /act1-warner-arrival/.test(await text()));

/* ---- authoring a scene from nothing ---- */
console.log("authoring");
await page.getByRole("button", { name: /^New$/ }).click();
await page.waitForTimeout(400);
check("3. a new scene starts empty", (await rows().count()) === 0);

const idField = page.locator('input[placeholder="scene-id"]');
await idField.fill("check-hale-office");
await page.locator('input[placeholder="Scene name"]').fill("Hale's Office");

// Background, then two lines, using only the editor.
await page.getByRole("button", { name: /^Background$/ }).click();
await page.waitForTimeout(300);
await page.locator('input[placeholder="warner-road"]').fill("hale-office");
await page.waitForTimeout(300);

await page.getByRole("button", { name: /^Dialogue$/ }).click();
await page.waitForTimeout(300);
const textarea = page.locator("textarea").first();
await textarea.fill("The office was empty when we got there.");
check("4. a background and a line can be added by clicking", (await rows().count()) === 2);

// The fast path: Ctrl+Enter adds the next line and focuses it.
await textarea.press("Control+Enter");
await page.waitForTimeout(400);
check("   Ctrl+Enter adds the next line", (await rows().count()) === 3);
await page.locator("textarea").first().fill("Empty, or emptied?");
await page.waitForTimeout(300);

const inherited = await page.evaluate(() => {
  const draft = JSON.parse(localStorage.getItem("statuszero.scene.draft"));
  const dialogue = draft.steps.filter((step) => step.type === "dialogue");
  return { count: dialogue.length, speakers: dialogue.map((step) => step.speaker) };
});
check(
  "   and inherits the previous speaker explicitly",
  inherited.count === 2 && inherited.speakers[0] === inherited.speakers[1],
  JSON.stringify(inherited.speakers)
);

// A reaction between the lines, and an ending.
await page.getByRole("button", { name: /^Expression$/ }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /^End scene$/ }).click();
await page.waitForTimeout(300);
check("5. a reaction and an ending can be added", (await rows().count()) === 5);

/* ---- reordering ---- */
console.log("reordering");
// Compare content, not types: swapping two dialogue steps leaves the type
// sequence identical, which would make a broken move look like a working one.
const typesNow = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem("statuszero.scene.draft"))
    .steps.map((step) => step.type + ":" + (step.text || step.background || step.character || ""))
    .join(" | ")
);
const before = await typesNow();
await rows().nth(1).getByTitle("Move down").click();
await page.waitForTimeout(400);
const after = await typesNow();
check("6. a step can be moved", before !== after, before + "  ->  " + after);
await rows().nth(2).getByTitle("Move up").click();
await page.waitForTimeout(400);
check("   and moved back", (await typesNow()) === before);

await rows().nth(0).getByTitle("Duplicate").click();
await page.waitForTimeout(400);
check("   and duplicated", (await rows().count()) === 6);
await rows().nth(1).getByTitle("Delete").click();
await page.waitForTimeout(400);
check("   and deleted", (await rows().count()) === 5);

/* ---- validation ---- */
console.log("validation");
const validState = await text();
check("7. a complete scene validates", /VALID/i.test(validState), (validState.match(/VALID[^\n]*/i) || [])[0]);

// Break it on purpose and confirm the message names the step.
await rows().nth(2).click();
await page.waitForTimeout(300);
await page.locator("textarea").first().fill("");
await page.waitForTimeout(500);
const broken = await text();
check(
  "   an empty line is reported against its step number",
  /Step \d+ — Dialogue has no dialogue text/.test(broken),
  (broken.match(/Step \d+ — Dialogue[^\n]*/) || [])[0]
);
const exportDisabled = await page.getByRole("button", { name: /^Export…$/ }).isDisabled();
check("   and export is blocked while it is broken", exportDisabled);
await page.locator("textarea").first().fill("Empty, or emptied?");
await page.waitForTimeout(500);
check("   fixing it clears the error", /VALID/i.test(await text()));

/* ---- preview in the real player ---- */
console.log("preview");
await page.getByRole("button", { name: /▶ Preview/ }).click();
await page.waitForTimeout(1200);
const previewText = await text();
check("8. preview runs in the game's own player", /BACK TO EDITOR/i.test(previewText));
check(
  "   showing the authored line",
  /The office was empty when we got there/.test(previewText),
  "first line on screen"
);
await page.keyboard.press("Space");
await page.waitForTimeout(500);
check("   Space advances to the next line", /Empty, or emptied\?/.test(await text()));
await page.getByRole("button", { name: /Back to editor/i }).click();
await page.waitForTimeout(700);
check("   and the editor comes back with the scene intact", (await rows().count()) === 5);

/* ---- play from a chosen step ---- */
await rows().nth(4).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /From step 5/ }).click();
await page.waitForTimeout(1000);
check(
  "9. Play from here starts at the selected step",
  /Step 5 of 5/.test(await text()),
  (await text()).match(/Step \d+ of \d+/)?.[0]
);
const stageRebuilt = await text();
check("   with the stage reconstructed, not replayed", /HALE-OFFICE|hale-office/i.test(stageRebuilt));
await page.getByRole("button", { name: /Back to editor/i }).click();
await page.waitForTimeout(700);

/* ---- library and round trip ---- */
console.log("library and round trip");
await page.getByRole("button", { name: /Save to library/ }).click();
await page.waitForTimeout(500);
check("10. a scene can be saved to the library", /check-hale-office/.test(await text()));

const roundTrip = await page.evaluate(async () => {
  const format = await import("/src/scene/format.js");
  const draft = JSON.parse(localStorage.getItem("statuszero.scene.draft"));
  const text = format.serializeScene(draft);
  const reloaded = format.parseScene(text);
  const strip = (scene) =>
    JSON.stringify(scene.steps.map((step) => ({ ...step, key: undefined })));
  return {
    identical: strip(reloaded) === strip(format.normalizeScene(draft)),
    stable: format.serializeScene(reloaded) === text,
    hasEditorState: text.includes('"key"')
  };
});
check("    export and re-import preserve the scene", roundTrip.identical);
check("    serialization is stable across a round trip", roundTrip.stable);
check("    and carries no editor state", roundTrip.hasEditorState === false);

/* ---- back to the menu, unharmed ---- */
await page.getByRole("button", { name: /Main Menu/i }).click();
await page.waitForTimeout(700);
check("11. the editor still returns to the main menu", /NEW GAME/i.test(await text()));

check("no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

const passed = results.filter((r) => r.ok).length;
console.log("\n" + passed + "/" + results.length + " browser checks passed");
await browser.close();
process.exit(passed === results.length ? 0 : 1);
