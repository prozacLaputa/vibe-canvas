import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const playwrightRoot = process.env.VIBE_CANVAS_NODE_MODULES;
const { chromium } = playwrightRoot
  ? require(path.join(playwrightRoot, "playwright"))
  : require("playwright");

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const uiPath = path.join(projectRoot, "ui", "vibe-canvas.html");
const screenshotPath = process.env.VIBE_CANVAS_SCREENSHOT || "/tmp/vibe-canvas-demo.png";
const sessionId = "11111111-1111-4111-8111-111111111111";
const rootId = `root:${sessionId}`;
const sampleState = {
  id: sessionId,
  title: "如何让思考自然沉淀",
  revision: 5,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:05:00.000Z",
  blocks: [],
  turns: [
    {
      id: "turn-1",
      userText: "我只想在左边正常和 Codex 对话。\n右边不要再让我输入一次。",
      aiPick: "picked",
      manualPick: null,
      picked: true,
      selectionSource: "ai",
      assistantTakeaway: "把 Codex 对话设为唯一输入源。",
      createdAt: "2026-08-17T00:01:00.000Z",
    },
    {
      id: "turn-2",
      userText: "右边自动显示原始信息、结构化理解和思维导图。",
      aiPick: "candidate",
      manualPick: null,
      picked: false,
      selectionSource: "ai",
      assistantTakeaway: "右侧页面改为只读实时投影。",
      createdAt: "2026-08-17T00:03:00.000Z",
    },
    {
      id: "turn-3",
      userText: "每轮聊完自动更新，不要发送、保存或者整理按钮。",
      aiPick: "ignored",
      manualPick: true,
      picked: true,
      selectionSource: "manual",
      assistantTakeaway: "同一轮结束前增量同步画板状态。",
      createdAt: "2026-08-17T00:05:00.000Z",
    },
  ],
  candidates: [{ turnId: "turn-2", takeaway: "右侧页面改为只读实时投影。" }],
  summary: "以 Codex 对话为唯一输入，每轮结束后自动更新画板，不增加二次操作。",
  structuredBlockCount: 2,
  themes: [
    {
      id: "t1",
      title: "左侧 Codex",
      points: [
        { id: "p1", text: "唯一输入入口" },
        { id: "p2", text: "保持正常对话" },
      ],
    },
    {
      id: "t3",
      title: "同轮同步",
      points: [
        { id: "p5", text: "每轮自动更新" },
        { id: "p6", text: "没有操作按钮" },
      ],
    },
  ],
  graph: {
    nodes: [
      { id: rootId, kind: "root", label: "对话即画板", parentId: null },
      { id: "theme:t1", kind: "theme", label: "左侧 Codex", parentId: rootId },
      { id: "point:p1", kind: "point", label: "唯一输入入口", parentId: "theme:t1" },
      { id: "point:p2", kind: "point", label: "保持正常对话", parentId: "theme:t1" },
      { id: "theme:t3", kind: "theme", label: "同轮同步", parentId: rootId },
      { id: "point:p5", kind: "point", label: "每轮自动更新", parentId: "theme:t3" },
      { id: "point:p6", kind: "point", label: "没有操作按钮", parentId: "theme:t3" },
    ],
  },
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VIBE_CANVAS_BROWSER_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((toolOutput) => {
    window.openai = {
      toolOutput,
      requestDisplayMode: async () => ({ mode: "fullscreen" }),
    };
  }, sampleState);
  await page.goto(pathToFileURL(uiPath).href);
  await page.waitForSelector('.graph-node.point');
  assert.equal(await page.locator('[data-region="input"]').count(), 0);
  assert.equal(await page.locator('[data-region="source"]').count(), 1);
  assert.equal(await page.locator('[data-region="structured"]').count(), 1);
  assert.equal(await page.locator('[data-region="graph"]').count(), 1);
  assert.equal(await page.locator('.turn').count(), 3);
  assert.equal(await page.locator('.pick-toggle input').count(), 3);
  assert.deepEqual(
    await page.locator('.pick-toggle input').evaluateAll((inputs) => inputs.map((input) => input.checked)),
    [true, false, true],
  );
  assert.deepEqual(await page.locator('.selection-badge').allInnerTexts(), ["AI 已选", "候选缓冲", "人工已选"]);
  assert.match(await page.locator('.candidate-buffer-note').innerText(), /1 条候选/);
  assert.equal(
    await page.locator('.user-text').first().innerText(),
    "我只想在左边正常和 Codex 对话。\n右边不要再让我输入一次。",
  );
  assert.doesNotMatch(await page.locator('[data-region="source"]').innerText(), /Codex 提炼/);
  assert.equal(await page.locator('.graph-node.theme').count(), 2);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await page.screenshot({ path: screenshotPath, fullPage: true });
  process.stdout.write(`${screenshotPath}\n`);
} finally {
  await browser.close();
}
