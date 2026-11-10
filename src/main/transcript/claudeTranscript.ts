// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/claude-transcript.ts — near verbatim (kept in ovis formatting so its fixes can be re-applied file by file).
// Changes: imports point at this folder and src/shared/conversation; OmoTaskResult is TaskResult.
import type { ConversationPart, ConversationTurn, TaskResult as OmoTaskResult } from "../../shared/conversation";
import { claudeCommandEcho, invokedSkill } from "./skillActivity";
import { agentTaskResult, claudePeerId, claudePeerNotice, isContextClear, MAX_TURNS, OMO_TASK_RESULT_MAX, toolSummary, type TranscriptParser } from "./records";
import { taskNotification, type SubagentDetail } from "./subagents";
import { trimOutput } from "./toolOutput";
import { base64Size, inlineImageType, MAX_IMAGE_BYTES } from "./images";

/** Slash-command and bookkeeping entries Claude logs as user turns — not conversations. */
export function isCommandEntry(text: string, entry: { origin?: unknown; permissionMode?: unknown }): boolean {
  if (claudeCommandEcho(text)) return false;
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-")
    // bash-mode output, only as the whole entry: the parser joins it to its command
    || (!("origin" in entry) && !("permissionMode" in entry) && text.trimStart().startsWith("<bash-std") && taggedStreams(text, "bash") !== null);
}

/**
 * What a slash command printed, from the `local_command` entry Claude Code records it in. The
 * command's echo (`<command-name>…`) is a separate entry with no output tag, and reads as nothing.
 */
/** A command's answer is a notice, not a log: the rest of a long one stays in the terminal. */
const LOCAL_COMMAND_MAX_CHARS = 4000;

function localCommandOutput(content: unknown): string {
  return capNotice((taggedStreams(content, "local-command") ?? []).map(({ text }) => text.trim()).filter((text) => text.length > 0).join("\n"));
}

/** What a slash command printed to stdout, terminal controls stripped, when the whole entry is its output. */
export function localCommandStdout(content: unknown): string | null {
  const streams = taggedStreams(content, "local-command");
  return streams === null ? null : streams.filter(({ stream }) => stream === "stdout").map(({ text }) => text.trim()).join("\n");
}

/** Bash payloads are opaque: only an unambiguous boundary identifies stderr. */
function bashStreams(content: string): { stream: "stdout" | "stderr"; text: string }[] | null {
  const envelope = content.trim();
  if (envelope.startsWith("<bash-stdout>") && envelope.endsWith("</bash-stderr>")) {
    const inner = envelope.slice("<bash-stdout>".length, -"</bash-stderr>".length);
    const candidates = [...inner.matchAll(/<\/bash-stdout>\s*<bash-stderr>/g)];
    const first = candidates[0];
    if (first === undefined) return null;
    if (candidates.length === 1) {
      return [
        { stream: "stdout", text: stripTerminalControls(inner.slice(0, first.index)).trimEnd() },
        { stream: "stderr", text: stripTerminalControls(inner.slice(first.index + first[0].length)).trimEnd() },
      ];
    }
    // Multiple boundaries never establish stderr: retain every inner character verbatim.
    return [{ stream: "stdout", text: stripTerminalControls(inner) }];
  }
  // Older records can carry a single stream, but not reordered or partial envelopes.
  const single = /^<bash-(stdout|stderr)>([\s\S]*)<\/bash-\1>$/.exec(envelope);
  const stream = single?.[1], text = single?.[2];
  return (stream === "stdout" || stream === "stderr") && text !== undefined
    ? [{ stream, text: stripTerminalControls(text).trimEnd() }] : null;
}

/**
 * The streams a whole entry holds, `<{tag}-stdout>…</{tag}-stdout>` and `<{tag}-stderr>…`, in order and with
 * terminal controls stripped; ambiguous bash output stays verbatim in stdout. Null when the entry
 * holds anything else.
 */
function taggedStreams(content: unknown, tag: "local-command" | "bash"): { stream: "stdout" | "stderr"; text: string }[] | null {
  if (typeof content !== "string") return null;
  if (tag === "bash") return bashStreams(content);
  // the whole entry is the output, one stream after another: a tag quoted inside an echo's
  // arguments is not an answer
  const streams: { stream: "stdout" | "stderr"; text: string }[] = [];
  let at = 0;
  for (;;) {
    while (at < content.length && /\s/.test(content[at]!)) at++;
    if (at === content.length) break;
    const stream = content.startsWith(`<${tag}-stdout>`, at) ? "stdout" : content.startsWith(`<${tag}-stderr>`, at) ? "stderr" : null;
    if (stream === null) return null;
    const start = at + `<${tag}-${stream}>`.length;
    // a closing tag the output prints itself ends nothing: the stream's own one is at the end of
    // the entry or before the next stream. Each candidate looks only at the whitespace after it.
    const close = `</${tag}-${stream}>`;
    let end = content.indexOf(close, start);
    let next = 0;
    while (end !== -1) {
      next = end + close.length;
      while (next < content.length && /\s/.test(content[next]!)) next++;
      if (next === content.length || content.startsWith(`<${tag}-stdout>`, next) || content.startsWith(`<${tag}-stderr>`, next)) break;
      end = content.indexOf(close, end + close.length);
    }
    if (end === -1) return null;
    streams.push({ stream, text: stripTerminalControls(content.slice(start, end)) });
    at = next;
  }
  return streams;
}

/** The command of a bash-mode entry (`!` in Claude Code): the whole entry is `<bash-input>…</bash-input>`. */
const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/;

/** Lines of one notice Claude Code writes as separate entries, a moment apart. */
const NOTICE_JOIN_MS = 1000;

/** A notice is not a log: past the cap the rest stays in the terminal, also for lines joined into one. */
function capNotice(text: string): string {
  return text.length > LOCAL_COMMAND_MAX_CHARS ? `${text.slice(0, LOCAL_COMMAND_MAX_CHARS)}\u2026` : text;
}

/** The notice a turn is, when it is nothing else. */
function loneNotice(turn: ConversationTurn | undefined): Extract<ConversationPart, { kind: "notice" }> | null {
  const part = turn?.parts.length === 1 ? turn.parts[0] : undefined;
  return part?.kind === "notice" ? part : null;
}

/** Were these two entries written together? Never when either has no readable time. */
function writtenTogether(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= NOTICE_JOIN_MS;
}

/**
 * Claude Code versions differ in where a refused command goes: a `local_command` answer, an
 * `informational` entry, and nothing says one never writes both. The same words from the other
 * kind, written together, are one answer; a notice repeating its own kind is kept.
 */
function saidByOtherKind(turn: ConversationTurn | undefined, text: string, ts: string | null, kind: "local-command" | "informational"): boolean {
  const said = loneNotice(turn);
  if (said === null || said.source === kind || (said.source !== "local-command" && said.source !== "informational")) return false;
  return writtenTogether(turn?.ts, ts) && (said.text === text || said.text.split("\n").includes(text));
}

/**
 * The text of terminal output without its escape codes (colours, links, cursor moves, charset
 * switches) and other controls, in one pass: a sequence cut off by the end swallows the rest,
 * and malformed input never makes it rescan what follows.
 */
function stripTerminalControls(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      // tab and newline are text; every other C0 control and DEL is not
      if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) out += input[i];
      i++;
      continue;
    }
    const kind = input[i + 1];
    if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      // a string (OSC, DCS, SOS, PM, APC) ends at BEL or ST; another ESC ends it too
      i += 2;
      while (i < input.length && input.charCodeAt(i) !== 0x07 && input.charCodeAt(i) !== 0x1b) i++;
      if (input.charCodeAt(i) === 0x07) i++;
      else if (input[i + 1] === "\\") i += 2;
    } else if (kind === "[") {
      // CSI: parameters, intermediates, one final byte
      i += 2;
      while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e) i++;
    } else {
      // ESC, intermediates (as in ESC ( B), then one final byte
      i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
    }
  }
  return out;
}

/**
 * Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can
 * tell it from typed text; its own TUI shows only the text, and so does the chat.
 */
export function unwrapPastes(text: string): string {
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/g,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/g, "") : text;
}

/**
 * senpi (OmO's engine, its anthropic-subscription provider) runs Claude Code through the SDK but runs
 * the tools on its own host: Claude Code records each call with senpi's PreToolUse denial as its
 * result, then senpi sends the host's result as the next prompt's text, one
 * `Tool result (<tool>, id=<call id>):\n` block before the result's own blocks, and a block that is
 * exactly "\n\n" between that and the next message it sends along (session-sync.ts
 * buildDeltaPromptBlocks). The result is the call's, not anything the person typed.
 */
const HOST_RESULT_HEADER = /^Tool result \((.+), id=([A-Za-z0-9_-]{1,128})\):\n$/;
const HOST_MESSAGE_BREAK = "\n\n";
/** senpi's denial, in each wording it has shipped: the host runs the tool, and this is not its result */
const HOST_HANDOFF = /^PreToolUse:\S+ hook error: [\s\S]*\bSenpi (?:executes|runs) this tool on the host and returns its result as the next user message\b/;

/** One host tool result in a prompt's blocks: the call it answers, its header's index, and the end of its blocks (exclusive). */
export interface HostToolResult { name: string; id: string; header: number; end: number }

const isTextBlock = (block: unknown, text?: string): block is { type: "text"; text: string } =>
  typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
  && typeof (block as { text?: unknown }).text === "string" && (text === undefined || (block as { text: string }).text === text);

/**
 * The host tool results a prompt's blocks carry, in order. Only a message's first block can be a
 * header: one quoted inside a message's text, or inside another result, is that message's words.
 */
export function hostToolResults(content: readonly unknown[]): HostToolResult[] {
  const results: HostToolResult[] = [];
  for (let start = 0; start < content.length;) {
    let end = start;
    while (end < content.length && !isTextBlock(content[end], HOST_MESSAGE_BREAK)) end++;
    const header = content[start];
    const match = isTextBlock(header) ? HOST_RESULT_HEADER.exec(header.text) : null;
    if (match !== null) results.push({ name: match[1]!, id: match[2]!, header: start, end });
    start = end + 1;
  }
  return results;
}

/**
 * The host tool results of an entry: only a program's prompt (the SDK's) carries them, so a person at
 * Claude Code's own prompt only quotes one.
 */
export function entryHostToolResults(entry: { type?: unknown; promptSource?: unknown; entrypoint?: unknown }, content: unknown): HostToolResult[] {
  const sdk = entry.promptSource === "sdk" || (typeof entry.entrypoint === "string" && entry.entrypoint.startsWith("sdk"));
  return sdk && entry.type === "user" && Array.isArray(content) ? hostToolResults(content) : [];
}

/** The blocks host results take in a prompt, the breaks around them included: the rest is the prompt's own. */
function hostedBlocks(results: readonly HostToolResult[]): Set<number> {
  const hosted = new Set<number>();
  for (const host of results) for (let at = host.header - 1; at <= host.end; at++) hosted.add(at);
  return hosted;
}

/** senpi's denial of a call it runs on its host: the result comes later, as a host tool result. */
export function isHostHandoff(result: { content?: unknown; is_error?: unknown }): boolean {
  return result.is_error === true && HOST_HANDOFF.test(claudeResultText(result.content));
}

/**
 * senpi's own messages in an SDK prompt. It sends what it tells the model in the person's seat, each
 * message in blocks of its own, and marks none of them, so they are known by the wrappers senpi and
 * OmO write: reminders and monitor events, Kibitzer's memory notes, memory, goal and stream-rule
 * checks, OmO's mode pointers and environment, Kibitzer's own prompts, a team member's message.
 * A block holding anything besides such wrappers is the person's, whole.
 */
const SENPI_WRAPPERS = new Set([
  "system-reminder", "recalled-memory", "memory_notice", "goal_stall_check", "system-interrupt", "environment_context",
  "ultrawork-mode", "kibitzer-wake", "kibitzer-seed", "kibitzer-reseed", "peer_message",
]);
const isSenpiWrapper = (tag: string): boolean => SENPI_WRAPPERS.has(tag) || /^omo-[a-z0-9-]+$/.test(tag);
const WRAPPED = /^\s*<([A-Za-z_][\w-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>\s*/;
/** a notification senpi cut short: the reminder, then where the rest of it went, in the same block */
const TAIL_CAPPED = /^\[…notification tail capped…\]\nBuffered output overflowed; full output: \S+(?:\s*$|\n\n)/;
/** the goal extension's continuation prompt (goal/prompt.js), after a stall check when there is one */
const GOAL_CONTINUATION = "Continue working toward the active thread goal.\n";
const isGoalContinuation = (text: string): boolean =>
  text.startsWith(GOAL_CONTINUATION) && text.includes("\n<untrusted_objective>\n") && text.includes("\n</untrusted_objective>\n");
/** a fresh session's replay of the history before it (prompt-bridge.js buildPromptBlocks) */
const HISTORY_OPENER = "<conversation_history>\n";
const HISTORY_CLOSER = "\n</conversation_history>";
const RECOVERED_OPENER = "<recovered_tool_results>\n";
const RECOVERED_CLOSER = "\n</recovered_tool_results>";
/** the instruction after the replay, in each wording senpi ships: to answer the message below, or to go on with a turn */
const HISTORY_INSTRUCTIONS = new Set([
  "The above is the conversation history so far, provided as context. Respond as the assistant to the user message below only. Never emit \"USER:\" or \"ASSISTANT:\" labels or continue the transcript.",
  "The above is the conversation history so far, provided as context. There is no new user message: the last entries are results of tool calls you made in your current turn, not anything the user sent. Continue that turn as the assistant. Never emit \"USER:\" or \"ASSISTANT:\" labels or continue the transcript.",
]);
/**
 * OmO's report of a background task that ended: `task completion name:… id:st_… <fields> status:… duration:…`,
 * then `result:"…"`, then `next:` naming how to reach the task
 */
const TASK_COMPLETION = /^task completion (?:\(resumed turn\) )?name:(\S+) id:(st_[A-Za-z0-9_-]+) ((?:[^\n]* )?status:\S+ duration:[^\n]*)\nresult:"/;

/**
 * OmO's report of a task that ended at the start of a block, as the card OmO's own transcript shows,
 * and how much of the block it takes; null when the block does not start with a whole report.
 */
function senpiTaskReport(text: string): { task: OmoTaskResult; length: number } | null {
  const head = TASK_COMPLETION.exec(text);
  if (head === null) return null;
  const [line, name, id, fields] = head as unknown as [string, string, string, string];
  // the report ends with its closing quote, a `result_file:` line when OmO kept the whole result,
  // and the `next:` line naming this task; then the block ends or senpi's next message follows
  const trailer = new RegExp(`"\\n(?:result_file:\\S+\\n)?next:Use task_send\\(\\{ to: "${id}", message: "\\.\\.\\." \\}\\) to continue\\.(?=$|\\n\\n)`, "g");
  trailer.lastIndex = line.length;
  const closing = trailer.exec(text);
  // a report with no `next:` line is the rest of the block, up to its closing quote
  const end = closing !== null ? closing.index : text.length > line.length && text.endsWith("\"") ? text.length - 1 : -1;
  if (end === -1) return null;
  const result = text.slice(line.length, end);
  const field = (key: string): string | null => new RegExp(`(?:^| )${key}:(\\S+)`).exec(fields)?.[1] ?? null;
  const count = (key: string): number | null => { const value = field(key); return value !== null && /^\d+$/.test(value) ? Number(value) : null; };
  // `agent:explore(<model>)` or `category:deep-low(<model>)`; a fallback names the model that ran last: `fallback:<id>-><name>`
  const ran = /(?:^| )(?:agent|category):([^\s(]+)(?:\(([^)\s]*)\))?/.exec(fields);
  const model = / fallback:\S*->(.+?) status:/.exec(fields)?.[1] ?? ran?.[2] ?? null;
  const raw = field("status");
  // `3m 20s`, `4.2s`, `1h 2m`, `850ms`
  const spent = /(?:^| )duration:(.+?)(?= tokens:| tools:| tps:|$)/.exec(fields)?.[1];
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  const parts = spent === undefined ? [] : [...spent.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)\b/g)];
  const duration = parts.length === 0 ? null : Math.round(parts.reduce((sum, [, amount, unit]) => sum + Number(amount) * units[unit!]!, 0));
  const agent = ran?.[1] ?? null;
  const task: OmoTaskResult = {
    id,
    title: name !== id ? name : agent ?? id,
    agent,
    model,
    status: raw === "completed" ? "completed" : raw === "cancelled" || raw === "canceled" || raw === "aborted" ? "cancelled" : "failed",
    duration_ms: duration,
    turns: null,
    tool_calls: count("tools"),
    tokens: count("tokens"),
    result: result.slice(0, OMO_TASK_RESULT_MAX),
    ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
  };
  return { task, length: closing !== null ? closing.index + closing[0].length : text.length };
}

type Notice = Extract<ConversationPart, { kind: "notice" }>;
type TaskResults = Extract<ConversationPart, { kind: "task_result" }>;

/**
 * A block made only of senpi's own messages (it can join several with a blank line): the reports and
 * team members' messages among them, in order, or null when the block holds anything else.
 */
function senpiMessages(text: string): (OmoTaskResult | Notice)[] | null {
  const found: (OmoTaskResult | Notice)[] = [];
  let rest = text;
  while (rest.length > 0) {
    const report = senpiTaskReport(rest);
    if (report !== null) {
      found.push(report.task);
      rest = rest.slice(report.length).replace(/^\n\n/, "");
      continue;
    }
    // the end of a notification senpi cut short, after its reminder
    const capped = rest !== text ? TAIL_CAPPED.exec(rest) : null;
    if (capped !== null) {
      rest = rest.slice(capped[0].length);
      continue;
    }
    const match = WRAPPED.exec(rest);
    if (match === null || match[0].length === 0 || !isSenpiWrapper(match[1]!)) break;
    if (match[1] === "peer_message") {
      const body = match[3]!.trim();
      const from = /\bfrom="([^"]*)"/.exec(match[2] ?? "")?.[1]?.trim() ?? "";
      if (body.length > 0) found.push({ kind: "notice", text: body, source: `peer:${from}` });
    }
    rest = rest.slice(match[0].length);
  }
  if (rest === text) return null;
  return rest.trim() === "" || isGoalContinuation(rest) ? found : null;
}

/** What senpi itself put in an SDK prompt, beside what a person or a lead sent. */
export interface SenpiPrompt {
  /** a program sent it through Claude Code's SDK */
  sdk: boolean;
  hosts: HostToolResult[];
  /** the prompt's blocks with senpi's own as null, and each break between its messages as an empty text */
  own: unknown[];
  /**
   * In the order senpi sent them: OmO's reports of tasks that ended, drawn as the card OmO's own
   * transcript draws, and team members' messages, drawn as another session's
   */
  notices: (TaskResults | Notice)[];
}

/** Where a fresh session's replay ends: the instruction after it (and after any recovered results), or -1. */
function replayEnd(content: readonly unknown[]): number {
  const instruction = (at: number): boolean => isTextBlock(content[at]) && HISTORY_INSTRUCTIONS.has(content[at].text);
  // no history to replay: the instruction alone
  if (instruction(0)) return 0;
  if (!isTextBlock(content[0], HISTORY_OPENER)) return -1;
  // the first closer the instruction follows (a replayed message can hold a closer of its own)
  for (let at = 2; at < content.length; at++) {
    if (!instruction(at)) continue;
    if (isTextBlock(content[at - 1], HISTORY_CLOSER)) return at;
    if (!isTextBlock(content[at - 1], RECOVERED_CLOSER)) continue;
    let opener = at - 2;
    while (opener > 0 && !isTextBlock(content[opener], RECOVERED_OPENER)) opener--;
    if (opener > 0 && isTextBlock(content[opener - 1], HISTORY_CLOSER)) return at;
  }
  return -1;
}

/** Only a program's prompt (the SDK's) carries senpi's messages: a person at Claude Code's own prompt only quotes one. */
export function senpiPrompt(entry: { type?: unknown; promptSource?: unknown; entrypoint?: unknown }, content: unknown): SenpiPrompt {
  const hosts = entryHostToolResults(entry, content);
  if (!Array.isArray(content) || !(entry.promptSource === "sdk" || (typeof entry.entrypoint === "string" && entry.entrypoint.startsWith("sdk")))) {
    return { sdk: false, hosts, own: Array.isArray(content) ? content : [], notices: [] };
  }
  const senpi = hostedBlocks(hosts);
  for (let at = replayEnd(content); at >= 0; at--) senpi.add(at);
  const notices: (TaskResults | Notice)[] = [];
  const own = content.map((block, at) => {
    if (senpi.has(at)) return null;
    if (!isTextBlock(block)) return block;
    if (block.text === HOST_MESSAGE_BREAK) return { type: "text", text: "" };
    if (isGoalContinuation(block.text)) return null;
    const messages = senpiMessages(block.text);
    if (messages === null) return block;
    for (const message of messages) {
      if ("kind" in message) { notices.push(message); continue; }
      // reports sent one after another share one card, as OmO's own wake does
      const last = notices.at(-1);
      if (last?.kind === "task_result") last.tasks.push(message); else notices.push({ kind: "task_result", tasks: [message] });
    }
    return null;
  });
  return { sdk: true, hosts, own, notices };
}

/** A parsed JSONL line's message shape (only the fields we read). */
export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  operation?: string;
  /** a `system` entry's own text; a message's is under `message` */
  content?: unknown;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: unknown;
  permissionMode?: unknown;
  /** "sdk" (with an `sdk-…` entrypoint): a program sent the prompt through Claude Code's SDK, not a person at its prompt */
  promptSource?: unknown;
  entrypoint?: unknown;
  /** "updates": Claude Code shows the entry's thinking text as a progress message, not as reasoning */
  thinkingDisplay?: unknown;
  message?: { role?: string; content?: unknown; stop_reason?: unknown };
  /** a `turn_duration` entry: how long the turn took */
  durationMs?: unknown;
  attachment?: { type?: unknown; prompt?: unknown; commandMode?: unknown; origin?: { kind?: unknown } };
}

export function claudeResultText(output: unknown): string {
  return typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";
}

/**
 * A Claude image's ref: the entry, the block, and for a picture a tool returned its place in the
 * result. The parser names only what transcriptImage can read back by it.
 */
export const CLAUDE_IMAGE_REF = /^([0-9a-f-]{8,64}):(\d{1,3})(?::(\d{1,3}))?$/i;

/**
 * The type of a picture Claude Code holds inline (pasted into a prompt, or a Read of an image
 * file), by its leading bytes: a raster the chat shows, within the size the image endpoint serves.
 * Null for anything else, so the page and the endpoint agree on what is a picture.
 */
export function claudeImageType(block: unknown): string | null {
  const image = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null | undefined;
  if (image?.type !== "image" || image.source?.type !== "base64") return null;
  return inlineImageType(image.source.media_type, image.source.data);
}

/**
 * A record with its inline pictures cut to what claudeImageType reads of them: their first bytes,
 * or none past the size the endpoint serves. A screenshot can make a prompt megabytes long, and its
 * bytes say nothing of where the record hangs in the session.
 */
export function withoutPictureBytes(text: string): string {
  return text.replace(/("(?:data|base64)"\s*:\s*")([A-Za-z0-9+/]*={0,2})"/g,
    (_whole: string, key: string, data: string) => `${key}${base64Size(data) > MAX_IMAGE_BYTES ? "" : data.slice(0, 16)}"`);
}

function claudeImageRef(uuid: unknown, ...at: number[]): string | null {
  if (typeof uuid !== "string") return null;
  const ref = [uuid, ...at].join(":");
  return CLAUDE_IMAGE_REF.test(ref) ? ref : null;
}

/**
 * The pictures among blocks, each named by the entry, the places that lead to the blocks (none for a
 * prompt's own, the result's for a tool's) and its own: named here, fetched only when shown.
 */
export function claudeImages(uuid: unknown, blocks: readonly unknown[], ...at: number[]): { media_type: string; ref: string }[] {
  return blocks.flatMap((block, index) => {
    const mediaType = claudeImageType(block);
    const ref = mediaType === null ? null : claudeImageRef(uuid, ...at, index);
    return mediaType === null || ref === null ? [] : [{ media_type: mediaType, ref }];
  });
}

interface ClaudeTranscriptOptions {
  subagents?: ReadonlyMap<string, SubagentDetail>;
  noticed?: Set<string>;
}

interface ClaudeParseState {
  turns: ConversationTurn[];
  /** Tool parts still waiting for their result, by tool_use id. */
  pending: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  /** Every tool part by its tool_use id: a host tool result answers its call after Claude Code's own result did. */
  calls: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  /** The agent's last entry called a tool: its turn is not over. */
  atWork: boolean;
  /** Injected feedback can resume the model after a completed reply. */
  completed: boolean;
  noticed: Set<string>;
  lastPrompt: { turn: ConversationTurn; parent: string | null | undefined; answered: boolean } | null;
  peersSeen: Set<string>;
}

function claudeParseState(options: ClaudeTranscriptOptions): ClaudeParseState {
  return {
    turns: [], pending: new Map(), calls: new Map(), atWork: false, completed: false,
    noticed: options.noticed ?? new Set(), lastPrompt: null, peersSeen: new Set(),
  };
}

/**
 * Incrementally splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 *
 * A subagent that ended (its `<task-notification>`) is drawn as a task_result in the user's seat,
 * once however many records carry it; `options.subagents` holds what the subagents' own files say
 * of them, by agent id, since the parser reads no files. Other notifications stay hidden.
 */
export function createClaudeTranscriptParser(options: ClaudeTranscriptOptions = {}): TranscriptParser {
  return claudeTranscriptParser(options, claudeParseState(options));
}

function claudeTranscriptParser(options: ClaudeTranscriptOptions, state: ClaudeParseState): TranscriptParser {
  const { turns, pending, calls, noticed, peersSeen } = state;
  /** Where a notice goes: before the turn at work it was written in, else at the end. */
  const noticeAt = (): number => state.atWork && turns.at(-1)?.role === "assistant" ? turns.length - 1 : turns.length;
  /** True when the block was a notification (shown or not): it is no turn of anyone's typing. */
  const notified = (block: string, ts: string | null): boolean => {
    const notice = taskNotification(block);
    if (notice === null) return false;
    const key = `${notice.taskId}\0${notice.toolUseId ?? ""}`;
    if (notice.agent && !noticed.has(key)) {
      noticed.add(key);
      turns.splice(noticeAt(), 0, { role: "user", ts, parts: [{ kind: "task_result", tasks: [agentTaskResult(notice, options.subagents?.get(notice.taskId))] }] });
    }
    return true;
  };

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !state.completed) return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  /** The answer a turn-end record belongs to: the last agent turn, past notices written after it; none
   *  when a person's prompt came after it. */
  const answerBefore = (): ConversationTurn | undefined => {
    for (let at = turns.length - 1; at >= 0; at--) {
      const turn = turns[at];
      if (turn.role === "assistant") return turn;
      if (!turn.parts.every((part) => part.kind === "notice" || part.kind === "task_result")) return undefined;
    }
    return undefined;
  };

  /** the last human prompt and the entry it hangs from: a send Claude Code cancelled before
   *  any reply is re-sent as a sibling of it, and its own screen shows only the re-send */
  const pushPrompt = (turn: ConversationTurn, entry: TranscriptEntry): void => {
    const { lastPrompt } = state;
    if (lastPrompt !== null && !lastPrompt.answered && typeof entry.parentUuid === "string" && entry.parentUuid === lastPrompt.parent) {
      const index = turns.indexOf(lastPrompt.turn);
      if (index !== -1) turns.splice(index, 1);
    }
    turns.push(turn);
    state.lastPrompt = { turn, parent: entry.parentUuid, answered: false };
  };
  const markPromptAnswered = (): void => {
    if (state.lastPrompt !== null) state.lastPrompt.answered = true;
  };

  const fold = (entry: TranscriptEntry): void => {
    // another session's message: its own turn, so the work it started is not appended to the answer before it
    const peer = claudePeerNotice(entry);
    if (peer !== null) {
      const id = claudePeerId(entry);
      if (id !== null) { if (peersSeen.has(id)) return; peersSeen.add(id); }
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [peer] });
      return;
    }
    if (entry.isMeta) return;
    if (isContextClear(entry, "claude-transcript")) { turns.length = 0; pending.clear(); calls.clear(); state.lastPrompt = null; return; }
    const content = entry.message?.content;
    // a compaction's summary marks where the conversation was folded, readable on request
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("\n") : "";
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      return;
    }

    // A message sent while Claude is working is no `user` entry: it is queued, then recorded
    // as this attachment when the turn takes it in. Background task notices and other agents'
    // messages use the same record, so only a person's prompt counts. The `queue-operation`
    // lines around a prompt repeat it; a task completion can arrive only in its enqueue.
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string" && notified(entry.content, entry.timestamp ?? null)) return;
    const queued = entry.type === "attachment" ? entry.attachment : undefined;
    if (queued?.commandMode === "task-notification" && typeof queued.prompt === "string" && notified(queued.prompt, entry.timestamp ?? null)) return;
    if (queued?.type === "queued_command" && queued.commandMode === "prompt" && queued.origin?.kind === "human") {
      if (typeof queued.prompt === "string" && queued.prompt.trim() && !isCommandEntry(queued.prompt.trim(), queued)) {
        turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(queued.prompt) }] });
      }
      return;
    }

    // A slash command answers in the terminal, not through the model: a refused /goal says why
    // only here. It is the runtime speaking in the user's seat, so it reads as a notice.
    if (entry.type === "system" && entry.subtype === "local_command") {
      const output = localCommandOutput(entry.content);
      const at = noticeAt();
      if (output.length > 0 && !saidByOtherKind(turns[at - 1], output, entry.timestamp ?? null, "local-command")) turns.splice(at, 0, { role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "notice", text: output, source: "local-command" }] });
      return;
    }

    // The turn-end line (`✻ Crunched for 29s · done 2:14 PM`) and the idle recap (`※ recap: …`) are
    // records too, written after the answer: they hang on it, so the turn's shape does not change
    // (fb-1110 a0ba98c4 — the chat showed neither).
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      const answer = answerBefore();
      const ms = typeof entry.durationMs === "number" ? entry.durationMs : Number.NaN;
      if (answer && Number.isFinite(ms) && ms >= 0 && entry.timestamp) answer.done = { at: entry.timestamp, ms };
      return;
    }
    if (entry.type === "system" && entry.subtype === "away_summary") {
      const text = typeof entry.content === "string" ? capNotice(stripTerminalControls(entry.content).trim()) : "";
      const answer = answerBefore();
      if (answer && text.length > 0) answer.recap = text;
      return;
    }

    // Claude Code's own notices: an unknown slash command and the arguments it dropped (2.1.29x
    // writes these here, not as a local_command), a usage limit reached or reset. The message
    // that drew one is not recorded, so without it a refused command just vanished from the chat.
    // Lines written together read as one notice.
    // Claude Code also writes them while the agent works (a message another session held, a
    // stopped response): about half of the real ones. Such a notice does not end the turn: it
    // goes before the turn it was written in, so the turn stays whole and stays the last one,
    // which is what the chat reads as the turn still running.
    if (entry.type === "system" && entry.subtype === "informational") {
      const text = typeof entry.content === "string" ? capNotice(stripTerminalControls(entry.content).trim()) : "";
      if (text.length === 0) return;
      const ts = entry.timestamp ?? null;
      const at = noticeAt();
      const before = turns[at - 1];
      if (saidByOtherKind(before, text, ts, "informational")) return;
      const said = loneNotice(before);
      if (before && said?.source === "informational" && writtenTogether(before.ts, ts)) turns[at - 1] = { ...before, parts: [{ ...said, text: capNotice(`${said.text}\n${text}`) }] };
      else turns.splice(at, 0, { role: "user", ts, parts: [{ kind: "notice", text, source: "informational" }] });
      return;
    }

    if (entry.type === "user" && typeof content === "string") {
      if (notified(content, entry.timestamp ?? null)) return;
      const invocation = claudeCommandEcho(content);
      if (invocation) {
        pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: invocation.text }, { kind: "skill", skill: invocation.skill }] }, entry);
        return;
      }
      // bash mode: the command opens a turn like a prompt, and the entry after it holds what it printed
      const own = !("origin" in entry) && !("permissionMode" in entry);
      const command = own ? BASH_INPUT.exec(content)?.[1] : undefined;
      if (command !== undefined) {
        pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "shell", command }] }, entry);
        return;
      }
      const printed = own ? taggedStreams(content, "bash") : null;
      const shell = state.lastPrompt?.turn.parts[0];
      if (printed !== null && shell?.kind === "shell" && shell.stdout === undefined) {
        const of = (stream: "stdout" | "stderr") => capNotice(printed.filter((part) => part.stream === stream).map(({ text }) => text).join("\n"));
        shell.stdout = of("stdout");
        shell.stderr = of("stderr");
      }
      if (printed !== null) return;
      if (isCommandEntry(content, entry)) return;
      pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(content) }] }, entry);
      return;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      // the host's results of senpi's calls are the calls' output; what else the entry holds is still the prompt
      const sent = senpiPrompt(entry, content);
      for (const host of sent.hosts) {
        const call = calls.get(host.id);
        let tool: Extract<ConversationPart, { kind: "tool" }>;
        // the call id is Claude Code's own and unique; the header's name is senpi's mapping of it
        if (call !== undefined) tool = call;
        // a call this read never saw (before the window): still a tool's output by the header, so it
        // goes in the work, never in the person's seat
        else {
          tool = { kind: "tool", name: host.name, summary: host.name, input: "", output: "", call_id: host.id };
          assistantTurn(entry.timestamp).parts.push(tool);
        }
        const blocks = content.slice(host.header + 1, host.end);
        delete tool.output_ref; delete tool.output_size; delete tool.error;
        trimOutput(tool, claudeResultText(blocks), host.id);
        // senpi sends no failure flag with the result: like an empty result, it reads as done
        tool.state = "ok";
        if (tool.skill) tool.skill.status = "loaded";
        const pictures = blocks.flatMap((block, at) => {
          const mediaType = claudeImageType(block);
          const ref = mediaType === null ? null : claudeImageRef(entry.uuid, host.header + 1 + at);
          return mediaType === null || ref === null ? [] : [{ media_type: mediaType, ref }];
        });
        if (pictures.length > 0) tool.images = pictures; else delete tool.images;
      }
      // senpi's notices are no one's typing: a task that ended is its card, a team member's message is
      // theirs, and the rest is what senpi told the model, hidden as Claude Code's own reminders are
      const ts = entry.timestamp ?? null;
      for (const notice of sent.notices) turns.splice(noticeAt(), 0, { role: "user", ts, parts: [notice] });
      // the results, the breaks around them and senpi's notices were senpi's, not the person's
      const blocks = sent.own;
      const invocations: ConversationPart[] = [];
      const said = blocks.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const part = block as { type?: string; text?: unknown };
        // a notice can share an entry with a tool's result
        if (part.type === "text" && typeof part.text === "string" && notified(part.text, entry.timestamp ?? null)) return [];
        const invocation = part.type === "text" && typeof part.text === "string" ? claudeCommandEcho(part.text) : null;
        if (invocation) {
          invocations.push({ kind: "skill", skill: invocation.skill });
          return [invocation.text];
        }
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim(), entry) ? [part.text] : [];
      }).join("\n");
      // a notice before or after the person's words leaves its break behind
      const prompt = sent.sdk ? said.replace(/^\n+|\n+$/g, "") : said;
      for (const [index, block] of blocks.entries()) {
        if (typeof block !== "object" || block === null) continue;
        const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        // senpi took the call to its host: no outcome yet, and its output arrives as a host tool result
        if (isHostHandoff(result)) continue;
        trimOutput(tool, claudeResultText(result.content), result.tool_use_id);
        if (result.is_error === true) tool.error = true;
        // the result's flag, and only it, says how the call went: an empty result is still a success
        if (tool.call_id !== undefined) tool.state = result.is_error === true ? "error" : "ok";
        if (tool.skill) tool.skill.status = result.is_error === true ? "failed" : "loaded";
        // a picture the tool returned (a Read of an image file) sits inside its result
        const pictures = Array.isArray(result.content) ? claudeImages(entry.uuid, result.content, index) : [];
        if (pictures.length > 0) tool.images = pictures;
      }
      const images = claudeImages(entry.uuid, blocks).map((image) => ({ kind: "image" as const, ...image }));
      if (prompt.trim() || images.length > 0) pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [...images, ...(prompt.trim() ? [{ kind: "text" as const, text: unwrapPastes(prompt) }] : []), ...invocations] }, entry);
      return;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      markPromptAnswered();
      const turn = assistantTurn(entry.timestamp);
      // an entry that names no stop reason is still at work when it calls a tool
      const stop = entry.message?.stop_reason;
      state.completed = stop === "end_turn";
      state.atWork = stop === "tool_use" || (stop == null && content.some((block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_use"));
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text, ...(state.completed ? { phase: "final_answer" as const } : {}) });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          // the terminal prints an "updates" entry's thinking as narration between the tools, so it
          // is read as that: commentary keeps it in the work block, never taken for the answer
          if (thinking.trim().length > 0 && entry.thinkingDisplay === "updates") turn.parts.push({ kind: "text", text: thinking, phase: "commentary" });
          else if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          const skill = invokedSkill(b.name, input);
          if (skill) { part.skill = skill; part.summary = skill.name; }
          const id = (block as { id?: unknown }).id;
          // the native id, and pending until a tool_result answers it
          if (typeof id === "string" && id.length > 0) { part.call_id = id; part.state = "pending"; }
          turn.parts.push(part);
          pending.set(String(id ?? ""), part);
          if (typeof id === "string" && id.length > 0) calls.set(id, part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  };

  const write = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue; // a torn tail line while Claude is mid-append
      }
      if (entry !== null && typeof entry === "object") fold(entry);
    }
  };
  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      // Preview a valid final record without committing tools, prompt resends or dedup ids.
      // Clone the whole graph so pending tools and lastPrompt still refer to the cloned turns.
      if (tail.trim()) {
        const preview = structuredClone(state);
        claudeTranscriptParser(options, preview).write(tail);
        return preview.turns.filter((turn) => turn.parts.length > 0);
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

/** The one-shot API uses the same record fold as the live reader. */
export function parseClaudeTranscript(text: string, maxTurns = MAX_TURNS, options: ClaudeTranscriptOptions = {}): ConversationTurn[] {
  const state = claudeParseState(options);
  claudeTranscriptParser(options, state).write(text);
  // No writer survives this call, so its owned turns need no detached snapshot.
  return state.turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

