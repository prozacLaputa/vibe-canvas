#!/usr/bin/env node

import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createConceptGraph,
  projectConceptGraph,
  reduceConceptGraph,
} from "./concept-graph.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_URI = "ui://vibe-canvas/main.html";
const UI_PATH = path.join(pluginRoot, "ui", "vibe-canvas.html");
const sessions = new Map();
const sessionLocations = new Map();
let browserOrigin;
let httpServer;

const tools = [
  {
    name: "vibe_canvas_open",
    description: "Open a new Vibe Canvas session for capturing and structuring thoughts.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional canvas title." },
        workspaceRoot: {
          type: "string",
          description: "Absolute workspace root used for future local persistence.",
        },
      },
      additionalProperties: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "正在打开思考画板…",
      "openai/toolInvocation/invoked": "右侧思考投影已准备好",
    },
  },
  {
    name: "vibe_canvas_get",
    description: "Read the latest state of a Vibe Canvas session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vibe_canvas_get_projection",
    description: "Read only the compact summary and theme state needed for the next turn projection.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        workspaceRoot: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "vibe_canvas_sync_turn",
    description: "Project one completed Codex conversation turn into the active Vibe Canvas.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "userText", "assistantTakeaway", "summary", "themes"],
      properties: {
        sessionId: { type: "string" },
        userText: { type: "string", minLength: 1 },
        assistantTakeaway: { type: "string" },
        summary: { type: "string" },
        overview: {
          type: "string",
          maxLength: 240,
          description: "A concise cumulative overview of the current Picked concept state, not a per-turn log.",
        },
        aiPick: {
          type: "string",
          enum: ["picked", "candidate", "ignored"],
          description: "AI selection for the current turn. Candidate turns wait for later review.",
        },
        candidateUpdates: {
          type: "array",
          description: "Optional later AI decisions for turns currently waiting in the candidate buffer.",
          items: {
            type: "object",
            required: ["turnId", "aiPick"],
            properties: {
              turnId: { type: "string" },
              aiPick: { type: "string", enum: ["picked", "ignored"] },
            },
            additionalProperties: false,
          },
        },
        themes: {
          type: "array",
          description: "Current-turn contributions only. Reuse the canonical id and title from vibe_canvas_get_projection for semantically matching themes. Create at most one new top-level theme per turn.",
          items: {
            type: "object",
            required: ["title", "points"],
            properties: {
              id: {
                type: "string",
                description: "Canonical theme identity returned by vibe_canvas_get_projection. Omit only for a genuinely new theme.",
              },
              title: {
                type: "string",
                minLength: 1,
                description: "Reuse the existing canonical title when id refers to an existing theme.",
              },
              points: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        conceptOperations: {
          type: "array",
          description: "Optional typed concept-graph patch for canonical domains, topics, atomic claims, and cross-topic relations. Reuse stable ids from the previous conceptGraph projection. Use merge operations for semantic duplicates and move_claim when splitting an overloaded topic.",
          items: {
            type: "object",
            required: ["op"],
            properties: {
              op: {
                type: "string",
                enum: [
                  "upsert_domain",
                  "upsert_topic",
                  "upsert_claim",
                  "link",
                  "merge_topics",
                  "merge_claims",
                  "move_claim",
                ],
              },
              id: { type: "string" },
              title: { type: "string" },
              question: { type: "string" },
              domainId: { type: "string" },
              text: { type: "string" },
              sourceQuote: {
                type: "string",
                description: "Shortest exact substring of the current userText that supports this claim. Never paraphrase it.",
              },
              type: {
                type: "string",
                enum: [
                  "fact",
                  "judgment",
                  "cause",
                  "decision",
                  "question",
                  "action",
                  "meta",
                  "insight",
                  "causes",
                  "supports",
                  "contradicts",
                  "depends_on",
                  "example_of",
                  "related_to",
                ],
              },
              primaryTopicId: { type: "string" },
              relatedTopicIds: { type: "array", items: { type: "string" } },
              fromId: { type: "string" },
              toId: { type: "string" },
              sourceId: { type: "string" },
              targetId: { type: "string" },
              claimId: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
];

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

async function ensureHttpServer() {
  if (browserOrigin) return browserOrigin;
  httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(await readFile(UI_PATH, "utf8"));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
    if (request.method === "GET" && sessionMatch) {
      try {
        const session = await loadSession(sessionMatch[1]);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(serializeState(session)));
      } catch (error) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const themeMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/theme$/);
    if (request.method === "PATCH" && themeMatch) {
      try {
        const body = await readJsonBody(request);
        const state = await setCanvasTheme(themeMatch[1], body.theme);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(state));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const turnMatch = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]{36})\/turns\/([0-9a-f-]{36})$/,
    );
    if (request.method === "PATCH" && turnMatch) {
      try {
        const body = await readJsonBody(request);
        const state = await setTurnPicked(turnMatch[1], turnMatch[2], body.picked);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(state));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  browserOrigin = `http://127.0.0.1:${address.port}`;
  return browserOrigin;
}

function resolveDataDir(workspaceRoot) {
  if (process.env.VIBE_CANVAS_DATA_DIR) {
    return path.resolve(process.env.VIBE_CANVAS_DATA_DIR);
  }
  if (workspaceRoot) {
    if (!path.isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be absolute.");
    return path.join(workspaceRoot, ".local", "vibe-canvas-demo");
  }
  return path.join(pluginRoot, ".local", "vibe-canvas-demo");
}

function validateSessionId(sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId ?? "")) {
    throw new Error("Invalid session id.");
  }
  return sessionId;
}

function sessionFile(dataDir, sessionId) {
  return path.join(dataDir, "sessions", `${validateSessionId(sessionId)}.json`);
}

function preferencesFile(dataDir) {
  return path.join(dataDir, "preferences.json");
}

function normalizeTheme(theme) {
  return theme === "warm" ? "warm" : "blue";
}

async function loadPreferences(dataDir) {
  try {
    const preferences = JSON.parse(await readFile(preferencesFile(dataDir), "utf8"));
    return { theme: normalizeTheme(preferences.theme) };
  } catch (error) {
    if (error?.code === "ENOENT") return { theme: "blue" };
    throw error;
  }
}

async function persistPreferences(dataDir, preferences) {
  await mkdir(dataDir, { recursive: true });
  const destination = preferencesFile(dataDir);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function normalizeThemes(themes) {
  return themes.map((theme) => {
    const title = typeof theme?.title === "string" ? theme.title.trim() : "";
    if (!title) throw new Error("Theme title cannot be empty.");
    return {
      id: theme.id || stableId("theme", title),
      title,
      points: (Array.isArray(theme.points) ? theme.points : [])
        .map((point) => (typeof point === "string" ? point : point?.text))
        .filter((point) => typeof point === "string" && point.trim())
        .map((point) => ({
          id: stableId("point", `${title}\u0000${point.trim()}`),
          text: point.trim(),
        })),
    };
  });
}

function normalizeAiPick(value) {
  return ["picked", "candidate", "ignored"].includes(value) ? value : "picked";
}

function isTurnPicked(turn) {
  if (typeof turn.manualPick === "boolean") return turn.manualPick;
  return normalizeAiPick(turn.aiPick) === "picked";
}

function applyCandidateUpdates(session, updates) {
  if (updates === undefined) return;
  if (!Array.isArray(updates)) throw new Error("candidateUpdates must be an array.");
  const planned = updates.map((update) => {
    const turn = session.turns.find((candidate) => candidate.id === update?.turnId);
    if (!turn) throw new Error(`Unknown candidate turn: ${update?.turnId ?? ""}`);
    if (normalizeAiPick(turn.aiPick) !== "candidate") {
      throw new Error(`Turn is not waiting in the candidate buffer: ${turn.id}`);
    }
    if (!["picked", "ignored"].includes(update?.aiPick)) {
      throw new Error("Candidate update must resolve to picked or ignored.");
    }
    return { turn, aiPick: update.aiPick };
  });
  for (const { turn, aiPick } of planned) turn.aiPick = aiPick;
}

function migrateSession(session) {
  session.turns ??= [];
  session.blocks ??= [];
  session.themes ??= [];
  session.conceptGraph ??= createConceptGraph();
  session.theme = normalizeTheme(session.theme);
  for (const turn of session.turns) {
    turn.aiPick ??= turn.picked === false ? "ignored" : "picked";
    turn.manualPick ??= null;
  }
  if (session.turns.length && !session.turns.some((turn) => Array.isArray(turn.themes))) {
    const lastTurn = session.turns.at(-1);
    lastTurn.themes = normalizeThemes(session.themes);
    lastTurn.summary = session.summary || lastTurn.assistantTakeaway || "";
  }
  for (const turn of session.turns) {
    turn.themes ??= [];
    turn.summary ??= turn.assistantTakeaway || "";
    turn.overview ??= "";
    turn.conceptOperations ??= [];
  }
  rebuildConceptGraph(session);
  return session;
}

function rebuildConceptGraph(session) {
  let graph = createConceptGraph();
  for (const turn of session.turns.filter(isTurnPicked)) {
    if (!turn.conceptOperations?.length) continue;
    graph = reduceConceptGraph(graph, turn.conceptOperations, {
      turnId: turn.id,
      userText: turn.userText ?? "",
    });
  }
  session.conceptGraph = graph;
  return graph;
}

function conceptThemes(conceptGraph) {
  const projection = projectConceptGraph(conceptGraph);
  return projection.domains.flatMap((domain) =>
    domain.topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      points: topic.claims.map((claim) => ({ id: claim.id, text: claim.text })),
    })),
  );
}

function projectPickedTurns(session) {
  const pickedTurns = session.turns.filter(isTurnPicked);
  const themeMap = new Map();
  for (const turn of pickedTurns) {
    for (const theme of turn.themes ?? []) {
      const title = theme.title.trim();
      const themeId = theme.id || stableId("theme", title.toLocaleLowerCase());
      const key = `id:${themeId}`;
      let merged = themeMap.get(key);
      if (!merged) {
        merged = { id: themeId, title, points: [], pointTexts: new Set() };
        themeMap.set(key, merged);
      }
      for (const point of theme.points ?? []) {
        const text = typeof point === "string" ? point.trim() : point.text?.trim();
        if (!text || merged.pointTexts.has(text)) continue;
        merged.pointTexts.add(text);
        merged.points.push({ id: stableId("point", `${themeId}\u0000${text}`), text });
      }
    }
  }
  const summaries = pickedTurns
    .map((turn) => turn.summary || turn.assistantTakeaway || "")
    .map((summary) => summary.trim())
    .filter(Boolean);
  const latestOverview = pickedTurns.at(-1)?.overview?.trim() ?? "";
  const fallbackSummary = [...new Set(summaries)].slice(-3).join(" ");
  const typedThemes = conceptThemes(session.conceptGraph ?? createConceptGraph());
  return {
    pickedTurnCount: pickedTurns.length,
    summary: (latestOverview || fallbackSummary).slice(0, 240),
    themes: typedThemes.length
      ? typedThemes
      : [...themeMap.values()].map(({ pointTexts, ...theme }) => theme),
  };
}

function applyProjection(session) {
  const projection = projectPickedTurns(session);
  session.summary = projection.summary;
  session.themes = projection.themes;
  return projection;
}

async function persistSession(session) {
  const dataDir = sessionLocations.get(session.id);
  if (!dataDir) throw new Error(`Missing storage location for session: ${session.id}`);
  const sessionsDir = path.join(dataDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const destination = sessionFile(dataDir, session.id);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function loadSession(sessionId, workspaceRoot) {
  validateSessionId(sessionId);
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const dataDir = sessionLocations.get(sessionId) || resolveDataDir(workspaceRoot);
  let session;
  try {
    session = JSON.parse(await readFile(sessionFile(dataDir, sessionId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown session: ${sessionId}`);
    throw error;
  }
  migrateSession(session);
  sessions.set(session.id, session);
  sessionLocations.set(session.id, dataDir);
  return session;
}

async function openCanvas(args = {}) {
  const now = new Date().toISOString();
  const dataDir = resolveDataDir(args.workspaceRoot);
  const preferences = await loadPreferences(dataDir);
  const session = {
    id: crypto.randomUUID(),
    title: args.title?.trim() || "未命名思考",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    theme: preferences.theme,
    blocks: [],
    turns: [],
    summary: "",
    themes: [],
    conceptGraph: createConceptGraph(),
  };
  sessions.set(session.id, session);
  sessionLocations.set(session.id, dataDir);
  await persistSession(session);
  const origin = await ensureHttpServer();
  return {
    ...serializeState(session),
    browserUrl: `${origin}/?session=${session.id}`,
  };
}

function serializeState(session) {
  const projection = projectPickedTurns(session);
  const browserConceptGraph = projectConceptGraph(session.conceptGraph, {
    includeEvidenceQuotes: true,
    maxEvidenceQuotes: 5,
  });
  const claimsById = new Map(
    browserConceptGraph.claimIndex.map((claim) => [claim.id, claim]),
  );
  const turns = session.turns.map((turn) => ({
    ...turn,
    aiPick: normalizeAiPick(turn.aiPick),
    manualPick: typeof turn.manualPick === "boolean" ? turn.manualPick : null,
    picked: isTurnPicked(turn),
    selectionSource: typeof turn.manualPick === "boolean" ? "manual" : "ai",
  }));
  const candidates = turns
    .filter((turn) => turn.aiPick === "candidate" && turn.manualPick === null)
    .map((turn) => ({ turnId: turn.id, takeaway: turn.assistantTakeaway || "" }));
  const rootId = `root:${session.id}`;
  const themeNodes = projection.themes.flatMap((theme) => [
    { id: `theme:${theme.id}`, kind: "theme", label: theme.title, parentId: rootId },
    ...theme.points.map((point) => {
      const claim = claimsById.get(point.id);
      return {
        id: `point:${point.id}`,
        claimId: point.id,
        kind: "point",
        label: point.text,
        parentId: `theme:${theme.id}`,
        evidenceCount: claim?.evidenceCount ?? 0,
        evidenceQuotes: claim?.evidenceQuotes ?? [],
        hiddenEvidenceQuoteCount: claim?.hiddenEvidenceQuoteCount ?? 0,
      };
    }),
  ]);
  return {
    ...session,
    conceptGraph: browserConceptGraph,
    turns,
    ...projection,
    candidates,
    graph: {
      nodes: [
        { id: rootId, kind: "root", label: session.title },
        ...themeNodes,
      ],
    },
  };
}

async function syncTurn(args = {}) {
  const session = await loadSession(args.sessionId, args.workspaceRoot);
  const draft = structuredClone(session);
  const userText = typeof args.userText === "string" ? args.userText : "";
  if (!userText.trim()) throw new Error("User text cannot be empty.");
  if (!Array.isArray(args.themes)) throw new Error("Themes must be an array.");
  applyCandidateUpdates(draft, args.candidateUpdates);
  const now = new Date().toISOString();
  draft.turns ??= [];
  draft.turns.push({
    id: crypto.randomUUID(),
    userText,
    aiPick: normalizeAiPick(args.aiPick),
    manualPick: null,
    assistantTakeaway:
      typeof args.assistantTakeaway === "string" ? args.assistantTakeaway.trim() : "",
    summary: typeof args.summary === "string" ? args.summary.trim() : "",
    overview: typeof args.overview === "string" ? args.overview.trim().slice(0, 240) : "",
    themes: normalizeThemes(args.themes),
    conceptOperations: Array.isArray(args.conceptOperations)
      ? structuredClone(args.conceptOperations)
      : [],
    createdAt: now,
  });
  rebuildConceptGraph(draft);
  applyProjection(draft);
  draft.revision += 1;
  draft.updatedAt = now;
  await persistSession(draft);
  sessions.set(draft.id, draft);
  return { sessionId: draft.id, revision: draft.revision, updatedAt: draft.updatedAt };
}

async function setTurnPicked(sessionId, turnId, picked) {
  if (typeof picked !== "boolean") throw new Error("picked must be a boolean.");
  const session = await loadSession(sessionId);
  const draft = structuredClone(session);
  const turn = draft.turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`Unknown turn: ${turnId}`);
  if (turn.manualPick === picked) return serializeState(draft);
  turn.manualPick = picked;
  rebuildConceptGraph(draft);
  applyProjection(draft);
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  await persistSession(draft);
  sessions.set(draft.id, draft);
  return serializeState(draft);
}

async function setCanvasTheme(sessionId, theme) {
  if (!["blue", "warm"].includes(theme)) throw new Error("theme must be blue or warm.");
  const session = await loadSession(sessionId);
  if (session.theme === theme) return serializeState(session);
  session.theme = theme;
  session.revision += 1;
  session.updatedAt = new Date().toISOString();
  await Promise.all([
    persistSession(session),
    persistPreferences(sessionLocations.get(session.id), { theme }),
  ]);
  return serializeState(session);
}

async function getCanvas(args = {}) {
  return serializeState(await loadSession(args.sessionId, args.workspaceRoot));
}

async function getProjection(args = {}) {
  const session = await loadSession(args.sessionId, args.workspaceRoot);
  const projection = projectPickedTurns(session);
  const candidates = session.turns
    .filter((turn) => normalizeAiPick(turn.aiPick) === "candidate" && turn.manualPick === null)
    .map((turn) => ({ turnId: turn.id, takeaway: turn.assistantTakeaway || "" }));
  return {
    sessionId: session.id,
    title: session.title,
    revision: session.revision,
    turnCount: session.turns?.length ?? 0,
    summary: projection.summary,
    candidates,
    themes: projection.themes.map((theme) => ({
      id: theme.id,
      title: theme.title,
      points: theme.points.map((point) => point.text),
    })),
    conceptGraph: projectConceptGraph(session.conceptGraph),
  };
}

async function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "vibe-canvas", version: "0.9.0" },
      };
    case "tools/list":
      return { tools };
    case "resources/list":
      return {
        resources: [
          {
            uri: UI_URI,
            name: "Vibe Canvas",
            mimeType: "text/html;profile=mcp-app",
          },
        ],
      };
    case "resources/read":
      if (params?.uri !== UI_URI) throw new Error(`Unknown resource: ${params?.uri ?? ""}`);
      return {
        contents: [
          {
            uri: UI_URI,
            mimeType: "text/html;profile=mcp-app",
            text: await readFile(UI_PATH, "utf8"),
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      };
    case "tools/call": {
      if (params?.name === "vibe_canvas_open") {
        return textResult(await openCanvas(params.arguments));
      }
      if (params?.name === "vibe_canvas_get") {
        return textResult(await getCanvas(params.arguments));
      }
      if (params?.name === "vibe_canvas_get_projection") {
        return textResult(await getProjection(params.arguments));
      }
      if (params?.name === "vibe_canvas_sync_turn") {
        return textResult(await syncTurn(params.arguments));
      }
      throw new Error(`Unknown tool: ${params?.name ?? ""}`);
    }
    case "ping":
      return {};
    default:
      throw new Error(`Method not found: ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;

  try {
    const result = await handleRequest(message.method, message.params);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: error.message },
      })}\n`,
    );
  }
});
