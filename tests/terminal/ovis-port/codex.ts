// Ported from ovis (https://github.com/devswha/ovis, 3e51902, MIT, Copyright (c) 2026 devswha) — group G `codex`.
//   server/codex.test.ts (rollout parser cases only)
//   server/codex-images.test.ts (inline picture type check only)
//   server/conversation-metadata.test.ts (Claude Code and Codex cases only)
//   server/start-screen.test.ts (nothing: startScreenMetadata is not ported, only its constants)
// Inputs and expected values are ovis's. Only the calls are adapted to our names.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { codexCallFailed, createCodexTranscriptParser, parseCodexTranscript } from '../../../src/main/transcript/codexTranscript'
import { base64Size, imageType, inlineImageType, MAX_IMAGE_BYTES } from '../../../src/main/transcript/images'
import { foldMetadata } from '../../../src/main/transcript/metadata'
import { turnSegments } from '../../../src/renderer/src/components/ChatView/workBlocks'
import type { ConversationPart, ConversationMeta } from '../../../src/shared/conversation'

void base64Size
void MAX_IMAGE_BYTES

const ts = "2026-09-22T01:00:00.000Z";
const item = (payload: unknown, timestamp = ts) => ({ type: "response_item", timestamp, payload });
const event = (payload: unknown, timestamp = ts) => ({ type: "event_msg", timestamp, payload });
const message = (role: string, text: string, phase?: string) => item({
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}),
});
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

/** ovis `splitTurn` (src/lib/workBlocks.ts): our workBlocks exports turnSegments, which classifies the same way. */
const splitTurn = (parts: ConversationPart[]) => {
  const segments = turnSegments(parts);
  return {
    work: segments.flatMap((segment) => (segment.kind === "work" ? segment.parts : [])),
    answer: segments.flatMap((segment) => (segment.kind === "answer" ? segment.parts : [])),
  };
};

/**
 * ovis cpuRatio, with the process's CPU clock only (ovis prefers a per-thread clock through bun:ffi,
 * which Node does not have). Each input runs once untimed, then three times, and the least of each is compared.
 */
const cpuRatio = <K, T>(make: (input: K) => () => T, reference: K, subject: K): { result: T; ratio: number } => {
  const now = (): number => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const runReference = make(reference);
  const runSubject = make(subject);
  runReference();
  const result = runSubject();
  const shortest = 100;
  let runs = 1;
  const timed = (run: () => T): number => {
    const start = now();
    for (let index = 0; index < runs; index += 1) run();
    return now() - start;
  };
  while (timed(runReference) < shortest) runs *= 2;
  for (;; runs *= 2) {
    let leastReference = Infinity;
    let leastSubject = Infinity;
    for (let round = 0; round < 3; round += 1) {
      leastReference = Math.min(leastReference, timed(runReference));
      leastSubject = Math.min(leastSubject, timed(runSubject));
    }
    if (leastReference >= shortest) return { result, ratio: leastSubject / leastReference };
  }
};

// ---- server/codex.test.ts ----

test.describe("ovis server/codex.test.ts", () => {
test.describe("Codex conversation records", () => {
  test("hides memory citations before pairing display/model answers in either order", () => {
    const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[context]\n</citation_entries>\n<rollout_ids>\nthread-id\n</rollout_ids>\n</oai-mem-citation>";
    for (const reverse of [false, true]) {
      const pair = [message("assistant", `Done\n${citation}`, "final_answer"), event({ type: "agent_message", message: "Done" })];
      if (reverse) pair.reverse();
      expect(parseCodexTranscript(jsonl(...pair))).toEqual([
        { role: "assistant", ts, end_ts: ts, parts: [{ kind: "text", text: "Done", phase: "final_answer" }] },
      ]);
    }
  });

  test("hides multiple and unfinished memory blocks without dropping surrounding prose", () => {
    expect(parseCodexTranscript(jsonl(
      message("assistant", "Before<oai-mem-citation>one</oai-mem-citation> after<oai-mem-citation>two</oai-mem-citation>", "final_answer"),
      event({ type: "agent_message", message: "Next\n<oai-mem-citation>unfinished" }),
      message("assistant", "<oai-mem-citation>metadata only</oai-mem-citation>"),
    ))[0]?.parts).toEqual([
      { kind: "text", text: "Before after", phase: "final_answer" },
      { kind: "text", text: "Next" },
    ]);
    expect(parseCodexTranscript(jsonl(message("assistant", "<oai-mem-citation>unfinished")))).toEqual([]);
  });

  test("preserves memory markup quoted by a user or returned by a tool", () => {
    const text = "<oai-mem-citation>quoted metadata</oai-mem-citation>";
    const turns = parseCodexTranscript(jsonl(
      message("user", text),
      item({ type: "function_call", call_id: "read", name: "read", arguments: "{}" }),
      item({ type: "function_call_output", call_id: "read", output: text }),
    ));
    expect(turns[0]?.parts).toEqual([{ kind: "text", text }]);
    expect(turns[1]?.parts[0]).toMatchObject({ kind: "tool", output: text });
  });

  test("preserves literal memory tags in inline code and code fences", () => {
    const examples = [
      "Match the literal tag `<oai-mem-citation>` in the parser.\nKeep this explanatory paragraph.",
      "The block is `<oai-mem-citation>sample</oai-mem-citation>`.",
      "Use `` `<oai-mem-citation>` `` to quote the tag.",
      "A backslash inside code is literal: `<oai-mem-citation>\\` and prose follows.",
      "Example:\n```xml\n<oai-mem-citation>sample</oai-mem-citation>\n```\nExplanation follows.",
      "Example:\n  ~~~~xml\n<oai-mem-citation>sample</oai-mem-citation>\n  ~~~\nStill code.\n  ~~~~~\nExplanation follows.",
      "Example:\n````xml\n<oai-mem-citation>sample</oai-mem-citation>\n```\nStill code.\n````\nExplanation follows.",
      "An unfinished example:\n```xml\n<oai-mem-citation>literal tag",
      "An unfinished example:\n~~~xml\n<oai-mem-citation>literal tag",
    ];
    for (const text of examples) {
      expect(parseCodexTranscript(jsonl(message("assistant", text, "final_answer")))[0]?.parts).toEqual([
        { kind: "text", text, phase: "final_answer" },
      ]);
    }
  });

  test("removes metadata around code examples before pairing their display records", () => {
    const example = "Before `<oai-mem-citation>` after\n~~~xml\n<oai-mem-citation>sample</oai-mem-citation>\n~~~\nDone";
    const response = "<oai-mem-citation>first</oai-mem-citation>" + example + "\n<oai-mem-citation>unfinished";
    for (const reverse of [false, true]) {
      const pair = [message("assistant", response, "final_answer"), event({ type: "agent_message", message: example })];
      if (reverse) pair.reverse();
      expect(parseCodexTranscript(jsonl(...pair))[0]?.parts).toEqual([
        { kind: "text", text: example, phase: "final_answer" },
      ]);
    }
    const mixed = "Before\n<oai-mem-citation>hidden</oai-mem-citation>\n```xml\n<oai-mem-citation>literal</oai-mem-citation>\n```\n<oai-mem-citation>also hidden</oai-mem-citation>\nAfter";
    expect(parseCodexTranscript(jsonl(message("assistant", mixed)))[0]?.parts).toEqual([
      { kind: "text", text: "Before\n\n```xml\n<oai-mem-citation>literal</oai-mem-citation>\n```\n\nAfter" },
    ]);
    const payload = "Before<oai-mem-citation>\n~~~xml\n`unclosed\n</oai-mem-citation>After\n<oai-mem-citation>hidden too</oai-mem-citation>";
    expect(parseCodexTranscript(jsonl(message("assistant", payload)))[0]?.parts).toEqual([{ kind: "text", text: "BeforeAfter" }]);
  });

  test("preserves fences inside quotes and lists only within their containers", () => {
    const hidden = "<oai-mem-citation>actual metadata</oai-mem-citation>";
    const examples = [
      "> ```xml\n> <oai-mem-citation>literal tag\n> explanation",
      "> > ~~~xml\n> > <oai-mem-citation>literal tag\n> > explanation",
      "> > ```xml\n> > <oai-mem-citation>literal tag\n> > ```\n> Quote continues.",
      "- Example:\n  ```xml\n  <oai-mem-citation>literal tag\n  explanation",
      "- ~~~xml\n  <oai-mem-citation>literal tag\n  ~~~\n  Item continues.",
      "1. Example:\n   - ```xml\n     <oai-mem-citation>literal tag\n     explanation",
      "> - Example:\n>   ```xml\n>   <oai-mem-citation>literal tag\n>   explanation",
    ];
    for (const example of examples) {
      const text = `${example}\nOutside\n${hidden}`;
      expect(parseCodexTranscript(jsonl(message("assistant", text)))[0]?.parts).toEqual([{ kind: "text", text: `${example}\nOutside` }]);
    }
    const nested = "> > ```xml\n> > <oai-mem-citation>literal tag\n> Parent quote\n> " + hidden;
    expect(parseCodexTranscript(jsonl(message("assistant", nested)))[0]?.parts).toEqual([
      { kind: "text", text: "> > ```xml\n> > <oai-mem-citation>literal tag\n> Parent quote\n>" },
    ]);
    const crlf = "> ```xml\r\n> <oai-mem-citation>literal tag\r\nOutside\r\n" + hidden;
    expect(parseCodexTranscript(jsonl(message("assistant", crlf)))[0]?.parts).toEqual([
      { kind: "text", text: "> ```xml\r\n> <oai-mem-citation>literal tag\r\nOutside" },
    ]);
  });

  test("does not let escaped, unmatched or cross-paragraph backticks hide metadata", () => {
    for (const text of [
      "An unmatched ` delimiter.\n<oai-mem-citation>hidden</oai-mem-citation>",
      "An escaped \\` delimiter.\n<oai-mem-citation>hidden</oai-mem-citation>\nA second \\` delimiter.",
      "First `\n\n<oai-mem-citation>hidden</oai-mem-citation>\n\nSecond `",
    ]) {
      const expected = text.replace("<oai-mem-citation>hidden</oai-mem-citation>", "").trimEnd();
      expect(parseCodexTranscript(jsonl(message("assistant", text)))[0]?.parts).toEqual([{ kind: "text", text: expected }]);
    }
  });

  test("bounds citation parsing with many unmatched backtick lengths", () => {
    test.setTimeout(30_000);
    const delimiters = (count: number) => "Unmatched delimiters: " + Array.from({ length: count }, (_, i) => "`".repeat(i + 1) + " x ").join("");
    const text = delimiters(1000);
    // the text against one as long with no backticks: about 1.3 times the CPU time as written, over
    // 600 when each unmatched delimiter looks for its match in the rest of the text
    const { result, ratio } = cpuRatio((ticks: boolean) => {
      const transcript = jsonl(message("assistant", `${ticks ? text : text.replaceAll("`", "'")}<oai-mem-citation>hidden</oai-mem-citation>`));
      return () => parseCodexTranscript(transcript);
    }, false, true);
    expect(result[0]?.parts).toEqual([{ kind: "text", text: text.trimEnd() }]);
    expect(ratio).toBeLessThan(20);
  });

  test("hides injected context, metadata and developer messages while preserving the real request", () => {
    const turns = parseCodexTranscript(jsonl(
      { type: "session_meta", payload: { base_instructions: "internal system prompt" } },
      message("developer", "internal developer prompt"),
      message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>internal rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
      message("user", "<environment_context>cwd</environment_context>"),
      item({ type: "message", role: "user", content: [null, { type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Fix chat" }] }),
      event({ type: "user_message", kind: "internal", message: "injected reminder" }),
      event({ type: "token_count", info: { total: 10 } }),
      message("assistant", "Fixed", "final_answer"),
    ));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Fix chat" }]);
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Fixed", phase: "final_answer" }]);
  });

  test("hides complete directory-less AGENTS envelopes in event and model records", () => {
    for (const newline of ["\n", "\r\n"]) {
      const injected = ["# AGENTS.md instructions", "", "<INSTRUCTIONS>", "Synthetic rules", "</INSTRUCTIONS>"].join(newline);
      const turns = parseCodexTranscript(jsonl(
        message("user", injected), event({ type: "user_message", message: injected }),
        message("user", "Check fixture"), message("assistant", "Ready", "final_answer"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Check fixture" }]);
    }
  });

  test("preserves incomplete, similar and user-extended AGENTS messages", () => {
    for (const text of [
      "# AGENTS.md instructions\nExplain this",
      "# AGENTS.md instructions-extra\n<INSTRUCTIONS>example</INSTRUCTIONS>",
      "# AGENTS.md instructions\nexample</INSTRUCTIONS>",
      "# AGENTS.md instructions\n<INSTRUCTIONS>example</INSTRUCTIONS>\nPlease explain why this rule is wrong.",
      "# AGENTS.md instructions for /project\n<INSTRUCTIONS>example</INSTRUCTIONS>\nPlease explain.",
    ]) {
      for (const record of [message("user", text), event({ type: "user_message", message: text })]) {
        expect(parseCodexTranscript(jsonl(record))[0]?.parts).toEqual([{ kind: "text", text }]);
      }
    }
  });

  test("pairs duplicate display/model records in either order but keeps genuine repeated prompts", () => {
    for (const reverse of [false, true]) {
      const pair = [message("user", "continue"), event({ type: "user_message", message: "continue" })];
      if (reverse) pair.reverse();
      const turns = parseCodexTranscript(jsonl(
        ...pair,
        event({ type: "agent_message", message: "Done" }), message("assistant", "Done", "final_answer"),
        message("user", "continue"), message("user", "continue"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Done", phase: "final_answer" }]);
    }
  });

  test("does not deduplicate identical messages in separate turns", () => {
    expect(parseCodexTranscript(jsonl(
      message("user", "continue"),
      event({ type: "user_message", message: "continue" }, "2026-09-22T01:00:02.000Z"),
    ))).toHaveLength(2);
  });

  test("folds matched function/freeform tool output and commentary, keeping only the final answer outside", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Check"),
      message("assistant", "Checking", "commentary"),
      item({ type: "function_call", call_id: "read", name: "exec_command", arguments: '{"cmd":"git status"}' }),
      item({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
      item({ type: "custom_tool_call_output", call_id: "patch", output: "applied" }),
      item({ type: "function_call_output", call_id: "read", output: [{ type: "text", text: "clean" }] }),
      item({ type: "function_call_output", call_id: "unknown", output: "not a chat message" }),
      message("assistant", "Verifying", "commentary"),
      message("assistant", "All fixed", "final_answer"),
    ));
    const split = splitTurn(turns[1]!.parts);
    expect(split.work.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(split.work[1]).toMatchObject({ summary: "git status", output: "clean" });
    expect(split.work[2]).toMatchObject({ name: "apply_patch", output: "applied" });
    expect(split.answer).toEqual([{ kind: "text", text: "All fixed", phase: "final_answer" }]);
  });

  test("retains reasoning summaries as thinking without decoding encrypted context", () => {
    const turns = parseCodexTranscript(jsonl(
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Considering options" }], encrypted_content: "secret" }),
      item({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis text" }] }),
      message("assistant", "Answer", "final_answer"),
    ));
    expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["thinking", "thinking", "text"]);
    expect(JSON.stringify(turns)).not.toContain("secret");
  });

  test("uses task timestamps rather than idle time before the next user prompt", () => {
    const turns = parseCodexTranscript(jsonl(
      event({ type: "task_started", started_at: ts }),
      message("user", "Check"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }], phase: "final_answer" }, "2026-09-22T01:00:06.000Z"),
      event({ type: "task_complete" }, "2026-09-22T01:00:07.000Z"),
      event({ type: "user_message", message: "Next" }, "2026-09-22T02:00:00.000Z"),
    ));
    expect(turns[1]).toMatchObject({ ts, end_ts: "2026-09-22T01:00:07.000Z" });
  });

  test("bounds tool output and history and tolerates malformed or partially written records", () => {
    const text = jsonl(null, 1, { type: "response_item", payload: null },
      item({ type: "function_call", call_id: "c", name: "exec_command", arguments: "{bad json" }),
      item({ type: "function_call_output", call_id: "c", output: "x".repeat(10_000) }));
    const part = parseCodexTranscript(`${text}\n{"type":`)[0]?.parts[0];
    expect(part?.kind === "tool" ? part.output.length : 0).toBeGreaterThan(4000);
    expect(part?.kind === "tool" ? part.output.length : 0).toBeLessThan(4100);
    expect(parseCodexTranscript(jsonl(...Array.from({ length: 150 }, (_, i) => message("user", `request ${i}`))))).toHaveLength(100);
  });
});

test.describe("Codex queued questions (request_user_input_async)", () => {
  const ask = (callId: string, questions: unknown[]) => item({
    type: "function_call", name: "request_user_input_async", call_id: callId, arguments: JSON.stringify({ questions }),
  });
  const reply = (...answers: { callId: string; index: number; question: string; answer: string }[]) => message("user",
    `<send_user_message_question_reply>\n${JSON.stringify(answers.map((answer) => ({
      answer: answer.answer, question: answer.question,
      questionItemId: JSON.stringify(["request_user_input_async", answer.callId, answer.index]),
    })))}\n</send_user_message_question_reply>`);
  const asked = ask("call_a", [
    { title: "Which dataset?", options: ["LM-O", "YCB-V"] },
    { title: "Any notes?" },
  ]);
  test("shows only what was answered, and the questions asked as the tool's summary", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Clean up the outputs"),
      asked,
      item({ type: "function_call_output", call_id: "call_a", output: "{\"accepted\":true}" }),
      reply({ callId: "call_a", index: 0, question: "Which dataset?", answer: "YCB-V" }),
      reply({ callId: "call_a", index: 1, question: "Any notes?", answer: "keep the logs" }, { callId: "call_b", index: 0, question: "Split?", answer: "test" }),
      message("user", "<send_user_message_question_reply>not json</send_user_message_question_reply>"),
    ));
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "Clean up the outputs" },
      { kind: "text", text: "YCB-V" },
      { kind: "text", text: "keep the logs\ntest" },
      // not a reply Codex wrote: shown as it is
      { kind: "text", text: "<send_user_message_question_reply>not json</send_user_message_question_reply>" },
    ]);
    expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", name: "request_user_input_async", summary: "Which dataset? · Any notes?" });
  });

});

test.describe("Codex tool calls that failed, and patches", () => {
  test("reads a failure from the output Codex records, judging a completed script as a whole", () => {
    expect(codexCallFailed("Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\n")).toBe(true);
    expect(codexCallFailed("Process exited with code 0\nOutput:\nok")).toBe(false);
    expect(codexCallFailed('{"output":"boom","metadata":{"exit_code":2}}')).toBe(true);
    expect(codexCallFailed("Script failed\nError: x")).toBe(true);
    expect(codexCallFailed("apply_patch verification failed: Failed to find expected lines in /x")).toBe(true);
    expect(codexCallFailed("Script completed\nProcess exited with code 1")).toBe(false);
    expect(codexCallFailed("{\"accepted\":true}")).toBe(false);
  });

  test("marks the failed call and sums a patch up by its files", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n";
    const turns = parseCodexTranscript(jsonl(
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: patch } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: "Success. Updated the following files:\nM src/a.ts" } },
      { type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "Process exited with code 1\nOutput:\n" } },
    ));
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => [tool.summary, tool.error === true])).toEqual([["src/a.ts", false], ["false", true]]);
  });
});

test.describe("Codex native call id and state", () => {
  const plan = (id: string) => item({ type: "function_call", call_id: id, name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }] }) });
  const tools = (text: string) => parseCodexTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");

  test("pending without matching output retains call_id and pending state", () => {
    // an output for another call answers nothing here
    expect(tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_other", output: "Plan updated" }))))
      .toMatchObject([{ call_id: "call_a", state: "pending", output: "" }]);
  });

  test("completed function_call_output omits state and retains call_id", () => {
    for (const output of ["Plan updated", "", "Error: plan update failed", "Process exited with code 1\nOutput:\n"]) {
      const [part] = tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_a", output })));
      expect(part).toMatchObject({ call_id: "call_a" });
      expect(part && "state" in part).toBe(false);
    }
  });

  test("completed custom_tool_call_output omits state and retains call_id", () => {
    for (const output of ["applied", "", "apply_patch verification failed: Failed to find expected lines"]) {
      const [part] = tools(jsonl(item({ type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }), item({ type: "custom_tool_call_output", call_id: "call_p", output })));
      expect(part).toMatchObject({ call_id: "call_p" });
      expect(part && "state" in part).toBe(false);
    }
  });

  test("repeated identical calls retain distinct ids", () => {
    const parts = tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_a", output: "Plan updated" }),
      plan("call_b"), item({ type: "function_call_output", call_id: "call_b", output: "Plan updated" })));
    expect(parts.map((part) => part.kind === "tool" && part.call_id)).toEqual(["call_a", "call_b"]);
    expect(parts[0]?.kind === "tool" && parts[1]?.kind === "tool" && [parts[0].input === parts[1].input, parts[0].output === parts[1].output]).toEqual([true, true]);
  });

  test("append and full poll replacement preserve call id and update or omit state", () => {
        const parser = createCodexTranscriptParser();
    const first = jsonl(message("user", "Plan"), plan("call_a"), plan("call_b"));
    parser.write(first);
    const pending = parser.snapshot();
    const ids = (turns: ReturnType<typeof parseCodexTranscript>) => turns.flatMap((turn) => turn.parts).flatMap((part) => part.kind === "tool" ? [[part.call_id, part.state ?? "omitted"]] : []);
    expect(ids(pending)).toEqual([["call_a", "pending"], ["call_b", "pending"]]);
    const second = jsonl(item({ type: "function_call_output", call_id: "call_a", output: "" }));
    // a preview of an unfinished line, then the appended record, then a full re-read of the file
    expect(ids(parser.snapshot(second))).toEqual([["call_a", "omitted"], ["call_b", "pending"]]);
    parser.write(second);
    expect(ids(parser.snapshot())).toEqual([["call_a", "omitted"], ["call_b", "pending"]]);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}`));
    // the earlier snapshot is not rewritten under the reader
    expect(ids(pending)).toEqual([["call_a", "pending"], ["call_b", "pending"]]);
    const long = tools(jsonl(plan("call_c"), item({ type: "function_call_output", call_id: "call_c", output: "x".repeat(5000) })))[0];
    expect(long).toMatchObject({ call_id: "call_c", output_ref: "call_c", output_size: 5000 });
    expect(long && "state" in long).toBe(false);
  });
});

test.describe("incremental Codex records", () => {
  test("pairs citation-bearing answers across writes and previews without changing earlier snapshots", async () => {
        const parser = createCodexTranscriptParser();
    const text = "Match `<oai-mem-citation>` literally.\nThe answer continues.";
    parser.write(jsonl(event({ type: "agent_message", message: text })));
    const earlier = parser.snapshot();
    const response = jsonl(message("assistant", `${text}\n<oai-mem-citation>internal metadata</oai-mem-citation>`, "final_answer"));
    const expected: ReturnType<typeof parseCodexTranscript> = [{ role: "assistant", ts, end_ts: ts, parts: [{ kind: "text", text, phase: "final_answer" }] }];
    expect(parser.snapshot(response)).toEqual(expected);
    expect(earlier[0]?.parts).toEqual([{ kind: "text", text }]);
    expect(parser.snapshot()).toEqual(earlier);
    parser.write(response);
    expect(parser.snapshot()).toEqual(expected);
  });

  test("pairs duplicates and tool results across writes without mutating earlier snapshots", async () => {
        const parser = createCodexTranscriptParser();
    const first = jsonl(event({ type: "task_started" }), message("user", "Inspect"), item({ type: "function_call", call_id: "long", name: "exec_command", arguments: '{"cmd":"pwd"}' }));
    parser.write(first);
    const previous = parser.snapshot();
    const previousJSON = JSON.stringify(previous);
    const second = jsonl(item({ type: "function_call_output", call_id: "long", output: "done" }), event({ type: "agent_message", message: "Finished" }));
    parser.write(second);
    const final = jsonl(message("assistant", "Finished", "final_answer"), event({ type: "task_complete" }));
    expect(parser.snapshot(final)).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(JSON.stringify(previous)).toBe(previousJSON);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}`));
    parser.write(final);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(parser.snapshot().at(-1)?.parts.at(-1)).toMatchObject({ phase: "final_answer", text: "Finished" });
  });
});
});

// ---- server/codex-images.test.ts ----
test.describe("ovis server/codex-images.test.ts", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  const data = `data:image/png;base64,${png.toString("base64")}`;

  test("strips Codex's native image envelope but keeps user-typed lookalikes", () => {
    test.fixme(true, "src/main/transcript/codexTranscript.ts:8-9 — pictures are not read (codexImageParts returns none), so no image parts come out")
    const withEnvelope = {
      type: "response_item", timestamp: "2026-09-27T00:00:00Z",
      payload: { type: "message", role: "user", content: [
        { type: "input_text", text: '<image name=[Image #1] path="/tmp/yellow-star.gif">' },
        { type: "input_image", image_url: data },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "[Image #1]" },
      ] },
    };
    const regressionTurns = parseCodexTranscript(jsonl(withEnvelope));
    const regressionUser = regressionTurns[0]!;
    expect(regressionUser.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1]"]);
    expect(regressionUser.parts.filter((part) => part.kind === "image")).toHaveLength(1);
    expect(JSON.stringify(regressionUser)).not.toContain("/tmp/yellow-star.gif");

    // a pasted image's envelope has no path; two of them in one message
    const pasted = parseCodexTranscript(jsonl({
      type: "response_item", timestamp: "2026-09-27T00:00:00Z",
      payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<image name=[Image #1]>" },
        { type: "input_image", image_url: data },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "<image name=[Image #2]>" },
        { type: "input_image", image_url: data.replace("image/png", "image/gif") },
        { type: "input_text", text: "</image>" },
        { type: "input_text", text: "[Image #1] [Image #2] compare these" },
      ] },
    }))[0]!;
    expect(pasted.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1] [Image #2] compare these"]);
    expect(pasted.parts.filter((part) => part.kind === "image")).toHaveLength(2);

    const controlTurns = parseCodexTranscript(jsonl({
      type: "response_item", timestamp: "2026-09-27T00:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: 'I typed <image name=x> and </image> literally.' }] },
    }));
    expect(controlTurns[0]?.parts.filter((part) => part.kind === "text").map((part) => part.text))
      .toEqual(['I typed <image name=x> and </image> literally.']);
  });

  test("names a raster by its signature and refuses short or truncated prefixes", () => {
    const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)));
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    expect(imageType(png)).toBe("image/png");
    expect(imageType(bytes(pngSignature))).toBe("image/png");
    expect(imageType(bytes(pngSignature.slice(0, 7)))).toBeNull();
    expect(imageType(bytes([255, 216, 255]))).toBe("image/jpeg");
    expect(imageType(bytes([255, 216]))).toBeNull();
    expect(imageType(bytes("GIF87a"))).toBe("image/gif");
    expect(imageType(bytes("GIF89a", [1, 0]))).toBe("image/gif");
    expect(imageType(bytes("GIF88a"))).toBeNull();
    expect(imageType(bytes("GIF89"))).toBeNull();
    expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEBP"))).toBe("image/webp");
    expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEB"))).toBeNull();
    expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WAVE"))).toBeNull();
    // each letter with its high bit set: an ASCII decode would read these as the signatures
    expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x37, 0xe1]))).toBeNull();
    expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x39, 0xe1]))).toBeNull();
    expect(imageType(bytes([0xd2, 0xc9, 0xc6, 0xc6, 4, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
    expect(imageType(bytes("RIFF", [4, 0, 0, 0], [0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
    expect(imageType(bytes("not an image"))).toBeNull();
    expect(imageType(Buffer.alloc(0))).toBeNull();
  });

  // only the inlineImageType lines of ovis's piece-at-a-time test: InlinePictureScan / DataUrlPictureScan are not ported
  test("checks a picture's text a piece at a time exactly as it checks the whole", () => {
    const head = (bytes: number[]) => Buffer.from(bytes).toString("base64");
    const pngHead = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const edge = `${pngHead}${"A".repeat(11_184_814 - pngHead.length - 2)}==`;
    expect(inlineImageType("image/png", edge)).toBe("image/png");
    expect(inlineImageType("image/png", `${edge.slice(0, -2)}A=`)).toBeNull();
  });
});

// ---- server/conversation-metadata.test.ts ----
/** ovis parseConversationMetadata over our foldMetadata: our field is `effort`, and no records is null, not an empty meta. */
type OvisMeta = { model: string | null; reasoning_effort: string | null; context?: ConversationMeta["context"] };
const parseConversationMetadata = (
  text: string, source: string, before?: { model: string | null; reasoning_effort: string | null },
): OvisMeta => {
  const agent = source === "codex-transcript" ? "codex" : "claude";
  const meta = foldMetadata(text, agent, before ? { model: before.model, effort: before.reasoning_effort } : null);
  if (!meta) return { model: null, reasoning_effort: null };
  return { model: meta.model, reasoning_effort: meta.effort, ...(meta.context ? { context: meta.context } : {}) };
};

test.describe("ovis server/conversation-metadata.test.ts", () => {
  test.describe("recorded conversation model settings", () => {
    test("uses the latest Codex turn context, not the session's initial model", () => {
      expect(parseConversationMetadata(jsonl(
        { type: "session_meta", payload: { model: "initial", reasoning_effort: "low" } },
        { type: "turn_context", payload: { model: "current", effort: "xhigh" } },
        { type: "response_item", payload: { type: "message", role: "user", model: "user text is not metadata" } },
      ), "codex-transcript")).toEqual({ model: "current", reasoning_effort: "xhigh" });
    });

    test("recognizes collaboration-mode settings and explicit effort overrides", () => {
      const context = { collaboration_mode: { settings: { model: "collaboration-model", reasoning_effort: "high" } } };
      expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: context }), "codex-transcript"))
        .toEqual({ model: "collaboration-model", reasoning_effort: "high" });
      expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: "none" } }), "codex-transcript"))
        .toEqual({ model: "collaboration-model", reasoning_effort: "none" });
      expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: null } }), "codex-transcript"))
        .toEqual({ model: "collaboration-model", reasoning_effort: null });
    });

    test("does not carry an old effort into a Codex context that no longer reports one", () => {
      expect(parseConversationMetadata(jsonl(
        { type: "turn_context", payload: { model: "first", effort: "high" } },
        { type: "turn_context", payload: { model: "second" } },
      ), "codex-transcript")).toEqual({ model: "second", reasoning_effort: null });
    });

    test("reads Claude's actual model without deriving effort from thinking content", () => {
      expect(parseConversationMetadata(jsonl(
        { type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "text" }] } },
        { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
      ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: null });
      expect(parseConversationMetadata(jsonl(
        { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-test" } },
        { type: "assistant", effort: "xhigh", message: { role: "assistant", model: "claude-test" } },
        { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
      ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: "xhigh" });
    });

    // Claude Code 2.1.311 as recorded, in order: /model sonnet, /effort xhigh, /model nosuchmodel
    // (refused), /effort ultracode (keeps the effort), /model haiku, /model with its card closed
    const recorded = fs.readFileSync(path.join(__dirname, "../../fixtures/ovis/codex/claude-model-2.1.311.jsonl"), "utf8").trim().split("\n");
    const before = { model: "claude-opus-5-5", reasoning_effort: "medium" };

    test("takes the model and effort Claude's /model and /effort set, before the next answer", () => {
      const seen: unknown[] = [];
      let metadata = before;
      // one line at a time, as appends arrive
      for (const line of recorded) {
        const next = parseConversationMetadata(line, "claude-transcript", metadata);
        if (next.model !== metadata.model || next.reasoning_effort !== metadata.reasoning_effort) seen.push(next);
        metadata = next as typeof before;
      }
      expect(seen).toEqual([
        { model: "claude-sonnet-5-5", reasoning_effort: "medium" },
        { model: "claude-sonnet-5-5", reasoning_effort: "xhigh" },
        { model: "claude-haiku-5-5", reasoning_effort: "xhigh" },
      ]);
      expect(parseConversationMetadata(recorded.join("\n"), "claude-transcript", before)).toEqual({ model: "claude-haiku-5-5", reasoning_effort: "xhigh" });
      // the next answer still names what it ran at
      expect(parseConversationMetadata(jsonl({ type: "assistant", effort: "high", message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }), "claude-transcript", { model: "claude-haiku-5-5", reasoning_effort: "xhigh" }))
        .toEqual({ model: "claude-haiku-4-5-20251001", reasoning_effort: "high" });
    });

    test("reads the forms other Claude Code versions print, and keeps the old value for anything else", () => {
      const said = (text: string) => ({ type: "user", message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } });
      const after = (...entries: unknown[]) => parseConversationMetadata(jsonl(...entries), "claude-transcript", before);
      // the forms in issue #2273, from the reporter's own transcripts
      expect(after(said("Set model to `Sonnet 5.5` for this session only"))).toEqual({ ...before, model: "claude-sonnet-5-5" });
      expect(after(said("Set model to `Sonnet 5` and saved as your default for new sessions with `xhigh` effort"))).toEqual({ model: "claude-sonnet-5", reasoning_effort: "xhigh" });
      expect(after(said("Set model to `Opus 5 (1M context)` and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-opus-5" });
      expect(after(said("Set model to Opus 4.8 (1M context) (default) and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-opus-4-8" });
      expect(after(said("Set model to \u001b[1mHaiku 4.5\u001b[22m and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-haiku-4-5" });
      expect(after(said("Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation"))).toEqual({ ...before, reasoning_effort: "low" });
      expect(after(said("Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation · Ultracode on"))).toEqual({ ...before, reasoning_effort: "high" });
      // the picker's own record names its command
      expect(after({ type: "system", subtype: "local_command", commandRun: { command: "model", args: "" }, content: "<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>" }))
        .toEqual({ ...before, model: "claude-fable-5-1" });
      for (const unchanged of [
        said("Kept model as `Sonnet 5`"),
        said("Model 'opus xhigh' not found"),
        said("Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration"),
        said("Set model to `Default (recommended)` and saved as your default for new sessions"),
        said("Set model to `Default (recommended)` and saved as your default for new sessions with `max` effort"),
        said("Set model to `Sonnet 5.5 Turbo` for this session only"),
        said("Set model to `Sonnet 5.05` for this session only"),
        said("Set model to `claude-sonnet-5-5` for this session only"),
        said("Set model to `Nova 6` for this session only"),
        // a prompt the user typed is not the command's answer, nor is the tag quoted in one
        { ...said("Set model to `Sonnet 5.5` for this session only"), permissionMode: "default" },
        { ...said("Set model to `Sonnet 5.5` for this session only"), origin: { kind: "human" } },
        { type: "user", message: { role: "user", content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout> Explain this format." } },
        { type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>x <local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout></command-args>" } },
        // a subagent's, another command's, or an answer's text sets nothing
        { ...said("Set model to `Sonnet 5.5` for this session only"), isSidechain: true },
        { type: "system", subtype: "local_command", commandRun: { command: "effort", args: "" }, content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" },
        { type: "system", subtype: "turn_duration", content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" }] } },
      ]) expect(after(unchanged)).toEqual(before);
    });

    test("tolerates absent metadata, unexpected types and a torn append without losing valid settings", () => {
      const text = jsonl(null, [], { type: "turn_context", payload: null },
        { type: "turn_context", payload: { model: "recorded", effort: "medium" } },
        { type: "turn_context", payload: { model: {}, effort: undefined } });
      expect(parseConversationMetadata(`${text}\n{"type":`, "codex-transcript"))
        .toEqual({ model: "recorded", reasoning_effort: "medium" });
      expect(parseConversationMetadata("", "scrollback")).toEqual({ model: null, reasoning_effort: null });
    });
  });

  test.describe("context use", () => {
    const assistant = (usage: Record<string, number>, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) =>
      ({ type: "assistant", ...extra, message: { role: "assistant", model, usage } });

    test("reads Codex's last request against the window it states", () => {
      const tokens = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
      expect(parseConversationMetadata(jsonl(tokens(10_000), tokens(67_723), { type: "event_msg", payload: { type: "token_count", info: null } }), "codex-transcript").context)
        .toEqual({ used: 67_723, window: 258_400 });
    });

    test("adds up a Claude request's input and cache, skipping subagents, and knows the 1M window once past 200k", () => {
      const small = parseConversationMetadata(jsonl(assistant({ input_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 40_000, output_tokens: 900 })), "claude-transcript");
      expect(small.context).toEqual({ used: 40_702, window: null });
      const long = parseConversationMetadata(jsonl(
        assistant({ input_tokens: 5, cache_read_input_tokens: 420_000 }),
        assistant({ input_tokens: 1, cache_read_input_tokens: 5_000 }, "claude-opus-5-5", { isSidechain: true }),
        // compacted: the use shrinks, the window stays
        assistant({ input_tokens: 3, cache_read_input_tokens: 30_000 }),
        assistant({ input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
      ), "claude-transcript");
      expect(long.context).toEqual({ used: 30_003, window: 1_000_000 });
    });
  });
});

// ---- server/start-screen.test.ts ----
// Nothing to port: startScreenMetadata, readsStartScreen and codexStartScreenUnused are not in this repository.
// Only CLAUDE_FAMILY and VERSION were taken (src/main/transcript/metadata.ts), and they are not exported;
// the /model cases above exercise them through foldMetadata.
