// ovis tests ported for group `claude` (CLI Manager's Claude transcript readers).
// Source: github.com/devswha/ovis @3e51902 (MIT, Copyright (c) 2026 devswha) —
//   server/conversation.test.ts            (the parseClaudeTranscript / unwrapPastes cases)
//   server/chat-history.test.ts            (isContextClear)
//   server/claude-subagents.test.ts        (taskNotification)
//   server/skill-activity.test.ts          (Claude / Codex readers)
//   server/skill-invocations/claude.test.ts
// Inputs and expected values are ovis's, unchanged. Only the calls are adapted:
// bun:test -> Playwright, the conversation.ts entry point -> our parseClaudeTranscript.
// Cases that go through ovis's pane/paging/herdr/filesystem layers (transcriptPage,
// transcriptImage ...) have no counterpart here and are not ported — see parts/claude.md.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { join } from 'path'
import { parseClaudeTranscript, unwrapPastes, claudeImageType } from '../../../src/main/transcript/claudeTranscript'
import { parseCodexTranscript, createCodexTranscriptParser } from '../../../src/main/transcript/codexTranscript'
import { isContextClear, MAX_TURNS } from '../../../src/main/transcript/records'
import { taskNotification } from '../../../src/main/transcript/subagents'
import { workSummary, workFailed } from "../../../src/renderer/src/components/ChatView/workBlocks"
import { claudeCommandEcho, codexReadCall, codexReadSkills, selectedSkill } from '../../../src/main/transcript/skillActivity'
import type { ConversationPart, SkillActivity } from '../../../src/shared/conversation'

const FIXTURES = path.join(__dirname, '../../fixtures/ovis/claude')

/** ovis src/lib/skillActivity.ts, verbatim — a renderer helper we did not port; the cases only read through it. */
function turnSkills(parts: readonly ConversationPart[]): SkillActivity[] {
  const skills = new Map<string, SkillActivity>()
  for (const part of parts) {
    if (part.kind !== 'tool' && part.kind !== 'skill') continue
    if (!part.skill) continue
    const skill = part.skill
    skills.set(`${skill.evidence}:${skill.path ?? skill.name}`, skill)
  }
  return [...skills.values()]
}

test.describe('ovis server/conversation.test.ts', () => {
test("labels only Claude's explicit end_turn text as final-answer evidence", () => {
  const entry = (stop_reason: string | null) => JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason, content: [{ type: "text", text: "Answer" }] } });
  expect(parseClaudeTranscript(entry(null))[0]?.parts).toEqual([{ kind: "text", text: "Answer" }]);
  expect(parseClaudeTranscript(entry("tool_use"))[0]?.parts).toEqual([{ kind: "text", text: "Answer" }]);
  expect(parseClaudeTranscript(entry("end_turn"))[0]?.parts).toEqual([{ kind: "text", text: "Answer", phase: "final_answer" }]);
});
const lines = [
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:00.000Z", message: { role: "user", content: "리팩터링 시작해줘" } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:02.000Z", message: { role: "assistant", content: [
    { type: "text", text: "먼저 상태를 확인하겠습니다." },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status --short", description: "check tree" } },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:00:03.000Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "M src/app.ts" },
  ] } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-09-19T08:00:05.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "internal reasoning stays private" },
    { type: "text", text: "변경된 파일이 하나입니다." },
  ] } }),
  JSON.stringify({ type: "user", timestamp: "2026-09-19T08:01:00.000Z", message: { role: "user", content: "<command-name>/help</command-name>" } }),
].join("\n");

test.describe("parseClaudeTranscript", () => {
  test("restores the recorded explicit skill invocation while hiding its meta body and compact echo", async () => {
    const fixture = fs.readFileSync(path.join(FIXTURES, "skill-invocations-claude.jsonl"), "utf8");
    const compact = JSON.stringify({ type: "user", message: { content: "<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args></command-args>" } });
    const users = parseClaudeTranscript(`${fixture}\n${compact}`).filter(({ role }) => role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.parts).toEqual([
      { kind: "text", text: "/probe-skill hello" },
      { kind: "skill", skill: { name: "probe-skill", evidence: "invocation", status: "requested" } },
    ]);
  });
  test("builds user and merged assistant turns with folded tool results", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns).toEqual([
      { role: "user", ts: "2026-09-19T08:00:00.000Z", parts: [{ kind: "text", text: "리팩터링 시작해줘" }] },
      { role: "assistant", ts: "2026-09-19T08:00:02.000Z", end_ts: "2026-09-19T08:00:05.000Z", parts: [
        { kind: "text", text: "먼저 상태를 확인하겠습니다." },
        // the row says what the agent said the command is for; the command stays in the input
        { kind: "tool", name: "Bash", summary: "check tree", input: expect.stringContaining("git status"), output: "M src/app.ts", call_id: "toolu_1", state: "ok" },
        { kind: "thinking", text: "internal reasoning stays private" },
        { kind: "text", text: "변경된 파일이 하나입니다." },
      ] },
    ]);
  });

  test.describe("native call id and state", () => {
    const prompt = JSON.stringify({ type: "user", message: { role: "user", content: "plan it" } });
    const use = (id: string, input: object = { todos: [] }) => JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "TodoWrite", input }] } });
    const result = (id: string, content: unknown, isError?: boolean) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] } });
    const tools = (text: string) => parseClaudeTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");

    test("pending call has native id and pending state", () => {
      expect(tools([prompt, use("toolu_a")].join("\n"))).toMatchObject([{ call_id: "toolu_a", state: "pending", output: "" }]);
    });

    test("empty successful result is ok", () => {
      const [part] = tools([prompt, use("toolu_a"), result("toolu_a", "")].join("\n"));
      expect(part).toMatchObject({ call_id: "toolu_a", state: "ok", output: "" });
      expect(part?.kind === "tool" && part.error).toBeFalsy();
    });

    test("explicit failed result is error", () => {
      expect(tools([prompt, use("toolu_a"), result("toolu_a", "", true)].join("\n"))).toMatchObject([{ call_id: "toolu_a", state: "error", error: true }]);
      // a result that only reads like a failure is still the success the flag says
      expect(tools([prompt, use("toolu_b"), result("toolu_b", "Error: exit code 1", false)].join("\n"))).toMatchObject([{ call_id: "toolu_b", state: "ok" }]);
    });

    test("repeated identical calls retain distinct ids", () => {
      const parts = tools([prompt, use("toolu_a"), result("toolu_a", "same"), use("toolu_b"), result("toolu_b", "same")].join("\n"));
      expect(parts.map((part) => part.kind === "tool" && [part.call_id, part.state, part.input, part.output])).toEqual([
        ["toolu_a", "ok", parts[1]?.kind === "tool" ? parts[1].input : "", "same"],
        ["toolu_b", "ok", parts[0]?.kind === "tool" ? parts[0].input : "", "same"],
      ]);
    });

    test("append and full poll replacement preserve call id and update or omit state", () => {
      const first = [prompt, use("toolu_a"), use("toolu_b")];
      expect(tools(first.join("\n")).map((part) => part.kind === "tool" && [part.call_id, part.state])).toEqual([["toolu_a", "pending"], ["toolu_b", "pending"]]);
      // the next poll reads the file again with both results appended
      const second = [...first, result("toolu_a", ""), result("toolu_b", "denied", true)];
      expect(tools(second.join("\n")).map((part) => part.kind === "tool" && [part.call_id, part.state])).toEqual([["toolu_a", "ok"], ["toolu_b", "error"]]);
      // a cut output keeps the id beside its fetch ref
      const long = tools([prompt, use("toolu_c"), result("toolu_c", "x".repeat(5000))].join("\n"))[0];
      expect(long).toMatchObject({ call_id: "toolu_c", state: "ok", output_ref: "toolu_c", output_size: 5000 });
    });
  });

  test("shows a pasted text without Claude Code's paste wrapper, in string and block prompts", () => {
    const pasted = '\n\n<pasted_content id="6d8b">\n| a | b |\n\nsecond paragraph\n</pasted_content id="6d8b">\n';
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: pasted } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `look at this${pasted}` }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "typed <\\pasted_content id=\"6d8b\"> stays" } }),
    ].join("\n"));
    expect(turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "| a | b |\n\nsecond paragraph" },
      { kind: "text", text: "look at this\n\n| a | b |\n\nsecond paragraph" },
      { kind: "text", text: 'typed <\\pasted_content id="6d8b"> stays' },
    ]);
  });

  test("drops slash-command bookkeeping entries", () => {
    const turns = parseClaudeTranscript(lines);
    expect(turns.some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.includes("/clear")))).toBe(false);
  });

  test("shows what a slash command answered, and leaves its echo and an empty answer out", () => {
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", isMeta: false, timestamp: ts, content });
    const refusal = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).";
    const turns = parseClaudeTranscript([
      local("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>test</command-args>", "2026-10-07T19:00:00.000Z"),
      local(`<local-command-stdout>${refusal}</local-command-stdout>`, "2026-10-07T19:00:01.000Z"),
      local("<local-command-stdout></local-command-stdout>", "2026-10-07T19:00:02.000Z"),
      local("<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>", "2026-10-07T19:00:03.000Z"),
      JSON.stringify({ type: "system", subtype: "turn_duration", content: "<local-command-stdout>not a command's answer</local-command-stdout>" }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-07T19:00:01.000Z", parts: [{ kind: "notice", text: refusal, source: "local-command" }] },
      { role: "user", ts: "2026-10-07T19:00:03.000Z", parts: [{ kind: "notice", text: "Unknown command: /gaol", source: "local-command" }] },
    ]);
  });

  test("shows Claude Code's own notices, an unknown command's lines joined as one", () => {
    // Claude Code 2.1.294: an unknown command and its dropped arguments, 1ms apart, and no user turn
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      info("Unknown command: /xyzabc", "2026-10-08T08:06:31.117Z"),
      info("Args from unknown skill: hello there", "2026-10-08T08:06:31.118Z"),
      info("Usage limit reached · continuing automatically at 4am · esc to cancel", "2026-10-08T09:00:00.000Z"),
      info("\u001b[2mUsage limit reset · continuing automatically\u001b[22m", "2026-10-08T13:00:00.000Z"),
      info("", "2026-10-08T13:00:01.000Z"),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-08T08:06:31.117Z", parts: [{ kind: "notice", text: "Unknown command: /xyzabc\nArgs from unknown skill: hello there", source: "informational" }] },
      { role: "user", ts: "2026-10-08T09:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reached · continuing automatically at 4am · esc to cancel", source: "informational" }] },
      { role: "user", ts: "2026-10-08T13:00:00.000Z", parts: [{ kind: "notice", text: "Usage limit reset · continuing automatically", source: "informational" }] },
    ]);
  });

  test("keeps a notice joined from long lines within the notice's length", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, timestamp: ts });
    const [turn] = parseClaudeTranscript([
      info("a".repeat(4000), "2026-10-08T08:06:31.117Z"),
      info("b".repeat(4000), "2026-10-08T08:06:31.118Z"),
    ].join("\n"));
    const text = (turn!.parts[0] as { text: string }).text;
    expect(turn!.parts).toHaveLength(1);
    expect(text.length).toBe(4001);
    expect(text.endsWith("\u2026")).toBe(true);
  });

  test("keeps a turn whole when Claude Code writes a notice while the agent works", () => {
    // a cross-session notice between a tool's result and the next call: about half of the notices in real transcripts
    const assistant = (block: object, stop: string, ts: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: stop, content: [block] } });
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run it" } }),
      assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 60" } }, "tool_use", "2026-10-08T08:00:01.000Z"),
      info("Cross-session message held by the receiving session", "2026-10-08T08:00:20.000Z"),
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      info("Cross-session message expired without approval", "2026-10-08T08:01:02.500Z"),
      assistant({ type: "text", text: "Done." }, "end_turn", "2026-10-08T08:01:03.000Z"),
      info("Unknown command: /xyzabc", "2026-10-08T08:02:00.000Z"),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]],
      // written inside the turn: shown before it, and the turn is still the last one while it runs
      ["user", ["Cross-session message held by the receiving session"]],
      ["user", ["Cross-session message expired without approval"]],
      ["assistant", ["tool", "text"]],
      // written after the answer: shown after it
      ["user", ["Unknown command: /xyzabc"]],
    ]);
    expect(turns[3]!.end_ts).toBe("2026-10-08T08:01:03.000Z");
  });

  test("keeps a turn whole around a notice when the tool call's entry names no stop reason", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "Message held" }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
      JSON.stringify({ type: "system", subtype: "informational", content: "After the answer" }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? part.text : part.kind)])).toEqual([
      ["user", ["text"]], ["user", ["Message held"]], ["assistant", ["tool", "text"]], ["user", ["After the answer"]],
    ]);
  });

  test("shows a refusal recorded both ways once also while the agent works, and keeps the turn whole", () => {
    const at = "2026-10-08T08:00:10.000Z";
    const info = JSON.stringify({ type: "system", subtype: "informational", timestamp: at, content: "Message held" });
    const local = JSON.stringify({ type: "system", subtype: "local_command", timestamp: at, content: "<local-command-stderr>Message held</local-command-stderr>" });
    const around = (notices: string[]) => parseClaudeTranscript([
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:00:00.000Z", message: { role: "user", content: "run" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "sleep 60" } }] } }),
      ...notices,
      JSON.stringify({ type: "user", timestamp: "2026-10-08T08:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-08T08:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }),
    ].join("\n")).map((turn) => [turn.role, turn.parts.map((part) => part.kind === "notice" ? `${part.source}: ${part.text}` : part.kind)]);
    expect(around([info, local])).toEqual([["user", ["text"]], ["user", ["informational: Message held"]], ["assistant", ["tool", "text"]]]);
    expect(around([local, info])).toEqual([["user", ["text"]], ["user", ["local-command: Message held"]], ["assistant", ["tool", "text"]]]);
  });

  test("shows a refusal once when Claude Code records it both as a command's answer and as a notice", () => {
    const info = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "informational", content, level: "warning", timestamp: ts });
    const local = (content: string, ts: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: ts, content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    const stderr = "<local-command-stderr>\u001b[31mUnknown command: /gaol\u001b[39m</local-command-stderr>";
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:06:31.118Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol", "Args from unknown skill: x"]);
    expect(notices([info("Unknown command: /gaol", "2026-10-08T08:06:31.117Z"), info("Args from unknown skill: x", "2026-10-08T08:06:31.118Z"), local(stderr, "2026-10-08T08:06:31.119Z")]))
      .toEqual(["Unknown command: /gaol\nArgs from unknown skill: x"]);
    // the same words a minute later are another answer, and a notice's own repeat is kept
    expect(notices([local(stderr, "2026-10-08T08:06:31.117Z"), info("Unknown command: /gaol", "2026-10-08T08:07:31.118Z")])).toEqual(["Unknown command: /gaol", "Unknown command: /gaol"]);
    expect(notices([info("Message expired", "2026-10-08T08:06:31.117Z"), info("Message expired", "2026-10-08T08:06:31.118Z")])).toEqual(["Message expired\nMessage expired"]);
  });

  test("shows a bash-mode command with what it printed as one turn, which only the command opens", () => {
    const user = (content: string, ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } });
    const records = [
      user('<bash-input>echo "Hello"</bash-input>', "2026-10-27T03:00:00.000Z"),
      user("<bash-stdout>  Hello\n    world\n</bash-stdout><bash-stderr></bash-stderr>", "2026-10-27T03:00:00.100Z"),
      user("<bash-input>ls extra</bash-input>", "2026-10-27T03:00:01.000Z"),
      user("<bash-stdout></bash-stdout><bash-stderr>\u001b[31mls: extra: No such file or directory\u001b[39m</bash-stderr>", "2026-10-27T03:00:01.100Z"),
      // a command whose output was not recorded, then a prompt that quotes the tags
      user("<bash-input>sleep 60</bash-input>", "2026-10-27T03:00:02.000Z"),
      user("Why does <bash-input>ls</bash-input> show here?", "2026-10-27T03:00:03.000Z"),
      // only a whole output entry is one: a prompt that starts like one is a prompt
      user("<bash-stdout> is the tag I mean", "2026-10-27T03:00:04.000Z"),
    ];
    expect(parseClaudeTranscript(records.join("\n"))).toEqual([
      { role: "user", ts: "2026-10-27T03:00:00.000Z", parts: [{ kind: "shell", command: 'echo "Hello"', stdout: "  Hello\n    world", stderr: "" }] },
      { role: "user", ts: "2026-10-27T03:00:01.000Z", parts: [{ kind: "shell", command: "ls extra", stdout: "", stderr: "ls: extra: No such file or directory" }] },
      { role: "user", ts: "2026-10-27T03:00:02.000Z", parts: [{ kind: "shell", command: "sleep 60" }] },
      { role: "user", ts: "2026-10-27T03:00:03.000Z", parts: [{ kind: "text", text: "Why does <bash-input>ls</bash-input> show here?" }] },
      { role: "user", ts: "2026-10-27T03:00:04.000Z", parts: [{ kind: "text", text: "<bash-stdout> is the tag I mean" }] },
    ]);
    // a page never starts at an output: it would lose its command
    // an output with no command before it is left out
    expect(parseClaudeTranscript(records[1]!)).toEqual([]);
  });

  for (const provenance of [{ origin: { kind: "human" }, permissionMode: "default" }, { permissionMode: "default" }, { origin: { kind: "human" } }]) {
    for (const array of [false, true]) {
      test(`keeps bash tags literal in ${array ? "array" : "string"} prompts with ${Object.keys(provenance).join(" and ")}`, () => {
        for (const text of ["<bash-input>ls</bash-input>", "<bash-stdout>err</bash-stdout>"]) {
          const record = JSON.stringify({ type: "user", ...provenance, message: { role: "user", content: array ? [{ type: "text", text }] : text } });
          expect(parseClaudeTranscript(record)).toEqual([{ role: "user", ts: null, parts: [{ kind: "text", text }] }]);
        }
      });
    }
  }

  test("keeps bash output tags literal in queued human prompts", () => {
    const text = "<bash-stdout>err</bash-stdout>";
    const record = JSON.stringify({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt: text } });
    expect(parseClaudeTranscript(record)).toEqual([{ role: "user", ts: null, parts: [{ kind: "text", text }] }]);
  });

  test("preserves literal stream tags inside bash stdout without fabricating stderr", () => {
    const stdout = "before</bash-stdout><bash-stderr>fake error</bash-stderr><bash-stdout>after";
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [user("<bash-input>printf tags</bash-input>"), user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr></bash-stderr>`)];
    expect(parseClaudeTranscript(records.join("\n"))[0]?.parts).toEqual([{ kind: "shell", command: "printf tags", stdout: `${stdout}</bash-stdout><bash-stderr>`, stderr: "" }]);
  });

  test("preserves literal stream tags inside bash stderr", () => {
    const stderr = "before</bash-stderr><bash-stderr>after";
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [user("<bash-input>printf tags</bash-input>"), user(`<bash-stdout></bash-stdout><bash-stderr>${stderr}</bash-stderr>`)];
    const parts = parseClaudeTranscript(records.join("\n")).flatMap((turn) => turn.parts);
    expect(parts).toEqual([{ kind: "shell", command: "printf tags", stdout: "", stderr }]);
  });

  for (const [stdout, stderr] of [
    ["", "before</bash-stdout><bash-stderr>after"],
    ["out", "x</bash-stdout>y"],
  ] as const) {
    test(`keeps a printed stdout close inside stderr ${JSON.stringify(stderr)} without adding a turn`, () => {
      const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
      const records = [
        user("<bash-input>printf tags</bash-input>"),
        user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
      ].join("\n");
      const ambiguous = stderr.includes("</bash-stdout><bash-stderr>");
      expect(parseClaudeTranscript(records)).toEqual([
        { role: "user", ts: null, parts: [{ kind: "shell", command: "printf tags",
          stdout: ambiguous ? `${stdout}</bash-stdout><bash-stderr>${stderr}` : stdout,
          stderr: ambiguous ? "" : stderr }] },
      ]);
    });
  }

  for (const { name, stdout, stderr, ambiguous } of [
    { name: "N1", stdout: "a</bash-stdout><bash-stderr>b", stderr: "", ambiguous: true },
    { name: "N2", stdout: 'user("<bash-stdout>Hello</bash-stdout><bash-stderr></bash-stderr>", 1)', stderr: "", ambiguous: true },
    {
      name: "N3",
      stdout: `572: user('<bash-input>echo "Hello"</bash-input>')\n573: user("<bash-stdout>  Hello</bash-stdout><bash-stderr></bash-stderr>")\n575: user("<bash-stdout></bash-stdout><bash-stderr>ls: extra</bash-stderr>")`,
      stderr: "", ambiguous: true,
    },
    { name: "N4", stdout: '{"content":"<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>"}', stderr: "", ambiguous: true },
    { name: "N5", stdout: "o</bash-stdout><bash-stderr>p", stderr: "e", ambiguous: true },
    { name: "N6", stdout: "", stderr: "x</bash-stderr><bash-stdout>y", ambiguous: false },
    { name: "N7", stdout: "o", stderr: "a</bash-stderr><bash-stdout>b</bash-stdout><bash-stderr>c", ambiguous: true },
    { name: "H", stdout: "ok", stderr: "x</bash-stdout><bash-stderr>y", ambiguous: true },
    { name: "Codex R1", stdout: "before</bash-stdout><bash-stderr>after", stderr: "", ambiguous: true },
    { name: "Codex R2", stdout: "", stderr: "before</bash-stderr><bash-stdout>middle</bash-stdout><bash-stderr>after", ambiguous: true },
    { name: "empty-candidate collision", stdout: "x", stderr: "y</bash-stdout><bash-stderr>", ambiguous: true },
    { name: "ambiguous trailing whitespace", stdout: "x</bash-stdout>\n<bash-stderr>y", stderr: "z \n", ambiguous: true },
  ]) {
    test(`keeps deterministic bash output ${name} intact in one shell turn`, () => {
      const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
      const records = [
        user("<bash-input>printf tags</bash-input>"),
        user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
      ].join("\n");
      const expectedStdout = ambiguous ? `${stdout}</bash-stdout><bash-stderr>${stderr}` : stdout;
      const expectedStderr = ambiguous ? "" : stderr;
      expect(parseClaudeTranscript(records)).toEqual([
        { role: "user", ts: null, parts: [{ kind: "shell", command: "printf tags", stdout: expectedStdout, stderr: expectedStderr }] },
      ]);
    });
  }

  test("never fabricates stderr or loses payload characters across seeded bash tag pairs", () => {
    const pieces = ["<bash-stdout>", "</bash-stdout>", "<bash-stderr>", "</bash-stderr>", "one", "two"];
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    for (const seed of [0x2176, 0xc0de]) {
      let state = seed;
      const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
      };
      const payload = () => {
        const count = next() % 9;
        let text = "";
        for (let i = 0; i < count; i++) text += pieces[next() % pieces.length];
        return text;
      };
      for (let i = 0; i < 512; i++) {
        const stdout = payload(), stderr = payload();
        const records = [
          user("<bash-input>printf tags</bash-input>"),
          user(`<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`),
        ].join("\n");
        const turns = parseClaudeTranscript(records);
        expect(turns).toHaveLength(1);
        const shell = turns[0]?.parts[0];
        if (shell?.kind !== "shell") throw new Error("Expected one shell card");
        expect(shell.stderr === "" || shell.stderr === stderr).toBe(true);
        const shown = `${shell.stdout ?? ""}${shell.stderr ?? ""}`;
        // ovis asserts per character; Playwright's expect costs ~0.4 ms a call (1.5 min over 200k calls),
        // so the same order check is a plain loop with one expect per payload.
        let at = 0;
        let lost: string | null = null;
        for (const character of stdout + stderr) {
          const found = shown.indexOf(character, at);
          if (found < at) {
            lost = `${character} at ${at}`;
            break;
          }
          at = found + 1;
        }
        expect(lost, `payload ${JSON.stringify({ stdout, stderr })}`).toBeNull();
      }
    }
  });

  test("attaches bash output to its shell across an informational notice", () => {
    const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content } });
    const records = [
      user("<bash-input>ls</bash-input>"),
      JSON.stringify({ type: "system", subtype: "informational", content: "Something" }),
      user("<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>"),
    ];
    expect(parseClaudeTranscript(records.join("\n")).map((turn) => turn.parts)).toEqual([
      [{ kind: "shell", command: "ls", stdout: "README.md", stderr: "" }],
      [{ kind: "notice", text: "Something", source: "informational" }],
    ]);
  });

  test("shows a slash command's answer only as the whole entry, as text, and not past its length", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an echo whose arguments quote the tag is still an echo
    expect(notices([local("<command-name>/goal</command-name>\n<command-args>x <local-command-stdout>quoted</local-command-stdout></command-args>")])).toEqual([]);
    // a link keeps its text and drops its hidden address; cursor moves and backspaces go too
    expect(notices([local("<local-command-stdout>\u001b]8;;https://example.test/?token=hidden\u0007open\u001b]8;;\u0007 done\u001b[2K\b</local-command-stdout>")])).toEqual(["open done"]);
    const long = notices([local(`<local-command-stdout>${"x".repeat(10_000)}</local-command-stdout>`)])[0]!;
    expect(long.length).toBe(4001);
    expect(long.endsWith("\u2026")).toBe(true);
  });

  test("strips an unterminated link, a charset switch, and shows both streams of one entry", () => {
    const local = (content: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content });
    const notices = (lines: string[]) => parseClaudeTranscript(lines.join("\n")).flatMap((turn) => turn.parts).filter((part) => part.kind === "notice").map((part) => (part as { text: string }).text);
    // an OSC cut off before its BEL or ST still hides its address
    expect(notices([local("<local-command-stdout>done \u001b]8;;https://example.test/?token=hidden</local-command-stdout>")])).toEqual(["done"]);
    // ESC ( B is one sequence: no stray B
    expect(notices([local("<local-command-stdout>\u001b(Bplain\u001b[m text</local-command-stdout>")])).toEqual(["plain text"]);
    expect(notices([local("<local-command-stdout>out</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["out\nerr"]);
    // a closing tag the output itself prints ends nothing: only one at the end, or before the next stream, does
    expect(notices([local("<local-command-stdout>Use </local-command-stdout> in this example.</local-command-stdout>")])).toEqual(["Use </local-command-stdout> in this example."]);
    expect(notices([local("<local-command-stdout>a </local-command-stdout> b</local-command-stdout>\n<local-command-stderr>err</local-command-stderr>")])).toEqual(["a </local-command-stdout> b\nerr"]);
  });

  test("strips escapes in work linear in a malformed answer's length", () => {
    const local = (n: number, unit: string) => JSON.stringify({ type: "system", subtype: "local_command", timestamp: "2026-10-07T19:00:00.000Z", content: `<local-command-stdout>${unit.repeat(n)}</local-command-stdout>` });
    // Counted, not timed: the parse takes well under a millisecond, and two such timings divide
    // into noise. It reads the answer through these primitives, each charged the characters it
    // touches. A regex's backtracking cannot be counted, so a run is charged its worst case, the
    // square of its input: a regex over one character costs one step, one over the answer fails.
    const work = (line: string): number => {
      let steps = 0;
      const text = String.prototype;
      const { charCodeAt, indexOf, startsWith, slice } = text;
      const { exec } = RegExp.prototype;
      text.charCodeAt = function (this: string, index: number) {
        steps++;
        return charCodeAt.call(this, index);
      };
      text.indexOf = function (this: string, search: string, from = 0) {
        const found = indexOf.call(this, search, from);
        steps += (found === -1 ? this.length : found) - from + search.length;
        return found;
      };
      text.startsWith = function (this: string, search: string, from?: number) {
        steps += search.length;
        return startsWith.call(this, search, from);
      };
      text.slice = function (this: string, start?: number, end?: number) {
        const part = slice.call(this, start, end);
        steps += part.length;
        return part;
      };
      RegExp.prototype.exec = function (this: RegExp, input: string) {
        steps += input.length ** 2;
        return exec.call(this, input);
      };
      try {
        parseClaudeTranscript(line);
      } finally {
        text.charCodeAt = charCodeAt;
        text.indexOf = indexOf;
        text.startsWith = startsWith;
        text.slice = slice;
        RegExp.prototype.exec = exec;
      }
      return steps;
    };
    // unterminated escapes, and closing tags the output prints itself
    for (const unit of ["\u001b]x", "</local-command-stdout> x"]) {
      // doubling the input doubles the work (2.00 measured for both); a rescan from every
      // unterminated opener, or from every closing tag, quadruples it. No work counted at all
      // is NaN here and fails too.
      expect(work(local(40_000, unit)) / work(local(20_000, unit))).toBeLessThan(2.5);
    }
  });

  test("keeps thinking blocks in transcript order", () => {
    const assistant = parseClaudeTranscript(lines)[1];
    expect(assistant?.parts.map((part) => part.kind)).toEqual(["text", "tool", "thinking", "text"]);
  });

  test("reads thinking that Claude Code displays as updates as narration in the work", () => {
    // the shape a recent Claude Code writes: one entry per block, the visible update as thinking
    const entry = (thinkingDisplay: string | undefined, block: object) => JSON.stringify({ type: "assistant", timestamp: "2026-10-14T07:00:00.000Z", ...(thinkingDisplay ? { thinkingDisplay } : {}), message: { role: "assistant", stop_reason: null, content: [block] } });
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", message: { role: "user", content: "measure the padding" } }),
      entry("updates", { type: "thinking", thinking: "", signature: "s" }),
      entry("updates", { type: "thinking", thinking: "The padding stays; measuring it next.", signature: "s" }),
      entry("updates", { type: "tool_use", id: "t", name: "Bash", input: { command: "true" } }),
      entry(undefined, { type: "thinking", thinking: "private reasoning", signature: "s" }),
    ].join("\n"));
    expect(turns[1]?.parts.filter((part) => part.kind !== "tool")).toEqual([
      { kind: "text", text: "The padding stays; measuring it next.", phase: "commentary" },
      { kind: "thinking", text: "private reasoning" },
    ]);
  });

  test("survives a torn tail line while Claude is mid-append", () => {
    expect(parseClaudeTranscript(`${lines}\n{"type":"ass`).length).toBe(2);
  });

  test("trims a huge tool result instead of shipping megabytes to the browser", () => {
    const big = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t", name: "Read", input: { file_path: "/etc/big" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "t", content: "x".repeat(10_000) },
      ] } }),
    ].join("\n");
    const turns = parseClaudeTranscript(big);
    const tool = turns[0]?.parts[0];
    expect(tool && tool.kind === "tool" ? tool.output.length : 0).toBeLessThanOrEqual(4100);
  });


  test("caps the turn list", () => {
    const many = Array.from({ length: MAX_TURNS + 50 }, (_, i) =>
      JSON.stringify({ type: "user", message: { role: "user", content: `m${i}` } }),
    ).join("\n");
    expect(parseClaudeTranscript(many).length).toBe(MAX_TURNS);
  });

  test("returns nothing for an empty transcript", () => {
    expect(parseClaudeTranscript("")).toEqual([]);
  });

  test("shows a message the person sent while the agent was working", () => {
    const queued = (attachment: Record<string, unknown>) => ({ type: "attachment", timestamp: "2026-10-02T04:00:05.000Z", attachment: { type: "queued_command", timestamp: "2026-10-02T04:00:05.000Z", ...attachment } });
    const transcript = [
      { type: "user", timestamp: "2026-10-02T04:00:00.000Z", message: { role: "user", content: "start" } },
      { type: "assistant", timestamp: "2026-10-02T04:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
      // the queue pair repeats the text; only the attachment becomes a turn
      { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-02T04:00:05.000Z", content: "also fix the tests" },
      { type: "queue-operation", operation: "remove", timestamp: "2026-10-02T04:00:09.000Z", content: "also fix the tests", reason: "absorbed_mid_turn" },
      queued({ prompt: "also fix the tests", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true }),
      // a background task's notice and another agent's message are not the person's words
      queued({ prompt: "<task-notification>\n<status>completed</status>\n</task-notification>", commandMode: "task-notification" }),
      queued({ prompt: "<agent-message from=\"reviewer\">\ndone\n</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true }),
      { type: "assistant", timestamp: "2026-10-02T04:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(parseClaudeTranscript(transcript).map((turn) => [turn.role, turn.ts, turn.parts])).toEqual([
      ["user", "2026-10-02T04:00:00.000Z", [{ kind: "text", text: "start" }]],
      ["assistant", "2026-10-02T04:00:02.000Z", [{ kind: "text", text: "working" }]],
      ["user", "2026-10-02T04:00:05.000Z", [{ kind: "text", text: "also fix the tests" }]],
      ["assistant", "2026-10-02T04:00:10.000Z", [{ kind: "text", text: "on it" }]],
    ]);
  });

  test("drops a prompt cancelled before any reply when Claude Code re-sends it from the same parent", () => {
    // Claude Code 2.1.296 on send, Esc before any reply, then a re-send: the cancelled record
    // and the re-send are siblings under one parent, only bookkeeping lines between, and the
    // TUI shows only the re-send
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "a35be47b", parentUuid: "07055903", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "apple 2-87" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "file-history-snapshot" } }),
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "user", uuid: "7477aa61", parentUuid: "07055903", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "user", content: "cherry 2" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "Cherry." }] } }),
    ].join("\n"));
    expect(turns).toEqual([
      { role: "user", ts: "2026-10-10T08:00:04.000Z", parts: [{ kind: "text", text: "cherry 2" }] },
      { role: "assistant", ts: "2026-10-10T08:00:06.000Z", end_ts: "2026-10-10T08:00:06.000Z", parts: [{ kind: "text", text: "Cherry." }] },
    ]);
  });

  test("keeps a prompt re-sent from the same parent when the first one was answered", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "one answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["assistant", { kind: "text", text: "one answer" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  test("keeps an unanswered prompt when the next one hangs from another parent", () => {
    // an ordinary next prompt's parent is the answer before it, not the earlier prompt's
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "q", timestamp: "2026-10-10T08:00:05.000Z", message: { role: "user", content: "second" } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "first" }],
      ["user", { kind: "text", text: "second" }],
    ]);
  });

  test("sees the cancelled prompt whether it was written as a string or as blocks", () => {
    const turns = parseClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: "p", timestamp: "2026-10-10T08:00:00.000Z", message: { role: "user", content: "string draft" } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "p", timestamp: "2026-10-10T08:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "block resend" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "user", uuid: "u3", parentUuid: "a", timestamp: "2026-10-10T08:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "block draft" }] } }),
      JSON.stringify({ type: "user", uuid: "u4", parentUuid: "a", timestamp: "2026-10-10T08:01:03.000Z", message: { role: "user", content: "string resend" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-10-10T08:01:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "another" }] } }),
    ].join("\n"));
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "text", text: "block resend" }],
      ["assistant", { kind: "text", text: "answer" }],
      ["user", { kind: "text", text: "string resend" }],
      ["assistant", { kind: "text", text: "another" }],
    ]);
  });



  test.describe("subagent notifications", () => {
    const roots: string[] = [];
    const block = (summary: string, extra = "<result>found two issues</result>") =>
      `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n${extra}\n</task-notification>`;
    /** the three records one completion is written as */
    const carriers = (content: string, timestamp: string) => [
      { type: "queue-operation", operation: "enqueue", timestamp, content },
      { type: "user", timestamp, message: { role: "user", content } },
      { type: "attachment", timestamp, attachment: { type: "queued_command", commandMode: "task-notification", prompt: content } },
    ];
    const read = (entries: unknown[], subagents?: Parameters<typeof parseClaudeTranscript>[2]) =>
      parseClaudeTranscript(entries.map((entry) => JSON.stringify(entry)).join("\n"), MAX_TURNS, subagents);
    const start = { type: "user", timestamp: "2026-10-05T00:00:00.000Z", message: { role: "user", content: "review it" } };


    test("draws a queue-only completion before the active turn, but not its removal", () => {
      const content = block('Agent "Review the parser" finished');
      const turn = { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }] } };
      const queued = { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-05T00:01:00.000Z", content };
      const turns = read([start, turn, queued]);
      expect(turns.map((entry) => entry.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool"]);
      expect(turns[1]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ id: "a1", status: "completed", result: "found two issues" }] });
      expect(read([start, turn, { ...queued, operation: "remove" }]).flatMap((entry) => entry.parts).filter((part) => part.kind === "task_result")).toEqual([]);
    });

    test("skips garbled lines and incomplete notification envelopes without a success card", () => {
      const content = block('Agent "Review the parser" finished').replace("</task-notification>", "");
      const transcript = `null\n42\n{garbled\n${JSON.stringify(start)}\n${JSON.stringify({ type: "user", message: { content } })}\n{"type":`;
      expect(parseClaudeTranscript(transcript)).toEqual(read([start]));
    });

    test("becomes one task_result however many records carry it, and starts a turn of its own", () => {
      const turns = read([
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "started a reviewer" }] } },
        ...carriers(block('Agent "Review the parser" finished'), "2026-10-05T00:01:00.000Z"),
        { type: "assistant", timestamp: "2026-10-05T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "it found two" }] } },
      ], { subagents: new Map([["a1", { title: "Review parser fix", agent: "reviewer" }]]) });
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(turns[2]).toEqual({ role: "user", ts: "2026-10-05T00:01:00.000Z", parts: [{ kind: "task_result", tasks: [{
        id: "a1", title: "Review parser fix", agent: "reviewer", model: null, status: "completed",
        duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues",
      }] }] });
    });

    test("draws a notice that shares an entry with a tool's result once, before the turn still at work", () => {
      const notice = block('Agent "Review the parser" finished');
      const entries = [
        start,
        { type: "assistant", timestamp: "2026-10-05T00:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls" } }] } },
        { type: "user", timestamp: "2026-10-05T00:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "a.ts" }, { type: "text", text: notice }] } },
        { type: "assistant", timestamp: "2026-10-05T00:01:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] } },
      ];
      for (const turns of [read(entries), read([...entries, ...carriers(notice, "2026-10-05T00:01:00.000Z")])]) {
        expect(turns.map((turn) => turn.parts.map((part) => part.kind).join())).toEqual(["text", "task_result", "tool,text"]);
        const tool = turns[2]?.parts[0];
        expect(tool?.kind === "tool" ? tool.output : tool).toBe("a.ts");
      }
    });



    test("falls back to the summary's name and leaves out what no file told", () => {
      const turns = read(carriers(block('Agent "Security review" finished'), "2026-10-05T00:01:00.000Z"));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts).toEqual([{ kind: "task_result", tasks: [{ id: "a1", title: "Security review", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "found two issues" }] }]);
    });

    test("counts a resumed agent's next notification, which carries another tool-use id", () => {
      const again = block('Agent "Review" finished').replace("toolu_1", "toolu_2");
      const turns = read([...carriers(block('Agent "Review" finished'), "2026-10-05T00:01:00.000Z"), ...carriers(again, "2026-10-05T00:05:00.000Z")]);
      expect(turns.map((turn) => turn.ts)).toEqual(["2026-10-05T00:01:00.000Z", "2026-10-05T00:05:00.000Z"]);
    });

    test("cuts a long answer at the same limit as OmO's", () => {
      const turns = read(carriers(block('Agent "Long" finished', `<result>${"x".repeat(16_001)}</result>`), "2026-10-05T00:01:00.000Z"));
      const part = turns[0]?.parts[0];
      expect(part?.kind === "task_result" ? [part.tasks[0]?.result.length, part.tasks[0]?.result_cut] : part).toEqual([16_000, true]);
    });

    test("keeps a failed or stopped agent's status and hides a background command's notice", () => {
      const stopped = block('Agent "Cleanup" was stopped by Claude', "").replace("<status>completed", "<status>killed");
      const turns = read([...carriers(stopped, "2026-10-05T00:01:00.000Z"), ...carriers(block('Background command "sleep 5" completed (exit code 0)', ""), "2026-10-05T00:02:00.000Z")]);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ title: "Cleanup", status: "cancelled", result: "" }] });
    });
  });

  test("preserves array user text, including mixed tool results, without exposing bookkeeping", () => {
    const transcript = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] } },
      { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: "t", content: "result" }, { type: "text", text: "Actual request" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } },
      { type: "user", isMeta: true, message: { content: "internal reminder" } },
      { type: "user", isCompactSummary: true, message: { content: "compacted context" } },
      null,
    ].map((entry) => JSON.stringify(entry)).join("\n");
    const turns = parseClaudeTranscript(transcript);
    // the compaction is no bookkeeping: it marks where the conversation was folded
    expect(turns).toHaveLength(3);
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "result" });
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Actual request" }]);
    expect(turns[2]?.parts).toEqual([{ kind: "compact", text: "compacted context" }]);
  });
});

/** Minimal but shape-true slices of an omp session jsonl. */
const ompLines = [
  JSON.stringify({ type: "title", v: 1, title: "프로젝트 불편사항 패치" }),
  JSON.stringify({ type: "session", version: 3, id: "01a0bdf7-b9e3-72bb-bad1-671dde7082f8" }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:00.000Z", message: { role: "user", attribution: "user", content: [
    { type: "text", text: "주소좀 줘봐" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:02.000Z", message: { role: "assistant", content: [
    { type: "thinking", text: "internal reasoning stays private" },
    { type: "thinking", thinking: "alternate thinking field" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ss -tlnp", i: "Checking ports" }, intent: "Checking ports" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: false, content: [
    { type: "text", text: "LISTEN 0 512 100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:39:05.000Z", message: { role: "assistant", content: [
    { type: "text", text: "http://100.123.228.51:7317" },
  ] } }),
  JSON.stringify({ type: "message", timestamp: "2026-09-20T08:40:00.000Z", message: { role: "user", content: [
    { type: "image", blob: "..." },
  ] } }),
].join("\n");

test.describe("tool calls that failed", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  test("keeps Claude's is_error and omp's isError on the call they answer", () => {
    const claude = parseClaudeTranscript(lines(
      { type: "assistant", timestamp: "2026-09-27T00:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "true" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }, { type: "tool_result", tool_use_id: "t2", content: "" }] } },
    ));
    expect(claude.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool").map((part) => part.error === true)).toEqual([true, false]);
  });
});

test.describe("images and compactions in a Claude transcript", () => {
  const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  test("names a pasted image by its entry and block, and never carries its data", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", timestamp: "2026-09-27T00:00:00Z", message: { content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
      ] } },
      { type: "user", uuid: "66666666-2222-3333-4444-555555555555", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] } },
    ));
    expect(turns.map((turn) => turn.parts)).toEqual([
      [{ kind: "image", media_type: "image/png", ref: "11111111-2222-3333-4444-555555555555:0" }, { kind: "text", text: "what is this?" }],
      [{ kind: "image", media_type: "image/jpeg", ref: "66666666-2222-3333-4444-555555555555:0" }],
    ]);
    expect(JSON.stringify(turns)).not.toContain("iVBOR");
  });

  test("names a picture a tool returned by its entry, its result and its place there, and never carries its data", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const turns = parseClaudeTranscript(lines(
      { type: "user", uuid: "00000000-2222-3333-4444-555555555555", message: { content: "open both shots" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.txt" } }, { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.png" } }], stop_reason: "tool_use" } },
      { type: "user", uuid: "77777777-2222-3333-4444-555555555555", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "plain text" },
        { type: "tool_result", tool_use_id: "toolu_b", content: [
          { type: "text", text: "read b.png" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          // a type the chat never shows, and bytes that are no picture under a type it does
          { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "PHN2Zz4=" } },
        ] },
      ] } },
    ));
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => [tool.output, tool.images])).toEqual([
      ["plain text", undefined],
      ["read b.png", [{ media_type: "image/png", ref: "77777777-2222-3333-4444-555555555555:1:1" }]],
    ]);
    expect(JSON.stringify(turns)).not.toContain(png);
  });

  test("opens a turn at a prompt that is only a picture, as at a text one", () => {
    const picture = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    const records = [
      { type: "user", uuid: "11111111-2222-3333-4444-555555555555", message: { content: "first" } },
      { type: "assistant", message: { content: [{ type: "text", text: "one" }], stop_reason: "end_turn" } },
      { type: "user", uuid: "22222222-2222-3333-4444-555555555555", message: { content: [picture("iVBORw0KGgoAAAANSUhEUg==")] } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }], stop_reason: "end_turn" } },
      // what the parser draws no picture for opens nothing either
      { type: "user", uuid: "33333333-2222-3333-4444-555555555555", message: { content: [picture("PHN2Zz4=")] } },
    ].map((record) => JSON.stringify(record));
    const bytes = Buffer.from(records.join("\n"));
  });


  test("marks where a compaction folded the conversation, with its summary", () => {
    const turns = parseClaudeTranscript(lines(
      { type: "user", timestamp: "2026-09-27T00:00:00Z", message: { content: "before" } },
      { type: "user", isCompactSummary: true, timestamp: "2026-09-27T01:00:00Z", message: { content: "This session is being continued. Summary: X" } },
    ));
    expect(turns.at(-1)).toEqual({ role: "user", ts: "2026-09-27T01:00:00Z", parts: [{ kind: "compact", text: "This session is being continued. Summary: X" }] });
  });
});

test("preserves literal paste lookalikes, partial wrappers and mismatched ids", () => {
  const cases = [
    '<pasted_content id="a">\nverbatim\n</pasted_content id="b">',
    '<pasted_content>\nverbatim\n</pasted_content>',
    '<pasted_content id="a">verbatim</pasted_content id="a">',
    '<pasted_content id="a">\nunfinished',
    '\n\nordinary prompt\n',
  ];
  for (const text of cases) expect(unwrapPastes(text)).toBe(text);
  expect(unwrapPastes('before\n<pasted_content id="a_1">\r\nfirst\r\n</pasted_content id="a_1">\nafter')).toBe("before\nfirst\nafter");
});
})

test.describe('ovis server/claude-subagents.test.ts', () => {
test.describe("taskNotification", () => {
  test("does not report a truncated envelope as completed", () => {
    expect(taskNotification('<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "review" finished</summary>')).toBeNull();
  });

  test("reads a block, its result to the last closing tag", () => {
    expect(taskNotification('<task-notification>\n<task-id>a</task-id>\n<status>stopped</status>\n<summary>Agent "x" was stopped by Claude</summary>\n<result>see </result> here</result>\n</task-notification>')).toEqual({
      taskId: "a", toolUseId: null, status: "cancelled", summary: 'Agent "x" was stopped by Claude', result: "see </result> here", agent: true,
    });
    expect(taskNotification("hello")).toBeNull();
  });
});

})

test.describe('ovis server/skill-invocations/claude.test.ts', () => {

test("leaves nonmatching text and builtin echoes to existing handling", () => {
  test.fixme(true, 'src/main/transcript/skillActivity.ts:63-68 — built-in commands are a fixed list (ovis reads the installed Claude\'s), so /heapdump reads as a skill')
  for (const text of [
    "/probe-skill hello",
    "<command-message>probe-skill</command-message>",
    "<command-message>other</command-message><command-name>/probe-skill</command-name><command-args>hello</command-args>",
    "<command-message>compact</command-message><command-name>/compact</command-name><command-args></command-args>",
    "<command-message>config</command-message><command-name>/config</command-name><command-args>theme=dark</command-args>",
    "<command-message>heapdump</command-message><command-name>/heapdump</command-name><command-args></command-args>",
  ]) expect(claudeCommandEcho(text)).toBeNull();
});

test("records a bundled skill's echo, or that of a skill of the user's own named like one, as a skill", () => {
  expect(claudeCommandEcho("<command-message>code-review</command-message><command-name>/code-review</command-name><command-args>high</command-args>"))
    .toEqual({ text: "/code-review high", skill: { name: "code-review", evidence: "invocation", status: "requested" } });
  expect(claudeCommandEcho("<command-message>simplify</command-message><command-name>/simplify</command-name><command-args></command-args>")?.skill.name).toBe("simplify");
});

test("keeps angle brackets in the recorded arguments", () => {
  expect(claudeCommandEcho("<command-message>probe-skill</command-message>\n<command-name>/probe-skill</command-name>\n<command-args>read <path> if x < y</command-args>")?.text).toBe("/probe-skill read <path> if x < y");
});
})

test.describe('ovis server/skill-activity.test.ts', () => {
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const response = (payload: unknown) => ({ type: "response_item", timestamp: "2026-09-27T00:00:01Z", payload });
const prompt = response({ type: "message", role: "user", content: [{ type: "input_text", text: "Please review" }] });
const envelope = "<skill>\n<name>review</name>\n<path>/skills/review/SKILL.md</path>\nPRIVATE INSTRUCTIONS\n</skill>";
const selected = response({ type: "message", role: "user", content: [{ type: "input_text", text: envelope }] });
const call = (id: string, skill: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } });
const result = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: isError ? "Unavailable" : "Launching skill", is_error: isError }] } });
test("Claude records skill request, invocation and failure without claiming task completion", () => {
  const first = parseClaudeTranscript(lines([call("one", "plugin:review")]));
  expect(turnSkills(first[0]!.parts)).toEqual([{ name: "plugin:review", evidence: "invocation", status: "requested" }]);
  const complete = parseClaudeTranscript(lines([call("one", "plugin:review"), result("one"), call("two", "deploy"), result("two", true)]));
  expect(turnSkills(complete[0]!.parts)).toEqual([
    { name: "plugin:review", evidence: "invocation", status: "loaded" },
    { name: "deploy", evidence: "invocation", status: "failed" },
  ]);
  expect(workSummary(complete[0]!.parts)).toBe("2 skills");
  expect(workFailed(complete[0]!.parts)).toBe(1);
  expect(complete[0]?.parts[0]).toMatchObject({ kind: "tool", summary: "plugin:review", input: expect.stringContaining("plugin:review") });
  const mention = parseClaudeTranscript(lines([{ type: "assistant", message: { content: [{ type: "text", text: "Maybe use review" }, { type: "tool_use", name: "Read", input: { file_path: "/notes/review.txt" } }] } }]));
  expect(turnSkills(mention[0]!.parts)).toEqual([]);
});
test("Codex selected instructions become assistant skill evidence, not a user bubble or exposed prompt", () => {
  const turns = parseCodexTranscript(lines([prompt, selected, selected, response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Reviewed" }] })]));
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turnSkills(turns[1]!.parts)).toEqual([{ name: "review", path: "/skills/review/SKILL.md", evidence: "instructions", status: "loaded" }]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE INSTRUCTIONS");
  const mixed = parseCodexTranscript(lines([response({ type: "message", role: "user", content: [{ type: "input_text", text: "Actual prompt" }, { type: "input_text", text: envelope }] })]));
  expect(mixed.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(selectedSkill("Please explain " + envelope)).toBeNull();
  expect(selectedSkill(envelope.slice(0, -8))).toBeNull();
  expect(selectedSkill("<skills_instructions>available skills</skills_instructions>")).toBeNull();
});
test("Codex native completed read events work through code-mode wrappers, deduplicate and survive incremental snapshots", () => {
  const completed = { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-one", parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }], exit_code: 0, status: "completed" } } };
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt]));
  const before = parser.snapshot();
  parser.write(lines([completed, completed]));
  const after = parser.snapshot();
  expect(after).toEqual(parseCodexTranscript(lines([prompt, completed])));
  expect(after[1]!.parts).toHaveLength(1);
  expect(before).toHaveLength(1);
  expect(codexReadSkills({ ...completed.payload.item, parsed_cmd: [{ type: "unknown", cmd: "echo /skills/review/SKILL.md" }] })).toEqual([]);
  expect(codexReadSkills({ ...completed.payload.item, exit_code: 1, status: "failed" })[0]?.status).toBe("failed");
  expect(codexReadSkills({ ...completed.payload.item, status: "in_progress" })).toEqual([]);
});
test("Codex literal read calls update immutable snapshots on success/failure and ignore shell lookalikes", () => {
  const read = response({ type: "function_call", name: "exec_command", call_id: "one", arguments: JSON.stringify({ cmd: "cat '/skills/review/SKILL.md'" }) });
  const done = response({ type: "function_call_output", call_id: "one", output: "Process exited with code 1\nNo such file" });
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt, read]));
  const pending = parser.snapshot();
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  parser.write(lines([done]));
  expect(turnSkills(parser.snapshot()[1]!.parts)[0]?.status).toBe("failed");
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  for (const cmd of ["echo /skills/review/SKILL.md", "rg SKILL.md /skills", "cat $ROOT/review/SKILL.md", "cat /skills/review/SKILL.md > /tmp/out", "printf 'cat /skills/review/SKILL.md'", "cat /notes/README.md", "git diff -- /skills/review/SKILL.md"]) {
    expect(codexReadCall("exec_command", { cmd })).toBeNull();
  }
  expect(codexReadCall("exec_command", { cmd: "sed -n '1,220p' /skills/review/SKILL.md" })?.name).toBe("review");
});
test("skill evidence is scoped to each turn and clear removes previous Claude skill activity", () => {
  const clear = { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } };
  expect(parseClaudeTranscript(lines([call("one", "review"), result("one"), clear]))).toEqual([]);
  const turns = parseCodexTranscript(lines([prompt, selected, response({ type: "message", role: "user", content: "Another request" }), response({ type: "message", role: "assistant", content: "No skill" })]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});
test("late native read events from another Codex turn do not attach to the current answer", () => {
  const turns = parseCodexTranscript(lines([
    { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
    prompt,
    { type: "event_msg", payload: { type: "item_completed", turn_id: "old", item: { type: "CommandExecution", id: "late", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/old/SKILL.md" }] } } },
    response({ type: "message", role: "assistant", content: "Current answer" }),
  ]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});
test("Codex tool and native read records count one skill and keep the tool output", () => {
  const turns = parseCodexTranscript(lines([
    prompt,
    response({ type: "function_call", name: "exec_command", call_id: "read", arguments: '{"cmd":"cat /skills/review/SKILL.md"}' }),
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "native-read", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }] } } },
    response({ type: "function_call_output", call_id: "read", output: "Process exited with code 0\nInstructions" }),
  ]));
  expect(turns[1]!.parts).toHaveLength(1);
  expect(turnSkills(turns[1]!.parts)).toHaveLength(1);
  expect(workSummary(turns[1]!.parts)).toBe("1 skill");
  expect(turns[1]!.parts[0]).toMatchObject({ output: expect.stringContaining("Instructions"), skill: { status: "loaded" } });
});

const invoked = (name: string, location = `/home/u/.omo/skills/${name}/SKILL.md`) =>
  `The user explicitly invoked the "${name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${name}" location="${location}">\nReferences are relative to /home/u/.omo/skills/${name}.\n\nPRIVATE ${name} INSTRUCTIONS\n</skill-instruction>`;
const loaded = (name: string): SkillActivity => ({ name, path: `/home/u/.omo/skills/${name}/SKILL.md`, evidence: "instructions", status: "loaded" });
const piUser = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const piAnswer = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text }] } });
})

test.describe('ovis server/chat-history.test.ts', () => {
  const claudeClear = { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>" } };
  // ovis's omp/Pi lines (`isContextClear(clear, "omp-transcript")`) are left out: the Pi readers are not ported.
  test("only explicit complete reset records clear history; compaction and quoted commands do not", () => {
    expect(isContextClear(claudeClear, "claude-transcript")).toBe(true);
    for (const content of ["Please explain /clear", "<command-name>/clear", "quoted <command-name>/clear</command-name>", "<command-name>/clear</command-name>\nextra", "<command-name>/clear</command-name>\n<command-args>argument</command-args>"]) {
      expect(isContextClear({ ...claudeClear, message: { role: "user", content } }, "claude-transcript")).toBe(false);
    }
    expect(isContextClear({ ...claudeClear, isCompactSummary: true }, "claude-transcript")).toBe(false);
    expect(isContextClear({ ...claudeClear, isMeta: true }, "claude-transcript")).toBe(false);
    expect(isContextClear({ type: "custom", customType: "context_clear" }, "codex-transcript")).toBe(false);
  });

  // from "reset scanning crosses chunk boundaries ...": only its final Claude assertion; the rest reads files through transcriptPage.
  test("reset scanning crosses chunk boundaries, excludes pre-clear full outputs and pending tools (claude clear line only)", () => {
    const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const claude = jsonl([{ type: "user", message: { role: "user", content: "old" } }, claudeClear]);
    expect(parseClaudeTranscript(claude)).toEqual([]);
  });
});
