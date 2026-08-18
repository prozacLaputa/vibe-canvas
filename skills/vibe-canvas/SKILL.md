---
name: vibe-canvas
description: Open and maintain a live Vibe Canvas projection beside the current Codex conversation. Use when the user explicitly asks to open or start Vibe Canvas, keep syncing later turns without another submit action, let AI auto-Pick or buffer turns, and preserve manual Pick as the final authority.
---

# Vibe Canvas

Vibe Canvas is a live projection of the current Codex conversation. Codex remains the only text input and reasoning surface. The right-side browser shows exact user turns, Pick controls, structured understanding, and the evolving mind map.

## Start the Projection

When the user explicitly asks to open or start Vibe Canvas:

1. Call `vibe_canvas_open` with the current absolute workspace root and a short topic title.
2. Read `sessionId` from `id` and keep it as the active canvas session for this task.
3. Read `browserUrl` from the result.
4. Call `codex_app__open_in_codex` with:
   - `target.type`: `browser`
   - `target.url`: the returned `browserUrl`
   - `placement`: `right`
5. Tell the user the live projection is open. Do not ask them to type, submit, save, or organize anything in the browser.

Do not open a canvas merely because the user is thinking aloud. Wait for an explicit Vibe Canvas request.

## Sync Every Later Turn

After a canvas is active, handle every later user message in the same task as one normal Codex turn plus one silent projection update:

1. Call `vibe_canvas_get_projection` with the active session ID. This returns the previous compact summary, candidate buffer, legacy themes, and a bounded `conceptGraph`; do not call `vibe_canvas_get` for routine syncing.
2. Reason about the user's message and prepare the normal answer for the left conversation. Split its durable contribution into 1–5 atomic claims. Each claim must express one fact, judgment, cause, decision, question, action, or meta-insight.
3. Classify the current turn with `aiPick`:
   - `picked`: it adds a durable idea, constraint, decision, question, relationship, or useful clarification.
   - `candidate`: it may matter but needs later context; preserve it without adding it to the projection yet.
   - `ignored`: it is conversational scaffolding, repetition, a transient correction, or otherwise not useful to the thinking artifact.
4. Review the returned `candidates`. Only when later context resolves one, include it in `candidateUpdates` as `picked` or `ignored`. Do not resend unresolved candidates.
5. Build `conceptOperations` against the stable IDs in `conceptGraph.topicIndex` and `conceptGraph.claimIndex`:
   - Reuse an existing domain or topic ID when the new claim answers the same canonical question. Wording changes alone never create a topic.
   - Compare every atomic claim against `conceptGraph.claimIndex`. Reuse a claim ID with `upsert_claim` when the proposition is equivalent; this adds evidence instead of another bullet.
   - Every `upsert_claim` must include `sourceQuote`: the shortest exact substring of the current `userText` that directly supports the claim. Copy it verbatim; never paraphrase, normalize, or quote assistant text. The server rejects a `sourceQuote` that is not present in the current `userText`.
   - The server automatically collapses exact normalized question/text duplicates as a deterministic safeguard. A semantic paraphrase still requires your judgment: reuse the canonical ID or emit `merge_topics` / `merge_claims`; never assume the server can infer semantic equivalence by itself.
   - Use a new claim under the existing topic when it is a genuinely different proposition about the same question.
   - Use one primary topic plus `relatedTopicIds` and `link` when one claim crosses topics. Store the claim once. Supported relation types include `causes`, `supports`, `contradicts`, `depends_on`, `example_of`, and `related_to`.
   - Use `merge_topics` or `merge_claims` when the compact state reveals an existing duplicate. Preserve the clearer canonical target.
   - Use `move_claim` to split a catch-all topic after creating the narrower target topic. Do not split merely to add visual depth.
   - Create at most two genuinely new topics in one turn. Prefer existing canonical questions whenever meaning overlaps.
   - On every fifth Picked turn, reconsider obvious duplicate merges and overloaded-topic splits within the same reasoning pass. Do not run a second model session.
   - The server keeps the default projection within 25 visible nodes and returns the 40 most recently active claims in `conceptGraph.claimIndex` for later matching. `omittedClaimIndexCount` reports older claims outside that compact comparison window.
6. Update the projection before sending the final answer by calling `vibe_canvas_sync_turn` with:
   - `sessionId`: the active session ID.
   - `userText`: the user's exact current message.
   - `assistantTakeaway`: one concise sentence capturing the answer's most useful conclusion, not the full answer.
   - `summary`: one concise sentence describing only the current turn's useful contribution.
   - `overview`: one cumulative sentence, at most 180 Chinese characters, describing the current Picked concept state after this turn. Rewrite it as state; never append a turn-by-turn log.
   - `conceptOperations`: the typed incremental patch prepared above. Send an empty array when the current turn adds no durable structure.
   - `themes`: pass `[]` as an empty compatibility field. The server derives the existing UI shape from the concept graph; do not duplicate the structure here.
   - `aiPick`: the current turn classification.
   - `candidateUpdates`: optional decisions for earlier candidate turn IDs.
7. Send the normal answer in the left conversation. Do not mention the routine sync unless it failed.

The right-side page polls the local state and updates automatically. Never require a second user action.

## Local Persistence

The MCP server automatically persists the complete Canvas session under `.local/vibe-canvas-demo/sessions/<sessionId>.json` inside the active workspace. The session ID and JSON file are the durable identity; a localhost Browser URL is temporary because its port belongs to the current MCP process.

Do not copy the Canvas into another archive, knowledge base, or task system unless the user explicitly requests that destination. Routine syncing needs no save action.

## Interaction Contract

- Left Codex conversation: the only place where the user inputs ideas and talks with AI.
- Right Browser projection: exact source turns, one Pick checkbox per turn, structured understanding, and mind map.
- AI automatically selects clear signal, buffers uncertainty, and ignores obvious noise.
- The user can check or uncheck any source turn locally. That manual choice overrides AI permanently for the turn and redraws the structure and graph immediately without a model call.
- Candidate review uses only short takeaways and IDs from `vibe_canvas_get_projection`; never reread all source text merely to reconsider candidates.
- The right Browser starts with the bright blue theme and keeps a warm alternative in a labeled Switch in the header. Theme switching is local UI state and must never call the model.
- Keep session revision internal for polling. Never expose `rN` counters in the user-facing sync status.
- Keep Pick as a standard round Checkbox without pill chrome: selected is green with a white check, unselected is gray, and the readable `Pick` label remains.
- The source area must show `userText` verbatim, preserving line breaks. Never mix `assistantTakeaway` or rewritten copy into the source area.
- The mind map's fourth level is exact source evidence under a third-level claim. It is default collapsed; the user expands or collapses it by clicking the claim or using Enter/Space. Keep at most five recent quote nodes visible and direct the user to the complete left source list for older evidence.
- No text input field, submit button, save button, or organize button belongs in the right projection.
- Never call `sendFollowUpMessage`, `ui/message`, or a second background Codex session for routine projection updates.
- Never post a synthetic user message such as `请整理画板 session ...` into the conversation.
- Routine sync must stay inside the same Codex turn and use one compact structure read plus one small write.

## Boundaries

- Preserve the user's exact current message in `userText`; structure is an additional view, not a rewrite.
- Keep `assistantTakeaway` short to avoid duplicating the full answer and wasting tokens.
- During routine turns, do not copy the Canvas into project records, task lists, decisions, or knowledge bases.
- Treat the local session JSON as the only automatic durable record.
- Do not turn inferred ideas into tasks, decisions, commitments, evidence, or completed work.
- Any archive beyond the local Canvas session still requires an explicit user request.
