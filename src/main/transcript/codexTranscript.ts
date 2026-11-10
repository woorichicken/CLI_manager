// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/codex.ts lines 1-363 — the rollout parser only, near verbatim in ovis formatting. The rest of
// that file finds the rollout (bun:sqlite, herdr panes): CLI Manager already knows the thread id from its own
// CodexSessionLocator, so it is not ported. Pictures are not read (codexImageParts / codexOutputPictures return none).
import type { ConversationPart, ConversationTurn } from "../../shared/conversation";
import { patchFiles, patchText } from "./patch";
import { codexReadCall, codexReadSkills, selectedSkill } from "./skillActivity";
import { trimOutput } from "./toolOutput";
import type { TranscriptParser } from "./records";

/** Pictures attached to a Codex prompt: not read in this version (ovis reads local files and data URIs). */
const codexImageParts = (_entry: Record<string, unknown>): ConversationPart[] => [];
/** Pictures a Codex tool returned: not read in this version. */
const codexOutputPictures = (_output: unknown): { mediaType: string }[] => [];
const CODEX_TOOL_IMAGE_REF = /^codex-tool:([A-Za-z0-9_.\-]{1,128}):(\d{1,3})$/;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextOnly(text: string): boolean {
  const value = text.trim();
  return (/^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(value))
    || /^<(environment_context|permissions instructions|turn_aborted|subagent_notification)>[\s\S]*<\/\1>$/.test(value);
}

/**
 * An answer to Codex's queued questions (request_user_input_async) reaches the model as
 * a user message: a JSON list of {answer, question, questionItemId} inside
 * `<send_user_message_question_reply>`. The chat shows what was answered, not the envelope.
 */
function questionReply(text: string): string | null {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const items: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(items)) return null;
    const answers = items.map((item) => string(record(item).answer).trim()).filter(Boolean);
    return answers.length > 0 ? answers.join("\n") : null;
  } catch {
    return null;
  }
}

/** The questions of a request_user_input(_async) call: `title` (async) or `question` (plan mode). */
function questionTitles(args: RecordValue): string[] {
  return Array.isArray(args.questions)
    ? args.questions.map((question) => string(record(question).title) || string(record(question).question)).filter(Boolean)
    : [];
}

/** A tool call's output as Codex recorded it, as text. */
export function codexOutputText(value: unknown): string {
  return contentText(value);
}

function contentText(value: unknown, user = false): string {
  if (typeof value === "string") return user && contextOnly(value) ? "" : value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw, index) => {
    const part = record(raw);
    const previousType = string(record(value[index - 1]).type);
    const nextType = string(record(value[index + 1]).type);
    const text = string(part.text);
    const imageEnvelope = user && part.type === "input_text"
      && ((/^<image name=\[Image #\d+\](?: path="[^"\r\n]+")?>$/.test(text) && ["input_image", "local_image"].includes(nextType))
        || (text === "</image>" && ["input_image", "local_image"].includes(previousType)));
    if (imageEnvelope) return [];
    return ["input_text", "output_text", "text", "summary_text"].includes(string(part.type))
      && typeof part.text === "string" && !(user && contextOnly(part.text)) ? [part.text] : [];
  }).join("\n");
}

function entries(text: string): RecordValue[] {
  return text.split("\n").flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });
}

/** Memory blocks are metadata unless the answer quotes them in Markdown code. */
function withoutMemoryCitations(text: string): string {
  const opening = "<oai-mem-citation>";
  const closing = "</oai-mem-citation>";
  if (!text.includes(opening)) return text.trimEnd();

  type Line = { kind: "line"; index: number; quoteDepth: number; indent: number; listIndent?: number; blank: boolean };
  type Token = Line | { kind: "fence"; index: number; marker: string; info: string; line: Line }
    | { kind: "ticks"; index: number; size: number } | { kind: "citation"; index: number };
  const tokens: Token[] = [];
  const quote = /[ \t]*>[ \t]?/y;
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)) {
    const source = match[1]!;
    let offset = 0;
    let quoteDepth = 0;
    quote.lastIndex = 0;
    while (quote.exec(source)) { offset = quote.lastIndex; quoteDepth++; }
    const indent = /^[ \t]*/.exec(source.slice(offset))![0].length;
    const content = source.slice(offset + indent);
    const list = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
    const line: Line = { kind: "line", index: match.index!, quoteDepth, indent,
      ...(list ? { listIndent: indent + list[0].length } : {}), blank: content.trim() === "" };
    tokens.push(line);
    const body = content.slice(list?.[0].length ?? 0);
    const marker = /^(`{3,}|~{3,})/.exec(body)?.[0];
    const info = marker ? body.slice(marker.length) : "";
    // A backtick fence's info string cannot contain backticks.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) tokens.push({ kind: "fence",
      index: match.index! + offset + indent + (list?.[0].length ?? 0), marker, info, line });
    for (const token of source.matchAll(/`+|<oai-mem-citation>/g)) {
      tokens.push(token[0] === opening ? { kind: "citation", index: match.index! + token.index! }
        : { kind: "ticks", index: match.index! + token.index!, size: token[0].length });
    }
  }
  const closes = new Map<number, number>();
  const pairs: number[] = [];
  // Index matching runs once: unmatched delimiters must not repeatedly scan the tail.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind !== "ticks") {
      if (token.kind === "line") closes.clear();
      continue;
    }
    let backslashes = 0;
    for (let at = token.index - 1; at >= 0 && text[at] === "\\"; at--) backslashes++;
    const length = token.size - (backslashes % 2);
    pairs[i] = length > 0 ? closes.get(length) ?? -1 : -1;
    // Inside a code span a backslash does not escape its closing backticks.
    closes.set(token.size, i);
  }
  const parts: string[] = [];
  const listIndents: number[] = [];
  let quoteDepth = 0;
  let kept = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "line") {
      if (token.quoteDepth !== quoteDepth) { listIndents.length = 0; quoteDepth = token.quoteDepth; }
      if (token.blank) continue;
      while (listIndents.length > 0 && listIndents.at(-1)! > token.indent) listIndents.pop();
      if (token.listIndent !== undefined) listIndents.push(token.listIndent);
      continue;
    }
    if (token.kind === "fence") {
      const within = token.line.listIndent ?? listIndents.at(-1) ?? 0;
      const indent = token.line.listIndent === undefined ? token.line.indent - within : 0;
      if (indent < 0 || indent > 3) continue;
      // An unfinished fence remains code until its quote/list container ends.
      for (i++; i < tokens.length; i++) {
        const end = tokens[i]!;
        if (end.kind === "line" && (end.quoteDepth < token.line.quoteDepth
          || (within > 0 && end.quoteDepth === token.line.quoteDepth && !end.blank && end.indent < within))) { i--; break; }
        if (end.kind === "fence" && end.line.quoteDepth === token.line.quoteDepth && end.marker[0] === token.marker[0]
          && end.marker.length >= token.marker.length && /^[ \t]*$/.test(end.info)) {
          // Skip the closing line's raw backtick/citation tokens too.
          while (i + 1 < tokens.length && tokens[i + 1]!.kind !== "line") i++;
          break;
        }
      }
      continue;
    }
    const pair = pairs[i];
    if (pair !== undefined && pair >= 0) { i = pair; continue; }
    if (token.kind !== "citation") continue;
    parts.push(text.slice(kept, token.index));
    const close = text.indexOf(closing, token.index + opening.length);
    kept = close === -1 ? text.length : close + closing.length;
    // Metadata contents cannot open code spans or fences in the surrounding answer.
    while (i + 1 < tokens.length && tokens[i + 1]!.index < kept) i++;
  }
  parts.push(text.slice(kept));
  return parts.join("").trimEnd();
}


/**
 * Whether a Codex tool output says the call failed. Codex records no flag: its command
 * runner writes the exit code into the output, and a script or patch its own verdict. A
 * script that completed is judged as a whole, however its commands went.
 */
export function codexCallFailed(output: string): boolean {
  const head = output.slice(0, 2000);
  if (/^Script completed\b/m.test(head)) return false;
  if (/^Script failed\b/m.test(head) || /apply_patch verification failed/.test(head)) return true;
  const code = /^(?:Process exited with code|Exit code:) (\d+)$/m.exec(head) ?? /"exit_code":\s*(\d+)/.exec(head);
  return code !== null && code[1] !== "0";
}

/** What the chat reads as a stopped turn — the words Claude Code records (chatLib INTERRUPTED_TEXT). */
const STOPPED_MARKER = "[Request interrupted by user]";

/**
 * What a Codex `exec` script runs, for its row (chat-gap C-5): Codex 0.16x wraps its calls in a script
 * (`text(await tools.exec_command({cmd:"git status"}))`), so the row read «exec» alone — 498 of 539
 * recorded scripts run a command. The first command (and how many more), else the tools it calls, else
 * its first line.
 */
export function execSummary(script: string): string {
  const commands: string[] = [];
  for (const match of script.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
    const literal = match[1]!;
    let value: string | null = null;
    if (literal.startsWith('"')) {
      try { value = JSON.parse(literal) as string; } catch { value = null; }
    } else value = literal.slice(1, -1).replace(/\\(.)/g, "$1");
    const command = value?.replace(/\s+/g, " ").trim();
    if (command) commands.push(command);
  }
  if (commands.length > 0) return commands.length === 1 ? commands[0]! : `${commands[0]} (+${commands.length - 1} more)`;
  const tools = [...new Set([...script.matchAll(/\btools\.([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]!))];
  if (tools.length > 0) return tools.join(", ");
  return script.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

interface CodexParseState {
  turns: ConversationTurn[];
  tools: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  messages: { role: string; text: string; source: string; ts: string; paired: boolean; part: Extract<ConversationPart, { kind: "text" }>; turn: ConversationTurn }[];
  startedAt?: string;
  skillEvents?: Set<string>;
  activeTurnId?: string;
}

/** Complete records are folded once; snapshots detach mutable tools from prior HTTP answers. */
export function createCodexTranscriptParser(state: CodexParseState = { turns: [], tools: new Map(), messages: [] }): TranscriptParser {
  const { turns, tools, messages } = state;
  const assistant = (ts: string): ConversationTurn => {
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts: state.startedAt || ts || null, parts: [] };
      turns.push(turn);
    }
    if (ts) turn.end_ts = ts;
    return turn;
  };
  const message = (role: "user" | "assistant", text: string, source: string, ts: string, phase?: "commentary" | "final_answer", images: ConversationPart[] = []): void => {
    const body = role === "user" ? questionReply(text) ?? text
      : withoutMemoryCitations(text);
    if (!body.trim() && images.length === 0) return;
    const duplicate = messages.slice(-8).reverse().find((other) => !other.paired && other.role === role && other.text === body
      && other.source !== source && (other.ts === ts || Math.abs(Date.parse(other.ts) - Date.parse(ts)) <= 1000));
    if (duplicate) {
      duplicate.paired = true;
      if (phase) duplicate.part.phase = phase;
      // Prefer the event's local paths over a response's inline copies of the same images.
      if (images.length > 0 && (source === "event" || !duplicate.turn.parts.some((part) => part.kind === "image"))) {
        duplicate.turn.parts = [...images, ...duplicate.turn.parts.filter((part) => part.kind !== "image")];
      }
      return;
    }
    const part: Extract<ConversationPart, { kind: "text" }> = { kind: "text", text: body, ...(phase ? { phase } : {}) };
    const turn = role === "user" ? { role, ts: ts || null, parts: [...images, ...(body.trim() ? [part] : [])] } : assistant(ts);
    if (role === "user") turns.push(turn);
    else turn.parts.push(part);
    messages.push({ role, text: body, source, ts, paired: false, part, turn });
    if (messages.length > 8) messages.shift();
  };

  const write = (text: string): void => {
    for (const entry of entries(text)) {
      const payload = record(entry.payload);
      const ts = string(entry.timestamp);
      if (entry.type === "event_msg") {
        if (payload.type === "item_completed" && (!state.activeTurnId || !payload.turn_id || payload.turn_id === state.activeTurnId)) {
          const item = record(payload.item);
          const id = string(item.id);
          const skills = codexReadSkills(item);
          if (id && skills.length > 0 && !state.skillEvents?.has(id)) {
            (state.skillEvents ??= new Set()).add(id);
            if (state.skillEvents.size > 512) state.skillEvents.delete(state.skillEvents.values().next().value!);
            for (const skill of skills) {
              const turn = assistant(ts);
              const existing = [...turn.parts].reverse().find((part) => part.kind === "tool" && part.skill?.path === skill.path);
              if (existing?.kind === "tool" && existing.skill) existing.skill.status = skill.status;
              else turn.parts.push({ kind: "skill", skill });
            }
          }
        }
        if (payload.type === "task_started") {
          state.startedAt = string(payload.started_at) || ts;
          state.activeTurnId = string(payload.turn_id) || undefined;
        }
        if (payload.type === "task_complete" || payload.type === "turn_aborted") {
          const turn = turns.at(-1);
          if (turn?.role === "assistant" && ts) turn.end_ts = ts;
          state.startedAt = undefined;
        }
        // the person stopped the turn (Esc): marked as Claude Code marks it, so the chat shows «Stopped»
        // where a finished turn would end (chat-gap C-6 — 33 of 33 recorded aborts say "interrupted")
        if (payload.type === "turn_aborted") {
          const last = turns.at(-1);
          const marked = last?.role === "user" && last.parts.length === 1 && last.parts[0]!.kind === "text" && last.parts[0]!.text === STOPPED_MARKER;
          if (!marked) turns.push({ role: "user", ts: ts || null, parts: [{ kind: "text", text: STOPPED_MARKER }] });
        }
        if (payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
          message("user", contentText(payload.message, true), "event", ts, undefined, codexImageParts(entry));
        }
        if (payload.type === "agent_message") {
          message("assistant", contentText(payload.message), "event", ts,
            payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
        }
        continue;
      }
      if (entry.type !== "response_item") continue;
      if (payload.type === "message") {
        if (payload.role === "user") {
          const content = Array.isArray(payload.content) ? payload.content : [{ type: "input_text", text: payload.content }];
          const skills = content.flatMap((block) => {
            const skill = selectedSkill(string(record(block).text));
            return skill ? [skill] : [];
          });
          const visible = content.filter((block) => !selectedSkill(string(record(block).text)));
          message("user", contentText(visible, true), "response", ts, undefined, codexImageParts(entry));
          for (const skill of skills) {
            const turn = assistant(ts);
            if (!turn.parts.some((part) => part.kind === "skill" && part.skill.name === skill.name && part.skill.path === skill.path)) turn.parts.push({ kind: "skill", skill });
          }
        } else if (payload.role === "assistant") {
          const body = contentText(payload.content);
          if (payload.channel === "analysis") {
            if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
          } else if (!payload.recipient || payload.recipient === "all") {
            message("assistant", body, "response", ts,
              payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
          }
        }
      } else if (payload.type === "reasoning") {
        const body = contentText(payload.summary);
        if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
      } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = string(payload.name) || "tool";
        const raw = payload.type === "function_call" ? payload.arguments : payload.input;
        let args = record(raw);
        if (typeof raw === "string") { try { args = record(JSON.parse(raw)); } catch { /* Freeform tool input. */ } }
        // a patch, bare or in an exec script, is summed up by the files it touches
        const patch = typeof raw === "string" ? patchText(raw) : null;
        const summary = patch !== null && patchFiles(patch).length > 0 ? patchFiles(patch).join(", ")
          : name === "exec" && typeof raw === "string" ? execSummary(raw)
          : /^request_user_input/.test(name) && questionTitles(args).length > 0
          ? questionTitles(args).join(" · ")
          : [args.cmd, args.command, args.file_path, args.path, args.pattern, args.description, args.url].find((v) => typeof v === "string");
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool", name, summary: (string(summary) || name).slice(0, 120),
          input: Object.keys(args).length ? JSON.stringify(args, null, 2) : string(raw), output: "",
        };
        const skill = codexReadCall(name, args);
        if (skill) part.skill = skill;
        // the native id, and pending until an output record answers it
        if (typeof payload.call_id === "string" && payload.call_id.length > 0) { part.call_id = payload.call_id; part.state = "pending"; }
        assistant(ts).parts.push(part);
        if (typeof payload.call_id === "string") tools.set(payload.call_id, part);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const tool = tools.get(string(payload.call_id));
        if (!tool) continue;
        const output = contentText(payload.output);
        trimOutput(tool, output, string(payload.call_id));
        if (codexCallFailed(output)) tool.error = true;
        // the pictures it returned (view_image, an image generation, a screenshot a command read), named by
        // the call this output answers and fetched only when shown; the generation event's copy is not read
        const pictures = codexOutputPictures(payload.output).map(({ mediaType }, index) => ({ media_type: mediaType, ref: `codex-tool:${string(payload.call_id)}:${index}` }))
          .filter(({ ref }) => CODEX_TOOL_IMAGE_REF.test(ref));
        if (pictures.length > 0) tool.images = pictures;
        if (tool.skill) tool.skill.status = tool.error ? "failed" : "loaded";
        // done, outcome unknown: Codex records no failure flag, and the output text is no verdict
        delete tool.state;
        tools.delete(string(payload.call_id));
        const turn = turns.at(-1);
        if (turn?.role === "assistant" && ts) turn.end_ts = ts;
      }
    }
  };
  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      // A valid final line without a newline is visible now, but is not committed:
      // the writer can still extend it before the next poll.
      if (tail.trim()) {
        const preview = createCodexTranscriptParser(structuredClone(state));
        preview.write(tail);
        return preview.snapshot();
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

export function parseCodexTranscript(text: string, maxTurns = 100): ConversationTurn[] {
  const parser = createCodexTranscriptParser();
  parser.write(text);
  return parser.snapshot().slice(-maxTurns);
}
