import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const serverPath = path.join(projectRoot, "src", "mcp-server.js");

class McpClient {
  constructor(dataDir) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.process = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: { ...process.env, VIBE_CANVAS_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.process.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server exited with code ${code}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    this.process.kill();
    await exited;
  }
}

test("opens a new Vibe Canvas through the public MCP interface", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  const initialized = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vibe-canvas-test", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "vibe-canvas");

  const listed = await client.request("tools/list");
  const openTool = listed.tools.find((tool) => tool.name === "vibe_canvas_open");
  assert.ok(openTool, "open tool should be discoverable");
  assert.equal(openTool._meta?.ui?.resourceUri, undefined, "open should not render an inline app");
  assert.equal(openTool._meta?.["openai/outputTemplate"], undefined);

  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "今天的思考", workspaceRoot: dataDir },
  });
  assert.equal(opened.structuredContent.title, "今天的思考");
  assert.equal(opened.structuredContent.blocks.length, 0);
  assert.match(opened.structuredContent.id, /^[0-9a-f-]{36}$/);
});

test("publishes canonical theme identity guidance in the sync contract", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const listed = await client.request("tools/list");
  const syncTool = listed.tools.find((tool) => tool.name === "vibe_canvas_sync_turn");
  const themesSchema = syncTool.inputSchema.properties.themes;

  assert.equal(themesSchema.items.properties.id.type, "string");
  assert.match(themesSchema.description, /reuse.*id.*semantically matching/i);
  assert.match(themesSchema.description, /at most one new top-level theme/i);
});

test("opens a local browser view for the canvas session", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "右栏画板", workspaceRoot: dataDir },
  });
  const browserUrl = opened.structuredContent.browserUrl;

  assert.match(browserUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?session=[0-9a-f-]{36}$/);
  const response = await fetch(browserUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Vibe Canvas/);
});

test("syncs one Codex turn and exposes the updated projection to the browser", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "自动同步", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  const synced = await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "第一行是我的原文。\n第二行也必须逐字保留。",
      assistantTakeaway: "将画板改成 Codex 对话的只读实时投影。",
      summary: "Vibe Canvas 是当前 Codex 对话的实时投影层。",
      themes: [
        { title: "左侧对话", points: ["唯一输入入口", "保持正常问答"] },
        { title: "右侧画板", points: ["自动同步", "只读展示"] },
      ],
    },
  });

  assert.equal(synced.structuredContent.sessionId, sessionId);
  assert.equal(synced.structuredContent.revision, 1);
  const browserState = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.equal(browserState.summary, "Vibe Canvas 是当前 Codex 对话的实时投影层。");
  assert.equal(browserState.turns[0].userText, "第一行是我的原文。\n第二行也必须逐字保留。");
  assert.equal(browserState.turns[0].picked, true);
  assert.equal(browserState.turns[0].assistantTakeaway, "将画板改成 Codex 对话的只读实时投影。");
  assert.equal(browserState.themes.length, 2);
});

test("keeps an uncertain AI selection in the candidate buffer without projecting it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "候选缓冲", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "这个想法可能有用，但现在还不能确认。",
      assistantTakeaway: "保留为等待后续语境判断的候选。",
      summary: "暂不进入画板。",
      themes: [{ title: "待确认方向", points: ["等待后续证据"] }],
      aiPick: "candidate",
    },
  });

  const state = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.equal(state.turns[0].aiPick, "candidate");
  assert.equal(state.turns[0].picked, false);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].turnId, state.turns[0].id);
  assert.deepEqual(state.themes, []);
});

test("lets AI promote a buffered candidate after later context arrives", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "延迟补选", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "也许应该加入自动归档。",
      assistantTakeaway: "自动归档可能成为后续能力。",
      summary: "自动归档仍待确认。",
      themes: [{ title: "生命周期", points: ["自动归档"] }],
      aiPick: "candidate",
    },
  });
  const before = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  const candidateId = before.turns[0].id;

  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "对，结束思考时就应该自动归档。",
      assistantTakeaway: "新语境确认自动归档值得进入画板。",
      summary: "确认自动归档。",
      themes: [],
      aiPick: "ignored",
      candidateUpdates: [{ turnId: candidateId, aiPick: "picked" }],
    },
  });

  const after = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.equal(after.turns[0].picked, true);
  assert.equal(after.turns[0].aiPick, "picked");
  assert.deepEqual(after.candidates, []);
  assert.deepEqual(after.themes.map((theme) => theme.title), ["生命周期"]);
});

test("keeps a manual Pick authoritative over later AI decisions", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "人工兜底", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "这条虽然 AI 拿不准，但我明确要保留。",
      assistantTakeaway: "用户可以覆盖 AI 选择。",
      summary: "人工选择优先。",
      themes: [{ title: "选择权", points: ["人工高于 AI"] }],
      aiPick: "candidate",
    },
  });
  const before = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  const candidateId = before.turns[0].id;

  const manuallyPicked = await fetch(
    new URL(`/api/sessions/${sessionId}/turns/${candidateId}`, opened.structuredContent.browserUrl),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ picked: true }),
    },
  ).then((response) => response.json());
  assert.equal(manuallyPicked.turns[0].manualPick, true);
  assert.equal(manuallyPicked.turns[0].selectionSource, "manual");
  assert.equal(manuallyPicked.turns[0].picked, true);

  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "AI 后来认为它可以略过。",
      assistantTakeaway: "AI 判断不能覆盖人工选择。",
      summary: "验证人工覆盖。",
      themes: [],
      aiPick: "ignored",
      candidateUpdates: [{ turnId: candidateId, aiPick: "ignored" }],
    },
  });
  const after = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.equal(after.turns[0].aiPick, "ignored");
  assert.equal(after.turns[0].manualPick, true);
  assert.equal(after.turns[0].picked, true);
  assert.deepEqual(after.themes.map((theme) => theme.title), ["选择权"]);
});

test("lets the browser unpick a source turn and immediately removes its structure", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "自由 Pick", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  for (const turn of [
    {
      userText: "这条暂时不进入画板。",
      assistantTakeaway: "旧结论",
      summary: "旧结论",
      themes: [{ title: "旧主题", points: ["应该可以被排除"] }],
    },
    {
      userText: "这条继续保留。",
      assistantTakeaway: "新结论",
      summary: "新结论",
      themes: [{ title: "新主题", points: ["仍在画板中"] }],
    },
  ]) {
    await client.request("tools/call", {
      name: "vibe_canvas_sync_turn",
      arguments: { sessionId, ...turn },
    });
  }
  const before = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  const firstTurnId = before.turns[0].id;

  const response = await fetch(
    new URL(`/api/sessions/${sessionId}/turns/${firstTurnId}`, opened.structuredContent.browserUrl),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ picked: false }),
    },
  );
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.equal(after.turns[0].picked, false);
  assert.equal(after.turns[1].picked, true);
  assert.deepEqual(after.themes.map((theme) => theme.title), ["新主题"]);
  assert.doesNotMatch(after.graph.nodes.map((node) => node.label).join(" "), /旧主题|应该可以被排除/);
  assert.match(after.graph.nodes.map((node) => node.label).join(" "), /新主题|仍在画板中/);
});

test("returns compact projection context without replaying the raw conversation", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "低 Token 同步", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "不要每轮重读完整对话。",
      assistantTakeaway: "只读取上一版结构，再增量更新。",
      summary: "画板采用轻量增量同步。",
      themes: [{ title: "Token 控制", points: ["不重放原文"] }],
    },
  });

  const context = await client.request("tools/call", {
    name: "vibe_canvas_get_projection",
    arguments: { sessionId },
  });
  const themeId = context.structuredContent.themes[0].id;
  assert.match(themeId, /^theme-[0-9a-f]{12}$/);
  assert.deepEqual(context.structuredContent, {
    sessionId,
    title: "低 Token 同步",
    revision: 1,
    turnCount: 1,
    summary: "画板采用轻量增量同步。",
    candidates: [],
    themes: [{ id: themeId, title: "Token 控制", points: ["不重放原文"] }],
      conceptGraph: {
        domains: [],
        relations: [],
        topicIndex: [],
        claimIndex: [],
        omittedClaimIndexCount: 0,
        visibleNodeCount: 0,
        hiddenNodeCount: 0,
      },
  });
});

test("persists a typed concept graph and projects it through the existing UI shape", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const listed = await client.request("tools/list");
  const syncTool = listed.tools.find((tool) => tool.name === "vibe_canvas_sync_turn");
  assert.equal(syncTool.inputSchema.properties.conceptOperations.type, "array");

  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "类型化概念图", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "晋升路径收紧会进一步降低职业安全感。",
      assistantTakeaway: "行业变化与职业安全感之间存在因果关系。",
      summary: "识别跨主题因果关系。",
      themes: [],
      conceptOperations: [
        { op: "upsert_domain", id: "domain-work", title: "职业" },
        {
          op: "upsert_topic",
          id: "topic-industry-path",
          domainId: "domain-work",
          title: "行业路径变化",
          question: "互联网职业路径发生了什么变化？",
        },
        {
          op: "upsert_topic",
          id: "topic-career-safety",
          domainId: "domain-work",
          title: "职业安全感",
          question: "怎样获得稳定且可控的职业感受？",
        },
        {
          op: "upsert_claim",
          id: "claim-promotion-path",
          primaryTopicId: "topic-industry-path",
          relatedTopicIds: ["topic-career-safety"],
          text: "晋升路径收紧会进一步降低职业安全感。",
          type: "cause",
          sourceQuote: "晋升路径收紧会进一步降低职业安全感",
        },
        {
          op: "link",
          fromId: "topic-industry-path",
          toId: "topic-career-safety",
          type: "causes",
        },
      ],
    },
  });

  const projection = await client.request("tools/call", {
    name: "vibe_canvas_get_projection",
    arguments: { sessionId },
  });
  assert.deepEqual(
    projection.structuredContent.conceptGraph.topicIndex.map((topic) => topic.title),
    ["行业路径变化", "职业安全感"],
  );
  assert.equal(projection.structuredContent.conceptGraph.relations[0].type, "causes");
  assert.equal(
    projection.structuredContent.conceptGraph.claimIndex[0].evidenceQuotes,
    undefined,
  );
  assert.ok(projection.structuredContent.conceptGraph.visibleNodeCount <= 25);

  const browserState = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.deepEqual(browserState.themes.map((theme) => theme.title), ["行业路径变化", "职业安全感"]);
  assert.equal(browserState.themes[0].points[0].text, "晋升路径收紧会进一步降低职业安全感。");
  assert.deepEqual(browserState.graph.nodes.find((node) => node.kind === "point").evidenceQuotes, [
    {
      turnId: browserState.turns[0].id,
      text: "晋升路径收紧会进一步降低职业安全感",
    },
  ]);
});

test("keeps a long repeated conversation canonical, current, and bounded", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const listed = await client.request("tools/list");
  const syncTool = listed.tools.find((tool) => tool.name === "vibe_canvas_sync_turn");
  assert.equal(syncTool.inputSchema.properties.overview.type, "string");

  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "长对话聚合", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;

  for (let index = 1; index <= 12; index += 1) {
    await client.request("tools/call", {
      name: "vibe_canvas_sync_turn",
      arguments: {
        sessionId,
        userText: `第 ${index} 次谈到职业安全感。`,
        assistantTakeaway: "同一问题正在获得更多证据。",
        summary: `第 ${index} 轮补充了一段很长但不应被无限拼接的当前轮摘要。`,
        overview: `职业安全感是核心问题，已由 ${index} 轮对话共同支持。`,
        themes: [],
        conceptOperations: [
          { op: "upsert_domain", id: `domain-work-${index}`, title: "职业" },
          {
            op: "upsert_topic",
            id: `topic-career-${index}`,
            domainId: `domain-work-${index}`,
            title: index === 1 ? "职业安全感" : "职业未来的不安全感",
            question: "怎样获得稳定且可控的职业感受？",
          },
          {
            op: "upsert_claim",
            id: `claim-anchor-${index}`,
            primaryTopicId: `topic-career-${index}`,
            text: "主业支点偏薄，未来方向不够稳定。",
            type: "judgment",
          },
        ],
      },
    });
  }

  const projection = await client.request("tools/call", {
    name: "vibe_canvas_get_projection",
    arguments: { sessionId },
  });
  const graph = projection.structuredContent.conceptGraph;
  assert.equal(projection.structuredContent.summary, "职业安全感是核心问题，已由 12 轮对话共同支持。");
  assert.equal(graph.topicIndex.length, 1);
  assert.equal(graph.claimIndex.length, 1);
  assert.equal(graph.claimIndex[0].evidenceCount, 12);
  assert.equal(graph.claimIndex[0].recentEvidenceTurnIds.length, 3);
  assert.ok(graph.visibleNodeCount <= 25);
});

test("bounds the fallback summary when no cumulative overview is supplied", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "摘要边界", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  for (let index = 1; index <= 10; index += 1) {
    await client.request("tools/call", {
      name: "vibe_canvas_sync_turn",
      arguments: {
        sessionId,
        userText: `原文 ${index}`,
        assistantTakeaway: `要点 ${index}`,
        summary: `第 ${index} 轮摘要：${"很长的内容".repeat(12)}`,
        themes: [],
      },
    });
  }

  const projection = await client.request("tools/call", {
    name: "vibe_canvas_get_projection",
    arguments: { sessionId },
  });
  assert.ok(projection.structuredContent.summary.length <= 240);
  assert.match(projection.structuredContent.summary, /第 10 轮摘要/);
  assert.doesNotMatch(projection.structuredContent.summary, /第 1 轮摘要/);
});

test("rebuilds typed concepts when a source turn is manually unpicked and restored", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "概念图 Pick", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "只保留真正有证据支持的结构。",
      assistantTakeaway: "概念节点必须跟随 Pick 状态。",
      summary: "验证概念图 Pick 溯源。",
      themes: [],
      conceptOperations: [
        { op: "upsert_domain", id: "domain-product", title: "产品" },
        {
          op: "upsert_topic",
          id: "topic-provenance",
          domainId: "domain-product",
          title: "结构溯源",
          question: "概念如何随原文选择保持一致？",
        },
        {
          op: "upsert_claim",
          id: "claim-pick-source",
          primaryTopicId: "topic-provenance",
          text: "取消原文 Pick 后必须移除对应概念。",
          type: "decision",
          sourceQuote: "只保留真正有证据支持的结构",
        },
      ],
    },
  });
  const before = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  const turnId = before.turns[0].id;

  const removed = await fetch(
    new URL(`/api/sessions/${sessionId}/turns/${turnId}`, opened.structuredContent.browserUrl),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ picked: false }),
    },
  ).then((response) => response.json());
  assert.equal(removed.conceptGraph.topicIndex.length, 0);
  assert.equal(removed.conceptGraph.claimIndex.length, 0);
  assert.equal(removed.themes.length, 0);

  const restored = await fetch(
    new URL(`/api/sessions/${sessionId}/turns/${turnId}`, opened.structuredContent.browserUrl),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ picked: true }),
    },
  ).then((response) => response.json());
  assert.equal(restored.conceptGraph.topicIndex.length, 1);
  assert.deepEqual(restored.conceptGraph.claimIndex[0].evidenceQuotes, [
    { turnId, text: "只保留真正有证据支持的结构" },
  ]);
  assert.deepEqual(restored.themes.map((theme) => theme.title), ["结构溯源"]);
});

test("merges later wording into an existing canonical theme identity", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "跨轮聚合", workspaceRoot: dataDir },
  });
  const sessionId = opened.structuredContent.id;
  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "我对职业的不确定性感到不安。",
      assistantTakeaway: "职业安全感是当前核心关注。",
      summary: "识别职业安全感议题。",
      themes: [{ title: "职业安全感", points: ["担心未来方向"] }],
    },
  });
  const projection = await client.request("tools/call", {
    name: "vibe_canvas_get_projection",
    arguments: { sessionId },
  });
  const canonicalTheme = projection.structuredContent.themes[0];

  await client.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId,
      userText: "其实我担心的是晋升变窄和离开平台后的选择。",
      assistantTakeaway: "新的表述仍属于同一职业安全感主题。",
      summary: "补充职业路径收窄的具体担忧。",
      themes: [
        {
          id: canonicalTheme.id,
          title: "职业未来的不安全感",
          points: ["晋升路径收窄", "离开平台后的选择变少"],
        },
      ],
    },
  });

  const state = await fetch(
    new URL(`/api/sessions/${sessionId}`, opened.structuredContent.browserUrl),
  ).then((response) => response.json());
  assert.equal(state.themes.length, 1);
  assert.equal(state.themes[0].id, canonicalTheme.id);
  assert.equal(state.themes[0].title, "职业安全感");
  assert.deepEqual(
    state.themes[0].points.map((point) => point.text),
    ["担心未来方向", "晋升路径收窄", "离开平台后的选择变少"],
  );
});

test("recovers the same canvas from local storage after the MCP server restarts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const firstClient = new McpClient(dataDir);
  await firstClient.request("initialize", { protocolVersion: "2024-11-05" });
  const opened = await firstClient.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "可恢复画板", workspaceRoot: dataDir },
  });
  await firstClient.request("tools/call", {
    name: "vibe_canvas_sync_turn",
    arguments: {
      sessionId: opened.structuredContent.id,
      userText: "重启后这句话仍然存在。",
      assistantTakeaway: "本地状态可以恢复。",
      summary: "画板状态在 MCP 服务重启后仍可恢复。",
      themes: [{ title: "持久化", points: ["会话保存在工作区"] }],
    },
  });
  await firstClient.close();

  const secondClient = new McpClient(dataDir);
  try {
    await secondClient.request("initialize", { protocolVersion: "2024-11-05" });
    const recovered = await secondClient.request("tools/call", {
      name: "vibe_canvas_get",
      arguments: { sessionId: opened.structuredContent.id },
    });
    assert.equal(recovered.structuredContent.title, "可恢复画板");
    assert.equal(recovered.structuredContent.turns[0].userText, "重启后这句话仍然存在。");
    assert.equal(recovered.structuredContent.revision, 1);
  } finally {
    await secondClient.close();
  }
});

test("serves a pickable projection with exact source turns, structure, graph, and automatic refresh", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const resource = await client.request("resources/read", {
    uri: "ui://vibe-canvas/main.html",
  });
  const content = resource.contents[0];

  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert.match(content.text, /data-region="source"/);
  assert.match(content.text, /data-region="structured"/);
  assert.match(content.text, /data-region="graph"/);
  assert.match(content.text, /\/api\/sessions\//);
  assert.match(content.text, /pick-toggle/);
  assert.match(content.text, /selection-badge/);
  assert.match(content.text, /candidate-buffer-note/);
  assert.match(content.text, /method:\s*"PATCH"/);
  assert.doesNotMatch(content.text, /assistant-takeaway|Codex 提炼|sendFollowUpMessage|ui\/message/i);
});

test("keeps the source and structured panels on the same full row height", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const resource = await client.request("resources/read", {
    uri: "ui://vibe-canvas/main.html",
  });
  const html = resource.contents[0].text;

  assert.match(html, /\.upper-grid\s*>\s*\.panel\s*\{[^}]*height:\s*100%/s);
  assert.match(html, /\.upper-grid\s*>\s*\.panel\s*\{[^}]*display:\s*flex/s);
  assert.match(html, /\.upper-grid\s*>\s*\.panel\s+\.panel-body\s*\{[^}]*flex:\s*1/s);
  assert.doesNotMatch(html, /\.source-panel\s+\.panel-body\s*\{[^}]*height:\s*320px/s);
});

test("serves Pick as a round green and gray checkbox without pill chrome", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const resource = await client.request("resources/read", {
    uri: "ui://vibe-canvas/main.html",
  });
  const html = resource.contents[0].text;

  assert.match(html, /data-pick-control/);
  assert.match(html, /--pick-checked:\s*#2f9d69/i);
  assert.match(html, /--pick-unchecked:\s*#9aa3af/i);
  assert.doesNotMatch(html, /min-width:\s*76px/);
  assert.doesNotMatch(html, /box-shadow:\s*inset 0 0 0 4px/);
});

test("serves blue and warm themes with a persistent labeled switch", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const resource = await client.request("resources/read", {
    uri: "ui://vibe-canvas/main.html",
  });
  const html = resource.contents[0].text;

  assert.match(html, /data-theme="blue"/);
  assert.match(html, /id="theme-toggle-input"/);
  assert.match(html, /role="switch"/);
  assert.match(html, />蓝色</);
  assert.match(html, />暖色</);
  assert.doesNotMatch(html, /data-theme-value=/);
  assert.doesNotMatch(html, /实时同步\s*·\s*r/);
  assert.match(html, /localStorage\.getItem/);
  assert.match(html, /localStorage\.setItem/);
});

test("persists the selected theme for later canvas sessions", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vibe-canvas-test-"));
  const client = new McpClient(dataDir);
  t.after(() => client.close());

  await client.request("initialize", { protocolVersion: "2024-11-05" });
  const first = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "蓝色默认", workspaceRoot: dataDir },
  });
  assert.equal(first.structuredContent.theme, "blue");

  const switched = await fetch(
    new URL(`/api/sessions/${first.structuredContent.id}/theme`, first.structuredContent.browserUrl),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "warm" }),
    },
  );
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).theme, "warm");

  const second = await client.request("tools/call", {
    name: "vibe_canvas_open",
    arguments: { title: "记住主题", workspaceRoot: dataDir },
  });
  assert.equal(second.structuredContent.theme, "warm");
});
