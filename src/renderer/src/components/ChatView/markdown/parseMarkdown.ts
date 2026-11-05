// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: shared/markdown.ts — near verbatim, in ovis formatting. Change: the HTML-block reader (markdownHtml.ts) is
// not ported — the chat parses agent text with html=false, which keeps HTML as text, exactly as ovis does for chat.
import { fileUriPath } from "./fileUri";

/** HTML blocks are only read for files (html=true), which the chat never asks for. */
const startsHtml = (_line: string): boolean => false;
const parseHtmlBlock = (_lines: string[], index: number): { blocks: MarkdownBlock[]; next: number } => ({ blocks: [], next: index + 1 });

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  /** `dollar`: written as `$…$`, which a surface that cannot draw it shows again */
  | { type: "math"; value: string; dollar?: true }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  /** `![alt](src)`; `fallback` is what a surface that draws no images shows after the `!` */
  | { type: "image"; alt: string; src: string; fallback: InlineNode[]; /** CSS pixels, from an HTML `<img width>` */ width?: number }
  /** a link to a local file (`[report](/repo/out/REPORT.md)`): its label opens the path */
  | { type: "file"; path: string; children: InlineNode[] };

export interface ListItem {
  content: InlineNode[];
  /** a task list item (`- [x] done`, `- [ ] open`): whether its box is checked */
  checked?: boolean;
  /** what is indented under the item's text, in order: a nested list, a table */
  blocks?: MarkdownBlock[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  /** an ordered list's first number: a list split by a code block goes on from where it was */
  start?: number;
  items: ListItem[];
}

export type MarkdownBlock =
  /** `dollar`: written between `$$` rather than `\[` and `\]`; `oneLine`: opened and closed on one line */
  | { type: "math"; value: string; dollar?: true; oneLine?: true }
  /** `align`: centered by the HTML a README wrote it in (markdownHtml.ts) */
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[]; align?: "center" }
  | { type: "paragraph"; lines: InlineNode[][]; align?: "center" }
  | ListBlock
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "code"; language: string; value: string }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

/**
 * The characters `nodes` show as text, as a card draws them (#2220): emphasis, strikethrough and code
 * their text, a link or a file link its words, with its address after them when `addresses` (unless the
 * words are the address). Null for a node that shows something else than characters: math, a picture.
 * The one reading of what an Ask card's option says: the server holds it to omp's screen, the card draws
 * it, and a typed answer names the option by it.
 */
export function shownText(nodes: InlineNode[], addresses = false): string | null {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": case "code": out += node.value; break;
      case "strong": case "em": case "del": {
        const inner = shownText(node.children, addresses);
        if (inner === null) return null;
        out += inner;
        break;
      }
      case "link": case "file": {
        const words = shownText(node.children);
        if (words === null) return null;
        const href = node.type === "link" ? node.href : node.path;
        out += addresses && href && words !== href && words !== href.replace(/^mailto:/, "") ? `${words} (${href})` : words;
        break;
      }
      case "math": case "image": return null;
    }
  }
  return out;
}

export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

/**
 * An address written without its scheme, as people and agents do: `www.example.com/x`,
 * `docs.example.com/guide`, `localhost:7317/`. A host needs a letters-only top level and,
 * past `www.`, a path to count: `README.md:3` is a file and its line, `notes.v2/x` a folder.
 * localhost and an IPv4 address are local servers, plain http, where a port is enough.
 */
export function webLikeHref(target: string): string | null {
  const value = target.trim();
  if (/^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}:\d+|\d{1,3}(?:\.\d{1,3}){3}(?=\/))(?:\/\S*)?$/i.test(value)) return `http://${value}`;
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(\/\S*)?$/i.exec(value);
  if (match === null) return null;
  const [, host, path] = match;
  return /^www\./i.test(host!) || path !== undefined ? `https://${value}` : null;
}

/**
 * The file a link names, when its target is a path rather than an address: agents link
 * files they wrote (`[report](/repo/out/REPORT.md)`, `[x](src/x.ts#L12)`, `[x](x.ts:12)`).
 * A line anchor (`#L12`, `:12`) stays for the viewer; other anchors are dropped. A line after a bare
 * word is a scheme's (`tel:123`), not a file's.
 */
export function markdownFileTarget(href: string): string | null {
  const value = href.trim();
  if (/^file:\/\/\//i.test(value)) return fileUriPath(value);
  if (value === "" || value.startsWith("#")) return null;
  const target = value.replace(/#(?!L\d+(?:-L?\d+)?$).*$/, "");
  const path = target.replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, "");
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || (path !== target && !/[./]/.test(path))) return null;
  return target;
}

/** A bare URL without the punctuation that closes the sentence around it (GFM's autolink rule). */
export function trimUrl(url: string): string {
  let end = url.length;
  // counted once: an opening one is never cut, a closing one only from the end
  let opened = 0;
  let closed = 0;
  for (let index = 0; index < end; index += 1) {
    if (url[index] === "(") opened += 1;
    else if (url[index] === ")") closed += 1;
  }
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
    // a closing parenthesis stays only while it closes one opened inside the URL
    if (last === ")" && closed > opened) { end -= 1; closed -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Emphasis nests by one call each: past this many levels, what is inside is read as plain text. */
const MAX_INLINE_DEPTH = 16;

/** A Codex artifact directive names a local file; other or incomplete directives stay text. */
function codexFileCitation(token: string): { path: string; label: string } | null {
  // the spaces a directive may leave before its `}` are no attribute
  const body = token.slice(21, -1).replace(/[ \t]+$/, "");
  const attribute = /\s*([a-z_]+)="((?:[^"\\]|\\.)*)"/gy;
  const values = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    attribute.lastIndex = at;
    const match = attribute.exec(body);
    if (match === null || values.has(match[1]!)) return null;
    try { values.set(match[1]!, JSON.parse(`"${match[2]}"`) as string); } catch { return null; }
    at = attribute.lastIndex;
  }
  const path = values.get("path");
  // as a file:/// link (fileUri.ts): an absolute local path, never a network share however its separators are written
  if (!path || !(/^(?:\/|[A-Za-z]:[\\/])/.test(path)) || /^[\\/]{2}/.test(path) || /[\x00-\x1f\x7f]/.test(path)
    || !["source", "output"].includes(values.get("purpose") ?? "") || values.has("mode")) return null;
  const label = path.split(/[\\/]/).pop();
  return label ? { path, label } : null;
}

/**
 * The marks in a line, left to right, as one search of the line for the pattern found them. That
 * search looks from every `[`, `\(` and `_` to the end of the line for what closes it, so a long
 * line of them that never close took a minute. Here the pattern is tried only where a mark can
 * start, and where a closer may be far away, only if one is there: each closer is looked for
 * once, for every opener before it.
 */
export function* inlineMarks(source: string): Generator<RegExpExecArray> {
  // Underscores inside identifiers are literal: MAC_QA_CHAT_OK must survive
  // rendering exactly as it appears in the terminal and native transcript.
  // a bare or <angle> http(s) URL is a link too; it stops at the first non-ASCII character,
  // so `…/pull/36에서` links the address and leaves the Korean after it as text
  const marker = /(`[^`\n]+`|:codex-file-citation\{(?:[ \t]*[a-z_]+="[^"\\\n]*(?:\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})[^"\\\n]*)*")+[ \t]*\}|\\\(.+?\\\)|(?<![A-Za-z0-9\\$])\$(?:[^\s$\\`]|[^\s$`][^\n\r\u2028\u2029$`]*[^\s$\\`])\$(?![A-Za-z0-9_${#@*(`])|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/yu;
  // its last part alone, for a `__` that nothing closes as bold: one `_` may still close it
  const emphasis = /(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu;
  // what any part of `marker` starts with
  const opener = /[`[<*_~$]|:codex-file-citation\{|\\\(|file:\/\/\/|https?:\/\/|www\./g;
  /** Where `pattern` is next found from `from` on. Asked with a `from` that only rises, so a place found serves every `from` before it. */
  const next = (pattern: RegExp): ((from: number) => number) => {
    let found = -1;
    return (from) => {
      if (found < from) {
        pattern.lastIndex = from;
        found = pattern.exec(source)?.index ?? Infinity;
      }
      return found;
    };
  };
  const lineEnd = next(/\n/g);
  const citationEnd = next(/}/g);
  // `.` stops at these, and a formula is `.+?`
  const mathBreak = next(/[\n\r\u2028\u2029]/g);
  const mathClose = next(/\\\)/g);
  const dollarClose = next(/\$/g);
  const labelEnd = next(/[\]\n]/g);
  const targetEnd = next(/[\s)]/g);
  const emphasisClose = next(/(?<=\S)_(?![\p{L}\p{N}\p{M}_])/gu);
  const strongClose = next(/(?<=\S)__(?![\p{L}\p{N}\p{M}_])/gu);
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const start = opener.exec(source)?.index;
    if (start === undefined) return;
    from = start + 1;
    let pattern: RegExp | null = marker;
    const char = source[start];
    if (char === ":") {
      if (!(citationEnd(start + 21) < lineEnd(start + 21))) pattern = null;
    } else if (char === "\\") {
      if (!(mathClose(start + 3) < mathBreak(start + 2))) pattern = null;
    } else if (char === "$") {
      // a formula's `$` follows no Latin letter, digit, backslash or `$` (Korean, Japanese and
      // Chinese text runs into a formula with no space: `값은$x$이다`), and its closer is on this line
      if (/[A-Za-z0-9\\$]/.test(source[start - 1] ?? "") || !(dollarClose(start + 2) < mathBreak(start + 1))) pattern = null;
    } else if (char === "[") {
      const label = labelEnd(start + 1);
      const target = label + 2;
      if (!(label > start + 1 && source[label] === "]" && source[label + 1] === "(")) pattern = null;
      else {
        const end = targetEnd(target);
        if (!(end > target && source[end] === ")")) pattern = null;
      }
    } else if (char === "_") {
      const end = lineEnd(start + 1);
      // a `__` that closes also closes as a `_`, so `marker` has no long search left to fail
      if (!(source[start + 1] === "_" && strongClose(start + 3) < end)) pattern = emphasisClose(start + 2) < end ? emphasis : null;
    }
    if (pattern === null) continue;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (match === null) continue;
    // a price, not a formula: `$5 for the $` (a number, a space, then a word) stays text
    if (char === "$" && /^\$\d[\d.,]*\s+\p{L}/u.test(match[0])) continue;
    from = start + match[0].length;
    yield match;
  }
}

/** Dependency-free inline markdown scanner. Unknown or malformed markup remains text. */
export function parseInline(source: string, links = true, depth = 0): InlineNode[] {
  if (depth > MAX_INLINE_DEPTH) return source === "" ? [] : [{ type: "text", value: source }];
  const nodes: InlineNode[] = [];
  let offset = 0;
  for (const match of inlineMarks(source)) {
    const index = match.index ?? 0;
    let token = match[0];
    // the `!` of an image stays in the text before its bracket
    const image = token.startsWith("[") && index > offset && source[index - 1] === "!";
    const textEnd = image ? index - 1 : index;
    if (textEnd > offset) nodes.push({ type: "text", value: source.slice(offset, textEnd) });
    // like an http address it stops at the first non-ASCII character (`file:///tmp/a.md에서`); a
    // name with other letters in it is percent-encoded in a URI
    if (token.startsWith(":codex-file-citation{")) {
      const citation = links ? codexFileCitation(token) : null;
      nodes.push(citation === null ? { type: "text", value: token }
        : { type: "file", path: citation.path, children: [{ type: "text", value: citation.label }] });
    } else if (token.startsWith("file:///")) {
      token = trimUrl(token);
      const path = fileUriPath(token);
      nodes.push(links && path !== null ? { type: "file", path, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("<")) {
      const url = token.slice(1, -1);
      nodes.push(links ? { type: "link", href: url, children: [{ type: "text", value: url }] } : { type: "text", value: token });
    } else if (/^(?:https?:|www\.)/i.test(token)) {
      // what ends a sentence is not part of the address: "see https://x.dev/a)." links x.dev/a
      token = trimUrl(token);
      const href = /^www\./i.test(token) ? `https://${token}` : token;
      nodes.push(links ? { type: "link", href, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("\\(")) {
      nodes.push({ type: "math", value: token.slice(2, -2) });
    } else if (token.startsWith("$")) {
      nodes.push({ type: "math", value: token.slice(1, -1), dollar: true });
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const target = token.slice(split + 2, -1);
      // a label holds no `]`, so no link nests in one: only emphasis counts toward the depth
      const href = safeMarkdownHref(target) ?? webLikeHref(target);
      const file = href === null ? markdownFileTarget(target) : null;
      const shown: InlineNode = href !== null ? { type: "link", href, children: parseInline(label, false, depth) }
        : file !== null ? { type: "file", path: file, children: parseInline(label, false, depth) }
        : { type: "text", value: label };
      if (image) nodes.push({ type: "image", alt: label, src: target, fallback: [{ type: "text", value: "!" }, shown] });
      else nodes.push(shown);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1), links, depth + 1) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

// `s`: the text may hold a line separator (U+2028) that `.` would stop at, and the pattern then
// tries every split of the spaces before it; with it the line is an item, as it reads
const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/s;
/**
 * The line under a table's header: two or more cells of dashes (`---`, `:-:`; one dash is enough, as on GitHub), with or without
 * the outer pipes. Read cell by cell: one pattern for the whole line tries every way to share
 * a run of spaces between its parts, and a long blank line takes seconds.
 */
export function isTableSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const columns = row.split("|");
  return columns.length >= 2 && columns.every((column) => /^:?-+:?$/.test(column.trim()));
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}
function startsTable(lines: string[], index: number): boolean {
  return lineAt(lines, index).includes("|") && isTableSeparator(lineAt(lines, index + 1));
}
/** A table in a list item (`within` > 0) ends at a line outside the item or at the next item. */
function parseTable(lines: string[], start: number, within = 0): { block: MarkdownBlock; next: number } {
  const header = cells(lineAt(lines, start)).map((cell) => parseInline(cell));
  let index = start + 2;
  const rows: InlineNode[][][] = [];
  const inItem = (line: string): boolean => within === 0 || ((/^\s*/.exec(line)?.[0].length ?? 0) >= within && !listLine.test(line));
  while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "" && inItem(lineAt(lines, index))) {
    rows.push(cells(lineAt(lines, index)).map((cell) => parseInline(cell)));
    index += 1;
  }
  return { block: { type: "table", header, rows }, next: index };
}


function startsBlock(lines: string[], index: number, html = false): boolean {
  const line = lines[index] ?? "";
  return (html && startsHtml(line)) || /^\s*(?:\\\[|\$\$)/.test(line) || /^\s{0,3}```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*>/.test(line) || /^(?:\s*[-*_]){3,}\s*$/.test(line) || listLine.test(line)
    || startsTable(lines, index);
}

/** An item's text, with a GitHub task box (`[x]`, `[X]`, `[ ]`) read off its start. */
function listItem(text: string): ListItem {
  const task = /^\[([ xX])\](?:\s+(.*))?$/.exec(text);
  if (task === null) return { content: parseInline(text) };
  return { content: parseInline(task[2] ?? ""), checked: task[1] !== " " };
}

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const number = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  const block: ListBlock = { type: "list", ordered, ...(ordered && number !== 1 ? { start: number } : {}), items: [] };
  let index = start;
  while (index < lines.length) {
    // between items: blank lines (a loose list, as agents often write one) and an item's own
    // indented lines, which read on as its text, or make a table in it; anything else ends
    // the list, and so does an indented fence, which shows as its own block
    if (block.items.length > 0 && !listLine.test(lineAt(lines, index))) {
      let ahead = index;
      while (ahead < lines.length && lineAt(lines, ahead).trim() === "") ahead += 1;
      const line = lineAt(lines, ahead);
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const sibling = listLine.exec(line);
      if (sibling !== null && (sibling[1] ?? "").length === baseIndent && /\d/.test(sibling[2] ?? "") === ordered) { index = ahead; continue; }
      // a list indented under the last item after a blank line (or after its table) nests in it
      if (sibling !== null && (sibling[1] ?? "").length >= baseIndent + 2) { index = ahead; continue; }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && startsTable(lines, ahead)) {
        const item = block.items.at(-1)!;
        const table = parseTable(lines, ahead, baseIndent + 2);
        (item.blocks ??= []).push(table.block);
        index = table.next;
        continue;
      }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && !/^\s*```/.test(line)) {
        const item = block.items.at(-1)!;
        const last = item.blocks?.at(-1);
        if (last === undefined) {
          // added to, not copied: an item of thousands of lines copies itself at every one
          item.content.push({ type: "text", value: " " });
          for (const node of parseInline(line.trim())) item.content.push(node);
        } else {
          // after a table or nested list the item's text goes on below it; a quote or rule
          // there ends the list and shows as its own block, as it did before tables nested
          if (startsBlock(lines, ahead)) break;
          if (last.type === "paragraph" && ahead === index) last.lines.push(parseInline(line.trim()));
          else item.blocks!.push({ type: "paragraph", lines: [parseInline(line.trim())] });
        }
        index = ahead + 1;
        continue;
      }
      break;
    }
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index);
      (parent.blocks ??= []).push(nested.block);
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/.test(match[2] ?? "") !== ordered) break;
    block.items.push(listItem(match[3] ?? ""));
    index += 1;
  }
  return { block, next: index };
}

/** KaTeX reads a formula one call per group: nested deeper than this, it is shown as its source. */
const MAX_MATH_DEPTH = 100;

/**
 * Whether a formula's braces nest deeper than anyone writes them. KaTeX takes over a second on
 * thousands of nested fractions before it gives up, with the page waiting on it.
 */
export function mathNestsTooDeep(value: string): boolean {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") index += 1;
    else if (char === "{") { depth += 1; if (depth > MAX_MATH_DEPTH) return true; }
    else if (char === "}" && depth > 0) depth -= 1;
  }
  return false;
}

/** Whether `line` opens a display formula (`\[` or `$$`) and closes it, with nothing after the close. */
function wholeFormula(line: string): boolean {
  const open = /^\s*(\\\[|\$\$)/.exec(line);
  if (open === null) return false;
  const close = line.indexOf(open[1] === "$$" ? "$$" : "\\]", open[0].length);
  return close !== -1 && line.slice(close + 2).trim() === "";
}

/** Code blocks longer than this open folded to their first FOLDED_CODE_LINES lines. */
export const FOLD_CODE_AFTER_LINES = 30;
export const FOLDED_CODE_LINES = 20;

/** The folded head of a long code block and its full line count; null when it shows whole. */
export function foldCode(value: string): { head: string; lines: number } | null {
  const lines = value.split("\n");
  if (lines.length <= FOLD_CODE_AFTER_LINES) return null;
  return { head: lines.slice(0, FOLDED_CODE_LINES).join("\n"), lines: lines.length };
}

/** Quotes nest by one call each: past this many levels, what is left is read as plain lines. */
const MAX_QUOTE_DEPTH = 32;

/** `html`: a file's markdown, whose HTML blocks are read as markdown (markdownHtml.ts); an agent's text keeps them as text */
export function parseMarkdown(source: string, depth = 0, html = false): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  // no formula opened before this line closes: the search that found so is not made again (one
  // line per delimiter, `\[` and `$$`)
  const unclosedMath = { "\\[": 0, "$$": 0 };
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    // a fence may be indented (inside a list item, as agents write them): its lines lose that indent
    const fence = /^( {0,3})```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      const indent = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lineAt(lines, index))) {
        const bodyLine = lineAt(lines, index++);
        body.push(bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart());
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[2] ?? "", value: body.join("\n") });
      continue;
    }

    const display = /^\s*(\\\[|\$\$)(.*)$/.exec(line);
    const open = display?.[1] as keyof typeof unclosedMath | undefined;
    if (display !== null && open !== undefined && index >= unclosedMath[open]) {
      const close = open === "$$" ? "$$" : "\\]";
      const body: string[] = [];
      let next = index;
      let part = display[2] ?? "";
      let complete = false;
      while (true) {
        const at = part.indexOf(close);
        // the opening line closes its formula and goes on in prose: it is prose
        if (at !== -1 && next === index && part.slice(at + 2).trim() !== "") break;
        if (at !== -1 && part.slice(at + 2).trim() === "") {
          body.push(part.slice(0, at));
          const value = body.join("\n").trim();
          blocks.push(open === "$$" ? { type: "math", value, dollar: true, ...(next === index ? { oneLine: true as const } : {}) } : { type: "math", value });
          index = next + 1;
          complete = true;
          break;
        }
        body.push(part);
        next += 1;
        // a blank line (display math holds none) or a fence ends the search, and so does a line
        // that is a whole formula of its own, or one opening a formula with the other delimiter: it
        // is drawn as one, rather than closing this one or being hidden by it
        if (next >= lines.length || lineAt(lines, next).trim() === "" || /^\s{0,3}```/.test(lineAt(lines, next)) || wholeFormula(lineAt(lines, next))
          || (open === "$$" ? /^\s*\\\[/ : /^\s*\$\$/).test(lineAt(lines, next))) break;
        part = lineAt(lines, next);
      }
      // An incomplete formula stays prose; later headings and fences still parse normally.
      if (complete) continue;
      // every `\[` up to where the search ended (the end, or a fence) would search the same lines
      unclosedMath[open] = next;
    }

    if (html && startsHtml(line)) {
      const read = parseHtmlBlock(lines, index);
      blocks.push(...read.blocks);
      index = read.next;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/s.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/, ""));
      // a line of thousands of ">" (text nobody wrote by hand) would otherwise overflow the stack
      blocks.push({ type: "blockquote", blocks: depth < MAX_QUOTE_DEPTH ? parseMarkdown(quoted.join("\n"), depth + 1, html)
        : [{ type: "paragraph", lines: quoted.map((quotedLine) => parseInline(quotedLine)) }] });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: InlineNode[][] = [];
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index, html))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
