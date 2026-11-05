// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: src/lib/highlight.ts — near verbatim; languageForPath (file viewer) is not ported, and the chat
// highlights on the page only (no worker): HighlightedCode.tsx keeps longer code plain.
import { createHighlighter, type HighlightTokenClass } from "@tanstack/highlight/core";
import { apache } from "@tanstack/highlight/languages/apache";
import { cmake } from "@tanstack/highlight/languages/cmake";
import { cpp } from "@tanstack/highlight/languages/cpp";
import { css } from "@tanstack/highlight/languages/css";
import { diff } from "@tanstack/highlight/languages/diff";
import { dockerfile } from "@tanstack/highlight/languages/dockerfile";
import { ejs } from "@tanstack/highlight/languages/ejs";
import { env } from "@tanstack/highlight/languages/env";
import { go } from "@tanstack/highlight/languages/go";
import { html } from "@tanstack/highlight/languages/html";
import { http } from "@tanstack/highlight/languages/http";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { jsx } from "@tanstack/highlight/languages/jsx";
import { markdown } from "@tanstack/highlight/languages/markdown";
import { mermaid } from "@tanstack/highlight/languages/mermaid";
import { nginx } from "@tanstack/highlight/languages/nginx";
import { php } from "@tanstack/highlight/languages/php";
import { python } from "@tanstack/highlight/languages/python";
import { scheme } from "@tanstack/highlight/languages/scheme";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { svelte } from "@tanstack/highlight/languages/svelte";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";
import { vue } from "@tanstack/highlight/languages/vue";
import { yaml } from "@tanstack/highlight/languages/yaml";


/** What a token means, independent of any theme; CSS maps each role to a token color. */
export type SyntaxRole =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "meta"
  | "inserted"
  | "deleted";

export interface Token {
  text: string;
  /** `null` is plain text. */
  role: SyntaxRole | null;
}

/**
 * One array of tokens per source line, without the line break. Never has a trailing empty line (a
 * final "\n" ends the last line, it does not start another) and always has at least one line; an
 * empty line is an empty array. A multi-line construct (comment, template string) keeps its role on
 * every line it spans.
 */
export type Lines = Token[][];

/**
 * A tokenized text as runs over its source: run `i` is `lengths[i]` characters in the role
 * `ROLES[roles[i]]` (0 is plain). Typed arrays, so a worker hands them over without copying.
 */
export interface Runs {
  lengths: Uint32Array;
  roles: Uint8Array;
}

/**
 * Code blocks in chat are highlighted up to this many characters (`limit` counts characters). The
 * worker's budget bounds the time; this bounds what a reply can make it hold: a pasted log or a
 * minified bundle is not worth a worker run, and its colors would fill the cache.
 */
export const CHAT_HIGHLIGHT_LIMIT = 100 * 1024;

/**
 * Up to this many characters, code is highlighted at once, while the page draws. TanStack Highlight
 * is linear on ordinary code but quadratic on some shapes (a long run of `"\"` in JSON, `--` in
 * YAML): at 2 KB the worst of those measured stays under 5 ms. Anything longer is highlighted in a
 * worker (`highlightOffThread`), so no text can hold the page.
 */
export const SYNC_HIGHLIGHT_LIMIT = 2 * 1024;

/**
 * Past this many lines, code is drawn as one text, without colors: every line is an element of its
 * own, and in Chromium 20 000 of them take about 0.3 s to draw, while 256 KB of line breaks (262 144
 * lines) held the page for 4 s. Bytes do not bound that, so the lines are counted.
 */
export const LINE_ELEMENT_LIMIT = 20_000;

/** How many lines a normalized source (`normalizeCode`) has: one more than its line breaks. */
export function countLines(source: string): number {
  let lines = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) lines += 1;
  return lines;
}

// the languages an agent's files and replies are likely to hold; TSRX (Octane) and plain text are left out
const highlighter = createHighlighter({
  languages: [apache, cmake, cpp, css, diff, dockerfile, ejs, env, go, html, http, js, json, jsx, markdown, mermaid, nginx, php, python, scheme, shell, sql, svelte, toml, ts, tsx, vue, yaml],
});
const REGISTERED = new Set(highlighter.listLanguages());

// a fence word or a file extension to its registered language, beyond the aliases TanStack knows
// itself (javascript, typescript, bash, sh, zsh, yml, py, md, xml, golang, patch, docker, …)
const LANGUAGE_ALIASES: Record<string, string> = {
  mts: "ts", cts: "ts",
  c: "cpp", h: "cpp",
  scss: "css", less: "css",
  svg: "html", xhtml: "html",
  mkd: "markdown", mdown: "markdown", mkdn: "markdown", markdown: "markdown",
  ini: "toml", cfg: "toml",
  ksh: "shell", fish: "shell",
};

// plain text is no language: a request for one must come out as `null`, or a long .txt would be
// reported "too long to highlight"
const PLAIN_TEXT = new Set(["plaintext", "text", "txt"]);

/** The registered language a lowercase word names (a fence word, an extension), or `null`. */
function languageForWord(word: string): string | null {
  if (!word || PLAIN_TEXT.has(word)) return null;
  const language = highlighter.normalizeLanguage(LANGUAGE_ALIASES[word] ?? word);
  return REGISTERED.has(language) ? language : null;
}

/** Whether `language` is one this module highlights (a name `languageForFence`/`languageForPath` give). */
export function canHighlight(language: string | null): language is string {
  return language !== null && REGISTERED.has(language);
}

/**
 * The registered language for a Markdown fence's info string ("ts", "TSX title=x"): only its first
 * word counts, case-insensitively. `null` for an empty, plain-text or unknown one.
 */
export function languageForFence(info: string): string | null {
  return languageForWord(info.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
}


// TanStack's semantic classes to roles; an unlisted class (`operator`) is plain
const CLASS_ROLES: Partial<Record<HighlightTokenClass, SyntaxRole>> = {
  keyword: "keyword", literal: "keyword",
  string: "string", "code-inline": "string",
  number: "number",
  comment: "comment",
  function: "function", command: "function", heading: "function",
  type: "type", tag: "type", selector: "type",
  variable: "variable", property: "variable", attr: "variable", link: "variable",
  meta: "meta",
  inserted: "inserted",
  deleted: "deleted",
};

/** Roles by their index in `Runs.roles`; 0 is plain. */
const ROLES: readonly (SyntaxRole | null)[] = [null, "keyword", "string", "number", "comment", "function", "type", "variable", "meta", "inserted", "deleted"];
const ROLE_INDEX = new Map(ROLES.map((role, index) => [role, index]));

/** Normalize line endings without discarding source whitespace from rendered text and selection. */
export function normalizeCode(code: string): string {
  return code.replace(/\r\n/g, "\n");
}

/** Uncolored lines, in the same shape as tokenized ones, so a view never tells the two apart. */
export function plainLines(source: string): Lines {
  return source.split("\n").map((line) => (line === "" ? [] : [{ text: line, role: null }]));
}

/**
 * `source` (normalized) tokenized as runs, neighbors of one role merged. Runs in the worker as on
 * the page. Throws whatever the highlighter throws; `language` must be registered.
 */
export function highlightRuns(source: string, language: string): Runs {
  const lengths: number[] = [];
  const roles: number[] = [];
  for (const token of highlighter.tokenize(source, { lang: language }).tokens) {
    if (token.value === "") continue;
    const role = ROLE_INDEX.get((token.className && CLASS_ROLES[token.className]) ?? null) ?? 0;
    const last = roles.length - 1;
    if (last >= 0 && roles[last] === role) lengths[last] = lengths[last]! + token.value.length;
    else { lengths.push(token.value.length); roles.push(role); }
  }
  return { lengths: Uint32Array.from(lengths), roles: Uint8Array.from(roles) };
}

/**
 * The lines of `source` colored by `runs`. A run that spans lines keeps its role on each. Runs that
 * do not add up to the source (a stale answer) leave the rest plain.
 */
export function linesFromRuns(source: string, runs: Runs): Lines {
  const lines: Lines = [[]];
  let at = 0;
  /** Adds `text` in `role`, starting a new line at each "\n". */
  const append = (text: string, role: SyntaxRole | null) => {
    text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]!.push({ text: part, role });
    });
  };
  for (let i = 0; i < runs.lengths.length && at < source.length; i++) {
    const length = runs.lengths[i]!;
    append(source.slice(at, at + length), ROLES[runs.roles[i]!] ?? null);
    at += length;
  }
  if (at < source.length) append(source.slice(at), null);
  return lines;
}

/**
 * Lines already colored, followed by `tail` uncolored: a reply still being written keeps the colors
 * of what it had while its new end is highlighted. The lines given are not changed.
 */
export function extendLines(lines: Lines, tail: string): Lines {
  if (tail === "") return lines;
  const next = lines.slice();
  const [first, ...rest] = tail.split("\n");
  if (first) next[next.length - 1] = [...next[next.length - 1]!, { text: first, role: null }];
  for (const line of rest) next.push(line === "" ? [] : [{ text: line, role: null }]);
  return next;
}

/** The last code `highlightNow` highlighted, as it answered. */
let lastHighlight: { source: string; language: string; lines: Lines } | null = null;

/**
 * `source` (normalized) highlighted at once, on the calling thread. Never throws: a highlighter
 * error gives plain lines. The last call is remembered, so a block mounted anew with the same code
 * is not tokenized again. Only for short code (`SYNC_HIGHLIGHT_LIMIT`) or in a worker.
 */
export function highlightNow(source: string, language: string): Lines {
  if (lastHighlight !== null && lastHighlight.source === source && lastHighlight.language === language) return lastHighlight.lines;
  let lines: Lines;
  try {
    lines = linesFromRuns(source, highlightRuns(source, language));
  } catch {
    lines = plainLines(source);
  }
  lastHighlight = { source, language, lines };
  return lines;
}
