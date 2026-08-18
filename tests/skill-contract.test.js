import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

test("keeps automatic persistence local and does not require a save action", async () => {
  const skill = await readFile(
    path.join(projectRoot, "skills", "vibe-canvas", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /## Local Persistence/);
  assert.match(skill, /\.local\/vibe-canvas-demo\/sessions\/<sessionId>\.json/);
  assert.match(skill, /localhost Browser URL.*temporary/is);
  assert.match(skill, /unless the user explicitly requests/is);
  assert.match(skill, /needs no save action/i);
});

test("maintains a typed concept graph instead of appending a flat theme list", async () => {
  const skill = await readFile(
    path.join(projectRoot, "skills", "vibe-canvas", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /conceptOperations/);
  assert.match(skill, /1[–-]5 atomic claims/i);
  assert.match(skill, /merge_topics/);
  assert.match(skill, /merge_claims/);
  assert.match(skill, /move_claim/);
  assert.match(skill, /contradicts/);
  assert.match(skill, /25 visible nodes/i);
  assert.match(skill, /conceptGraph\.claimIndex/);
  assert.match(skill, /overview/);
  assert.match(skill, /semantic paraphrase/i);
  assert.match(skill, /themes.*empty compatibility/is);
  assert.match(skill, /sourceQuote/);
  assert.match(skill, /exact substring.*userText/is);
  assert.match(skill, /fourth level.*default.*collapsed/is);
});
