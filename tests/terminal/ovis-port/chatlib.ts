// ovis tests moved over for group "chatlib" (ovis @3e51902, MIT, devswha). Run through tests/terminal/_t80-chatlib.spec.ts.
// ovis test files (refs/ovis): src/lib/filePaths.test.ts · diff.test.ts · userMessageFold.test.ts · modelName.test.ts ·
// todos.test.ts · workBlocks.test.ts · highlight.test.ts · markdown.test.ts · shared/patch.test.ts · server/tool-output.test.ts.
// Inputs and expected values are ovis's own; only the call sites follow our names/signatures (see the notes on each fixme/fail).
// bun's `spyOn` is re-made below for Node; bun:ffi's thread clock is dropped (ovis falls back to process.cpuUsage).
/* eslint-disable */
import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
    codeIsFilePath,
    fileLineTarget,
    lineDiff,
    modelLabel,
    shouldFoldUserMessage,
    splitFilePaths,
    todoSnapshot,
    USER_MESSAGE_FOLD_CHARS,
    USER_MESSAGE_FOLD_LINES,
    visibleUserMessageText
} from '../../../src/renderer/src/components/ChatView/chatLib'
import {
    formatWorkDuration,
    isLiveWorkTurn,
    turnSegments,
    workFailed,
    workStartsOpen,
    workSummary
} from '../../../src/renderer/src/components/ChatView/workBlocks'
import {
    canHighlight,
    countLines,
    extendLines,
    highlightNow,
    highlightRuns,
    languageForFence,
    LINE_ELEMENT_LIMIT,
    linesFromRuns,
    normalizeCode,
    plainLines,
    SYNC_HIGHLIGHT_LIMIT,
    type Lines
} from '../../../src/renderer/src/components/ChatView/markdown/highlight'
import {
    FOLD_CODE_AFTER_LINES,
    FOLDED_CODE_LINES,
    foldCode,
    inlineMarks,
    isTableSeparator,
    mathNestsTooDeep,
    parseInline,
    parseMarkdown,
    safeMarkdownHref,
    trimUrl,
    type InlineNode,
    type ListBlock
} from '../../../src/renderer/src/components/ChatView/markdown/parseMarkdown'
import { patchFiles, patchText } from '../../../src/main/transcript/patch'
import { TOOL_OUTPUT_CHARS, trimOutput } from '../../../src/main/transcript/toolOutput'
import type { ConversationPart } from '../../../src/shared/conversation'

const REPO = path.resolve(__dirname, '../../..')
// esbuild is vite's own dependency and not hoisted to node_modules, so it is found through vite
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild') as {
    build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>
}
/** the chat's Markdown.tsx as a render function, bundled with its own react so the test runner's JSX transform stays out of it */
async function buildMarkdownRenderer(): Promise<(source: string) => string> {
    const result = await esbuild.build({
        stdin: {
            contents: `import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './src/renderer/src/components/ChatView/markdown/Markdown'
export const render = (source) => renderToStaticMarkup(createElement(Markdown, { children: source }))`,
            resolveDir: REPO,
            loader: 'tsx'
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'cjs',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"development"' },
        logLevel: 'silent'
    })
    const module = { exports: {} as { render: (source: string) => string } }
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(__filename))
    return module.exports.render
}

type Spy = { mock: { calls: unknown[][] }; mockImplementation(fn: (...args: any[]) => any): Spy; mockRestore(): void }
/** bun:test's spyOn, enough for the ovis cases: wraps the method, can swap its body, records the calls, restores it */
function spyOn(target: any, key: string): Spy {
    const original = target[key]
    const calls: unknown[][] = []
    let body: (...args: any[]) => any = function (this: unknown, ...args: any[]) {
        return original.apply(this, args)
    }
    target[key] = function (this: unknown, ...args: any[]) {
        calls.push(args)
        return body.apply(this, args)
    }
    const spy: Spy = {
        mock: { calls },
        mockImplementation(fn) {
            body = fn
            return spy
        },
        mockRestore() {
            target[key] = original
        }
    }
    return spy
}

test.describe('ovis src/lib/filePaths.test.ts', () => {
const paths = (text: string) => splitFilePaths(text).filter((part) => typeof part !== "string").map((part) => (part as { path: string }).path);

test.describe("file paths in chat text", () => {
  test("keeps line references whole in prose and code spans", () => {
    const targets = ["src/app.ts:12", "src/app.ts:12:8", "src/app.ts#L12", "src/app.ts#L12-L18", "src/app.ts#L12-18"];
    expect(paths(targets.join(" "))).toEqual(targets);
    for (const target of targets) expect(codeIsFilePath(target)).toBe(true);
    for (const target of ["Math.random:12", "tool.monitor#L12", "1.2.3:12"]) expect(codeIsFilePath(target)).toBe(false);
    expect(splitFilePaths("see src/app.ts:12:8.")).toEqual(["see ", { path: "src/app.ts:12:8" }, "."]);
  });
  test("finds paths with a folder and an extension, absolute, ~ or relative", () => {
    expect(paths("Saved to docs/screenshots/demo-mobile.mp4 and ~/out/shot.png, see /tmp/run.log.")).toEqual([
      "docs/screenshots/demo-mobile.mp4", "~/out/shot.png", "/tmp/run.log",
    ]);
    expect(paths("./scripts/capture.ts 에서 확인")).toEqual(["./scripts/capture.ts"]);
    // the text around a path is kept, whole
    expect(splitFilePaths("open src/a.ts now")).toEqual(["open ", { path: "src/a.ts" }, " now"]);
  });

  test("finds a path named in any script, and stops at a particle written onto it", () => {
    expect(paths("열면 docs/스플릿뷰-결과.html 이 보여요, ~/사진/화면.png")).toEqual(["docs/스플릿뷰-결과.html", "~/사진/화면.png"]);
    expect(paths("docs/a.md를 열고 src/앱.ts에서 확인")).toEqual(["docs/a.md", "src/앱.ts"]);
    expect(paths("한글/폴더/파일.txt:12")).toEqual(["한글/폴더/파일.txt:12"]);
    // a name with spaces in prose is not guessed at: only its last word would match
    expect(paths("docs/합치기 결과-mvck6xdy.html")).toEqual([]);
  });

  test("takes a Latin path written straight onto Chinese, Japanese or Korean words", () => {
    expect(paths("请打开src/app.ts文件")).toEqual(["src/app.ts"]);
    expect(paths("まずsrc/app.tsを開いて")).toEqual(["src/app.ts"]);
    expect(paths("파일src/a.ts를 열어")).toEqual(["src/a.ts"]);
    expect(paths("修改了src/lib/filePaths.ts和src/a.ts")).toEqual(["src/lib/filePaths.ts", "src/a.ts"]);
    expect(splitFilePaths("请打开src/app.ts文件")).toEqual(["请打开", { path: "src/app.ts" }, "文件"]);
    // a digit next to a Hangul name stays part of it
    expect(paths("docs/결과2.html")).toEqual(["docs/결과2.html"]);
  });

  test("leaves words, versions and bare names as text", () => {
    expect(paths("and/or, e.g. v1.2.3, 1.0/2.5, README.md, TCP/IP")).toEqual([]);
  });

  test("starts a path once in a run of plus signs, not at every one", () => {
    // each `+` is a character a path may hold: tried from every one of them, a line of 48,000 takes half a second
    const start = performance.now();
    expect(splitFilePaths("+".repeat(48_000))).toEqual(["+".repeat(48_000)]);
    expect(splitFilePaths("+/".repeat(24_000))).toHaveLength(1);
    expect(performance.now() - start).toBeLessThan(250);
    // a plus sign before or inside a path reads as it did
    expect(paths("+src/app.ts and c++/x/y.cc, a+b/c.ts")).toEqual(["+src/app.ts", "c++/x/y.cc", "a+b/c.ts"]);
    expect(splitFilePaths("+~/notes/a.md")).toEqual(["+", { path: "~/notes/a.md" }]);
  });

  test("takes a code span named in any script, with spaces past its first folder", () => {
    for (const code of [".senpi/html-pages/스플릿뷰 한 줄 합치기 결과-mvck6xdy.html", "스플릿뷰.html", "/tmp/a b/x.html", "~/My Docs/notes v2.md:3", "docs/화면 캡처.png"]) expect(codeIsFilePath(code)).toBe(true);
    // a command, a phrase or two files in one span is not one path
    for (const code of ["bun scripts/check.ts", "run a.ts", "git add src/a.ts", "src/App.tsx src/styles.css", "a.ts b.ts", " /tmp/a.log", "/tmp/a  b/x.html", "my notes.md"]) expect(codeIsFilePath(code)).toBe(false);
  });

  test("takes a code span that is one file name or path", () => {
    for (const code of ["README.md", "src/app.ts", "~/x/y.png", "/tmp/a.log", "docs/demo.mp4"]) expect(codeIsFilePath(code)).toBe(true);
    for (const code of ["bun test", "1.2.3", "git log --oneline", "a/b", "foo()", "x.y()", "tool.monitor", "Math.random", "process.env", "os.path", "process.env.HOME", "console.log", "JSON.parse"]) expect(codeIsFilePath(code)).toBe(false);
    // a file of any language still opens: what is refused above is known code, not an unknown extension
    for (const code of ["main.c", "util.h", "App.vue", "go.mod", "Cargo.lock", "nginx.conf", "config.env", "src/process.env", "os.py", "std.rs", "tool.ts", "fmt.go", "app.dev", "tool.vue", "std.lock", "os.conf", "Math.js", "process.yml", "README.org", "notes.io", "example.com"]) expect(codeIsFilePath(code)).toBe(true);
  });
});

test.describe("fileLineTarget", () => {
  test("selects only the first line, not the column or range end", () => {
    for (const suffix of [":12", ":12:8", "#L12", "#L12-L18", "#L12-18"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: 12 });
    }
    expect(fileLineTarget("C:\\repo\\app.ts:12:8")).toEqual({ path: "C:\\repo\\app.ts", line: 12 });
  });
  test("leaves ordinary names intact and ignores invalid line numbers", () => {
    expect(fileLineTarget("src/app.ts")).toEqual({ path: "src/app.ts", line: null });
    expect(fileLineTarget("docs/a.md#usage")).toEqual({ path: "docs/a.md#usage", line: null });
    for (const suffix of [":0", "#L0", ":99999999999999999999"]) {
      expect(fileLineTarget(`src/app.ts${suffix}`)).toEqual({ path: "src/app.ts", line: null });
    }
  });
});


})

test.describe('ovis src/lib/diff.test.ts', () => {
test.describe("lineDiff", () => {
  test("keeps unchanged lines once and puts each change where it happened", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "same", text: "d" },
      { kind: "add", text: "e" },
    ]);
    expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x" }]);
    expect(lineDiff("gone", "")).toEqual([{ kind: "del", text: "gone" }]);
    expect(lineDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  test("gives up on a table too large, as removed then added", () => {
    const big = Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n");
    const lines = lineDiff(big, big + "\nmore");
    expect(lines.filter((line) => line.kind === "del")).toHaveLength(600);
    expect(lines.at(-1)).toEqual({ kind: "add", text: "more" });
  });
});

})

test.describe('ovis src/lib/userMessageFold.test.ts', () => {
const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

test.describe("shouldFoldUserMessage", () => {
  test("folds a message with more lines than the fold shows, and leaves one with that many open", () => {
    expect(shouldFoldUserMessage(lines(USER_MESSAGE_FOLD_LINES))).toBe(false);
    expect(shouldFoldUserMessage(lines(USER_MESSAGE_FOLD_LINES + 1))).toBe(true);
  });

  test("folds a long paste with few line breaks by its length", () => {
    expect(shouldFoldUserMessage("x".repeat(USER_MESSAGE_FOLD_CHARS))).toBe(false);
    expect(shouldFoldUserMessage("x".repeat(USER_MESSAGE_FOLD_CHARS + 1))).toBe(true);
    expect(shouldFoldUserMessage(`${"word ".repeat(100)}\n${"word ".repeat(100)}`)).toBe(true);
  });

  test("never folds a short or blank message", () => {
    expect(shouldFoldUserMessage("")).toBe(false);
    expect(shouldFoldUserMessage("   \n\n  ")).toBe(false);
    expect(shouldFoldUserMessage("Nice. Now add a metric for replayed requests.")).toBe(false);
  });

  test("does not count blank lines around the message", () => {
    expect(shouldFoldUserMessage(`\n\n${lines(USER_MESSAGE_FOLD_LINES)}\n\n\n`)).toBe(false);
  });

  test("measures a link or an image by its label, not its address", () => {
    const address = `https://example.test/${"a".repeat(2000)}`;
    expect(shouldFoldUserMessage(`See [the file](${address}) and ![shot](<${address}>).`)).toBe(false);
    expect(visibleUserMessageText(`[the file](${address})`)).toBe("the file");
    expect(visibleUserMessageText(`![shot](<${address}>)`)).toBe("shot");
    expect(shouldFoldUserMessage(`[${"label ".repeat(200)}](${address})`)).toBe(true);
  });

  test("counts a fenced paste's lines like any others", () => {
    expect(shouldFoldUserMessage(`Here is the log:\n\`\`\`\n${lines(USER_MESSAGE_FOLD_LINES)}\n\`\`\``)).toBe(true);
  });
});


})

test.describe('ovis src/lib/modelName.test.ts', () => {
test.describe("modelLabel", () => {
  test("names a Claude id by the vendor's family and version", () => {
    expect(modelLabel("claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
    expect(modelLabel("claude-sonnet-5")).toEqual({ text: "Sonnet 5", named: true });
    expect(modelLabel("claude-haiku-4-5")).toEqual({ text: "Haiku 4.5", named: true });
    expect(modelLabel("claude-opus-4-1")).toEqual({ text: "Opus 4.1", named: true });
    expect(modelLabel("claude-fable-5-1")).toEqual({ text: "Fable 5.1", named: true });
  });

  test("reads the vendor's own provider prefix as the same model", () => {
    expect(modelLabel("anthropic/claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
  });

  test("names a bare GPT or GLM version", () => {
    expect(modelLabel("gpt-5.6")).toEqual({ text: "GPT-5.6", named: true });
    expect(modelLabel("gpt-6")).toEqual({ text: "GPT-6", named: true });
    expect(modelLabel("glm-5.3")).toEqual({ text: "GLM-5.3", named: true });
  });

  test("names the one GPT tier Codex's own status line writes, with its hyphen", () => {
    expect(modelLabel("gpt-5.6-sol")).toEqual({ text: "GPT-5.6-Sol", named: true });
    expect(modelLabel("gpt-6-sol")).toEqual({ text: "GPT-6-Sol", named: true });
  });

  test("shows an id it cannot name for certain exactly as received", () => {
    for (const id of [
      // a dated snapshot: the date is not dropped
      "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]", "claude-opus-5-5-fast",
      // the older order of family and version, and a family the vendor does not list
      "claude-3-5-sonnet-20241022", "claude-3", "claude-nova-5",
      // tier and product words
      "gpt-5.6-sol-max", "gpt-5.6-Sol", "gpt-5.6-solo", "gpt-sol", "gpt-5.6-sol-codex-preview-2026-10", "gpt-4.1-mini", "gpt-transcribe",
      // another provider's route, another vendor, and ids that only look close
      "bedrock/claude-opus-5-5", "openrouter/anthropic/claude-opus-5-5", "openai/gpt-5.6", "anthropic/x",
      "qwen-3-8-flash", "grok-4.7", "glm-5.3-air", "Claude-Opus-5-5", " claude-opus-5-5", "codex-test-model", "<synthetic>", "",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
  });

  test("shows a version with a leading zero as the id it is, for every vendor", () => {
    for (const id of [
      "claude-sonnet-5-05", "claude-opus-05-5", "claude-opus-05", "claude-opus-0-5", "claude-opus-0", "claude-opus-5-00", "anthropic/claude-sonnet-5-05",
      "gpt-05.6", "gpt-5.06", "gpt-05", "gpt-0", "gpt-0.5", "gpt-05.6-sol", "gpt-5.06-sol",
      "glm-05.3", "glm-5.03", "glm-05", "glm-0",
      // a minor of 0 is the vendor's form only for Anthropic: the others write the bare major
      "gpt-5.0", "gpt-5.0-sol", "glm-5.0",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
    expect(modelLabel("claude-opus-4-0")).toEqual({ text: "Opus 4.0", named: true });
    expect(modelLabel("claude-sonnet-10-10")).toEqual({ text: "Sonnet 10.10", named: true });
  });

  test("shows every other shape that is not the vendor's canonical form as received", () => {
    for (const id of [
      // an empty part
      "claude-opus-", "claude-opus--5", "claude--5-5", "claude-opus-5--5", "gpt-", "gpt-.6", "gpt--sol", "glm-", "glm-.3", "anthropic/", "/claude-opus-5-5",
      // a part too long, or too many parts
      "claude-opus-555", "claude-opus-5-555", "claude-opus-5-5-5", "gpt-555", "gpt-5.666", "gpt-5.6.1", "glm-555", "glm-5.333", "glm-5.3.1",
      // a trailing or a wrong separator
      "claude-opus-5-5-", "claude-opus-5-", "claude-opus-5.5", "claude_opus_5_5", "gpt-5.", "gpt-5.6-", "gpt-5.6-sol-", "gpt-5-6", "gpt5.6", "glm-5.", "glm-5.3-", "glm-5-3",
      // uppercase anywhere
      "CLAUDE-opus-5-5", "claude-Opus-5-5", "claude-OPUS-5-5", "Anthropic/claude-opus-5-5", "GPT-5.6", "Gpt-5.6", "gpt-5.6-SOL", "GLM-5.3", "Glm-5.3",
      // whitespace before, inside or after, and digits that are not ASCII
      "claude-opus-5-5 ", "claude-opus-5-5\n", "\nclaude-opus-5-5", "claude-opus -5-5", "claude-opus-5\t-5", "gpt-5.6 ", "gpt-5.6\n", " gpt-5.6", "gpt- 5.6", "glm-5.3\n", "glm-5.3\u00a0",
      "claude-opus-\uff15-\uff15", "gpt-\u0665.\u0666",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
  });

  // The accepted consequence of naming by the vendor's id syntax and not from a list of released
  // versions: a well-formed id is named even where no such model exists, so that a new model
  // needs no change here. This is by design; do not turn it into a list.
  test("names a well-formed id of a version nobody released", () => {
    expect(modelLabel("claude-opus-9-9")).toEqual({ text: "Opus 9.9", named: true });
    expect(modelLabel("claude-mythos-12")).toEqual({ text: "Mythos 12", named: true });
    expect(modelLabel("gpt-10")).toEqual({ text: "GPT-10", named: true });
    expect(modelLabel("gpt-9.9-sol")).toEqual({ text: "GPT-9.9-Sol", named: true });
    expect(modelLabel("glm-9.9")).toEqual({ text: "GLM-9.9", named: true });
    expect(modelLabel("glm-10.10")).toEqual({ text: "GLM-10.10", named: true });
  });
});

})

test.describe('ovis src/lib/todos.test.ts', () => {
const call = (name: string, input: unknown, output = "") => ({ kind: "tool" as const, name, summary: name, input: JSON.stringify(input), output });

test.describe("todoSnapshot", () => {
  test("reads a whole-list tool's input, and an operations tool's answer only", () => {
    test.fixme(true, "chatLib.ts:3-5,TodoItem — our TodoItem has no phase field (omp/omo/gjc phase lists were left out), so the snapshot has no phase: null")
    expect(todoSnapshot(call("TodoWrite", { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }, { content: "Ship", status: "pending" }] })))
      .toEqual([{ label: "Read", phase: null, status: "completed" }, { label: "Fix", phase: null, status: "in_progress" }, { label: "Ship", phase: null, status: "pending" }]);
    expect(todoSnapshot(call("update_plan", { plan: [{ step: "Plan", status: "completed" }] }))).toEqual([{ label: "Plan", phase: null, status: "completed" }]);
    expect(todoSnapshot(call("TodoWrite", { todos: [] }))).toEqual([]);
  });

  test("is null for an unreadable list and for other tools", () => {
    expect(todoSnapshot({ ...call("TodoWrite", {}), input: "{not json" })).toBeNull();
    expect(todoSnapshot(call("TodoWrite", { todos: "x" }))).toBeNull();
    expect(todoSnapshot(call("TodoWrite", { todos: [{ status: "completed" }] }))).toBeNull();
    expect(todoSnapshot(call("Bash", { todos: [] }))).toBeNull();
  });
});

})

test.describe('ovis src/lib/workBlocks.test.ts', () => {
const tool = (name: string, summary = name): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary, input: "{}", output: "" });
const text = (value: string): Extract<ConversationPart, { kind: "text" }> => ({ kind: "text", text: value });
const thinking = (value: string): Extract<ConversationPart, { kind: "thinking" }> => ({ kind: "thinking", text: value });

test.describe("turnSegments", () => {
  test("keeps words written before a tool above it, and each run of work where it happened", () => {
    const parts = [thinking("hm"), text("I'll check."), tool("eval"), tool("eval"), text("  \n"), text("Found it."), tool("edit"), text("Done.")];
    expect(turnSegments(parts)).toEqual([
      { kind: "work", start: 0, parts: [thinking("hm")] },
      { kind: "answer", start: 1, parts: [text("I'll check.")] },
      { kind: "work", start: 2, parts: [tool("eval"), tool("eval")] },
      { kind: "answer", start: 5, parts: [text("Found it.")] },
      { kind: "work", start: 6, parts: [tool("edit")] },
      { kind: "answer", start: 7, parts: [text("Done.")] },
    ]);
  });

  test("names each run by its first part, so a run that splits keeps the later run's name", () => {
    const before = turnSegments([tool("A"), text(""), tool("B"), text("between"), tool("C")]);
    const after = turnSegments([tool("A"), text("arrived"), tool("B"), text("between"), tool("C")]);
    const runs = (segments: typeof before) => segments.flatMap((segment) => segment.kind === "work" ? [segment.start] : []);
    expect(runs(before)).toEqual([0, 4]);
    expect(runs(after)).toEqual([0, 2, 4]);
  });

  test("keeps commentary inside its run of work and a tools-then-answer turn as one run", () => {
    const narration = { ...text("looking\u2026"), phase: "commentary" as const };
    expect(turnSegments([tool("read"), narration, tool("edit"), text("done")])).toEqual([
      { kind: "work", start: 0, parts: [tool("read"), narration, tool("edit")] },
      { kind: "answer", start: 3, parts: [text("done")] },
    ]);
    expect(turnSegments([])).toEqual([]);
  });
});

test.describe("workStartsOpen", () => {
  const commentary = (value: string) => ({ ...text(value), phase: "commentary" as const });
  const final = (value: string) => ({ ...text(value), phase: "final_answer" as const });

  test("is open while the turn runs, whatever it holds", () => {
    expect(workStartsOpen(true, [tool("read"), text("done")])).toBe(true);
    expect(workStartsOpen(true, [tool("bash")])).toBe(true);
  });

  test("folds a settled turn: its answer stays outside the fold", () => {
    expect(workStartsOpen(false, [thinking("hm"), tool("read"), text("looking…"), tool("edit"), text("done")])).toBe(false);
    expect(workStartsOpen(false, [commentary("Checking."), tool("exec_command"), final("All good.")])).toBe(false);
    // an action after the answer hides no words
    expect(workStartsOpen(false, [commentary("Checking."), tool("exec_command"), final("Done"), tool("cleanup")])).toBe(false);
  });

  test("folds a settled turn when an unphased answer is followed by an action because the answer remains visible", () => {
    expect(workStartsOpen(false, [text("The answer"), tool("bash")])).toBe(false);
    // a todo update after the closing summary is not even counted in the header
    expect(workStartsOpen(false, [tool("read"), text("Here is the full answer."), tool("TodoWrite")])).toBe(false);
  });

  test("keeps a settled turn open when it ends in Codex commentary: folding would hide its last text", () => {
    expect(workStartsOpen(false, [tool("exec_command"), commentary("Still investigating")])).toBe(true);
    expect(workStartsOpen(false, [commentary("Checking the second request.")])).toBe(true);
    // reasoning recorded after the last words does not hide them either
    expect(workStartsOpen(false, [tool("exec_command"), commentary("Still investigating"), thinking("hm")])).toBe(true);
  });

  test("keeps a settled turn open when commentary comes after its final answer: the answer is not the end", () => {
    expect(workStartsOpen(false, [tool("exec_command"), final("Done."), commentary("Resumed: still looking")])).toBe(true);
    expect(workStartsOpen(false, [tool("exec_command"), final("Done."), commentary("Resumed"), tool("exec_command")])).toBe(true);
  });

  test("stays folded when the turn did nothing readable", () => {
    expect(workStartsOpen(false, [])).toBe(false);
    expect(workStartsOpen(false, [thinking("hm")])).toBe(false);
    expect(workStartsOpen(false, [tool("bash"), text("  ")])).toBe(false);
  });
});

test.describe("workSummary", () => {
  test("counts by what the reader cares about, singular and plural", () => {
    expect(workSummary([tool("Edit"), tool("Write"), tool("read"), tool("Bash"), tool("WebFetch")])).toBe("2 edits · 1 file read · 1 command · 1 other tool");
  });

  test("is empty for reasoning and prose alone", () => {
    expect(workSummary([thinking("x"), text("y")])).toBe("");
  });

  test("leaves todo updates out of the counts", () => {
    expect(workSummary([tool("TodoWrite"), tool("Edit"), tool("update_plan"), tool("todo_write"), tool("Read")])).toBe("1 edit · 1 file read");
  });
});

test.describe("formatWorkDuration", () => {
  test("formats seconds, minutes and rejects unknown or negative spans", () => {
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:07.4Z")).toBe("7s");
    expect(formatWorkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
    expect(formatWorkDuration(null, "2026-01-01T00:00:00Z")).toBeNull();
  });
});

test.describe("workFailed", () => {
  const failed: ConversationPart = { kind: "tool", name: "Bash", summary: "", input: "", output: "", error: true };

  test("counts the calls that failed, apart from the summary a narrow header cuts short", () => {
    const parts = [tool("Edit"), failed, failed];
    expect(workSummary(parts)).toBe("1 edit · 2 commands");
    expect(workFailed(parts)).toBe(2);
    expect(workFailed([tool("Edit"), thinking("x"), text("y")])).toBe(0);
  });

  test("counts a failed call the summary does not count", () => {
    const parts: ConversationPart[] = [{ ...failed, name: "TodoWrite" }];
    expect(workSummary(parts)).toBe("");
    expect(workFailed(parts)).toBe(1);
  });
});

test("does not title a turn that ended on its final answer as running when the agent begins another by itself", () => {
  // our isLiveWorkTurn takes `working: boolean` (no herdr status), so "working" is passed as true
  const answered = { role: "assistant" as const, ts: null, parts: [tool("Glob"), { kind: "text" as const, text: "The subagent is still running.", phase: "final_answer" as const }] };
  // a background task ended: herdr says working, the new turn has no row yet, and nothing was sent from here
  expect(isLiveWorkTurn(answered, true, true)).toBe(false);
  // words that are no final answer yet are the running turn's own
  expect(isLiveWorkTurn({ ...answered, parts: [answered.parts[0]!, { kind: "text" as const, text: "Let me look." }] }, true, true)).toBe(true);
});

})

test.describe('ovis src/lib/highlight.test.ts', () => {
const text = (lines: Lines) => lines.map((line) => line.map((token) => token.text).join(""));
/** `code` highlighted as a view does: normalized first. */
const highlight = (code: string, language: string) => highlightNow(normalizeCode(code), language);

test.describe("languageForFence", () => {
  test("knows aliases and the first word only", () => {
    expect(languageForFence("ts")).toBe("ts");
    expect(languageForFence("typescript")).toBe("ts");
    expect(languageForFence("TSX title=x")).toBe("tsx");
    expect(languageForFence("javascript")).toBe("js");
    expect(languageForFence("sh")).toBe("shell");
    expect(languageForFence("bash")).toBe("shell");
    expect(languageForFence("yml")).toBe("yaml");
    expect(languageForFence("dockerfile")).toBe("dockerfile");
    expect(languageForFence("c")).toBe("cpp");
    expect(languageForFence("scss")).toBe("css");
  });
  test("returns null for nothing or the unknown", () => {
    expect(languageForFence("")).toBeNull();
    expect(languageForFence("klingon")).toBeNull();
  });
  test("returns null for plain text, which is registered but no language", () => {
    for (const word of ["text", "txt", "plaintext", "TXT"]) expect(languageForFence(word)).toBeNull();
  });
  test("maps the Markdown spellings to markdown", () => {
    for (const word of ["md", "markdown", "mkd", "mdown", "mkdn"]) expect(languageForFence(word)).toBe("markdown");
  });
});

test.describe("highlightNow", () => {
  test("keeps a multi-line comment's role on every line it spans", () => {
    const lines = highlight("/* a\nb */\nconst x = 1;", "ts");
    expect(text(lines)).toEqual(["/* a", "b */", "const x = 1;"]);
    expect(lines[0]!.every((t) => t.role === "comment")).toBe(true);
    expect(lines[1]!.every((t) => t.role === "comment")).toBe(true);
    expect(lines[2]!.find((t) => t.text === "const")?.role).toBe("keyword");
    expect(lines[2]!.find((t) => t.text === "1")?.role).toBe("number");
  });
  test("keeps a template string's role across lines", () => {
    const lines = highlight("const s = `a\nb`;", "js");
    expect(lines[1]!.find((t) => t.text.includes("b"))?.role).toBe("string");
  });
  test("maps diff lines to inserted and deleted", () => {
    const lines = highlight("+added\n-removed", "diff");
    expect(lines[0]![0]!.role).toBe("inserted");
    expect(lines[1]![0]!.role).toBe("deleted");
  });
  test("preserves final newlines and blank lines as source text", () => {
    expect(text(highlight("a\nb\n", "ts"))).toEqual(["a", "b", ""]);
    expect(text(highlight("a\n\n", "ts"))).toEqual(["a", "", ""]);
  });
  test("splits CRLF without keeping the carriage return", () => {
    expect(text(highlight("a\r\nb", "ts"))).toEqual(["a", "b"]);
  });
  test("reads a class name as a type and a function's name as a function", () => {
    const lines = highlight("class Box {}\nfunction run() {}", "ts");
    expect(lines[0]!.find((t) => t.text === "Box")?.role).toBe("type");
    expect(lines[1]!.find((t) => t.text === "run")?.role).toBe("function");
  });
  test("colors Markdown's headings, inline code and links", () => {
    const lines = highlight("# Title\nsome `code` and [a](b)", "markdown");
    expect(lines[0]![0]).toEqual({ text: "# Title", role: "function" });
    expect(lines[1]!.find((t) => t.text === "`code`")?.role).toBe("string");
    expect(lines[1]!.find((t) => t.text === "[a](b)")?.role).toBe("variable");
  });
  test("keeps the source exactly, whatever the language", () => {
    const code = "const a = `x${'y'}`; // z\n<div a=\"b\">{c}</div>\n\n\t\"\\\"\"";
    for (const language of ["ts", "tsx", "markdown", "json", "yaml", "shell", "html"]) {
      expect(text(highlight(code, language)).join("\n")).toBe(normalizeCode(code));
    }
  });
  test("returns the same lines for the same call, so a remounted view does not tokenize again", () => {
    expect(highlightNow("const x = 1;", "ts")).toBe(highlightNow("const x = 1;", "ts"));
  });
  test("gives plain lines when the highlighter fails", () => {
    expect(highlightNow("x", "klingon")).toEqual([[{ text: "x", role: null }]]);
  });
});

test.describe("highlightRuns and linesFromRuns", () => {
  test("merge neighbors of one role and add up to the source", () => {
    const source = "const a = 1;\nconst b = 2;";
    const runs = highlightRuns(source, "ts");
    expect([...runs.lengths].reduce((sum, length) => sum + length, 0)).toBe(source.length);
    for (let i = 1; i < runs.roles.length; i++) expect(runs.roles[i]).not.toBe(runs.roles[i - 1]);
    expect(text(linesFromRuns(source, runs))).toEqual(["const a = 1;", "const b = 2;"]);
  });
  test("leave a source the runs fall short of plain past them", () => {
    const runs = highlightRuns("const", "ts");
    const lines = linesFromRuns("const x\ny", runs);
    expect(lines).toEqual([[{ text: "const", role: "keyword" }, { text: " x", role: null }], [{ text: "y", role: null }]]);
  });
  test("give one empty line for an empty source", () => {
    expect(linesFromRuns("", highlightRuns("", "ts"))).toEqual([[]]);
    expect(plainLines("")).toEqual([[]]);
  });
});

test.describe("extendLines", () => {
  test("keeps the colored lines and adds the tail plain", () => {
    const lines = highlight("const a", "ts");
    const extended = extendLines(lines, " = 1;\nlet b\n");
    expect(text(extended)).toEqual(["const a = 1;", "let b", ""]);
    expect(extended[0]![0]).toEqual({ text: "const", role: "keyword" });
    expect(extended[1]).toEqual([{ text: "let b", role: null }]);
    expect(text(lines)).toEqual(["const a"]);
  });
  test("returns the lines themselves for no tail", () => {
    const lines = highlight("x", "ts");
    expect(extendLines(lines, "")).toBe(lines);
  });
});

test.describe("SYNC_HIGHLIGHT_LIMIT", () => {
  // what is highlighted while the page draws must stay quick in the worst shapes measured: runs the
  // tokenizer rescans to the end (an unterminated string of escapes, a line of dashes in YAML)
  for (const [language, unit] of [
    ["json", "\"\\"], ["yaml", "--"], ["css", "\"\\"], ["python", "\"\\"], ["vue", "<a "], ["markdown", "[["], ["ts", "x=/[/"],
  ] as [string, string][]) test(`keeps ${language} of ${JSON.stringify(unit)} well under a frame's budget`, () => {
    const code = unit.repeat(Math.ceil(SYNC_HIGHLIGHT_LIMIT / unit.length)).slice(0, SYNC_HIGHLIGHT_LIMIT);
    highlightRuns(code, language);
    // the fastest of a few runs: a garbage collection or a busy runner delays one run, never all
    const runs = Array.from({ length: 5 }, () => {
      const start = performance.now();
      highlightRuns(code, language);
      return performance.now() - start;
    });
    expect(Math.min(...runs)).toBeLessThan(50);
  });
});

test.describe("countLines", () => {
  test("counts the lines of a normalized source, a blank one included", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n\nb")).toBe(3);
    expect(countLines("\n".repeat(LINE_ELEMENT_LIMIT))).toBe(LINE_ELEMENT_LIMIT + 1);
  });
});

test.describe("canHighlight", () => {
  test("knows the registered languages and nothing else", () => {
    expect(canHighlight("ts")).toBe(true);
    expect(canHighlight("typescript")).toBe(false);
    expect(canHighlight(null)).toBe(false);
  });
});

})

test.describe('ovis shared/patch.test.ts', () => {
const PATCH = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hi\n*** End Patch\n";

test.describe("Codex patches", () => {
  test("finds a patch given whole, or as the string an exec script hands to tools.apply_patch", () => {
    expect(patchText(PATCH)).toBe(PATCH);
    const script = `text(await tools.apply_patch(${JSON.stringify(PATCH)}));\nconsole.log("done")`;
    expect(patchText(script)).toBe(PATCH);
    expect(patchText("await tools.apply_patch(`" + PATCH + "`)")).toBe(PATCH);
    expect(patchText("tools.exec_command({cmd: 'ls'})")).toBeNull();
    expect(patchText('tools.apply_patch("not a patch")')).toBeNull();
  });

  test("names each file a patch touches once, in order", () => {
    expect(patchFiles(PATCH + "*** Update File: src/a.ts\n*** Delete File: old.txt\n")).toEqual(["src/a.ts", "docs/b.md", "old.txt"]);
  });
});

})

test.describe('ovis server/tool-output.test.ts', () => {
test("a goal call's answer stays whole up to 16000 characters: its JSON, status and all, reaches the chat", () => {
  const objective = "o".repeat(3990);
  const answer = JSON.stringify({ goal: { objective, status: "complete", tokensUsed: 1, timeUsedSeconds: 2 } }, null, 2);
  expect(answer.length).toBeGreaterThan(TOOL_OUTPUT_CHARS);
  const goal: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "update_goal", summary: "", input: "{}", output: "" };
  trimOutput(goal, answer, "ref");
  expect(goal.output).toBe(answer);
  expect(goal.output_ref).toBeUndefined();
  const other: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  trimOutput(other, answer, "ref");
  expect(other.output.endsWith("… trimmed")).toBe(true);
  expect(other.output_ref).toBe("ref");
});

test("reports true stored output size when a tool result was cut before reaching trimOutput", () => {
  const tool: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary: "", input: "{}", output: "" };
  const preview = "a".repeat(TOOL_OUTPUT_CHARS);
  trimOutput(tool, preview, "ref", 50_000);
  expect(tool.output).toBe(`${preview}\n… trimmed`);
  expect(tool.output_ref).toBe("ref");
  expect(tool.output_size).toBe(50_000);
});

})

test.describe('ovis src/lib/markdown.test.ts', () => {
test.describe("parseMarkdown", () => {
  test("parses level one through three headings", () => {
    expect(parseMarkdown("# One\n## Two\n### Three").map((block) => block.type === "heading" ? block.level : null)).toEqual([1, 2, 3]);
  });

  test("parses unordered, ordered, and one-level nested lists", () => {
    const blocks = parseMarkdown("- first\n  - nested\n- second\n\n1. one\n2. two");
    expect(blocks[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ blocks: [{ type: "list", ordered: false, items: [{ content: [{ type: "text", value: "nested" }] }] }] }, {}],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true, items: [{}, {}] });
  });

  test("keeps fenced code and its language", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```")).toEqual([{ type: "code", language: "ts", value: "const x = 1;" }]);
  });

  test("recognizes display math without parsing its contents as markdown", () => {
    const formula = "\\[\n\\mathrm{ECA@}k = \\frac{1}{N}\\sum_i \\mathbf{1}[\\text{예측}_i=\\text{정답}_i]\\,\\prod_j\\mathbf{1}[|F_i\\cap I_{ij}|\\ge k]\n\\]";
    expect(parseMarkdown(formula)).toEqual([{ type: "math", value: formula.slice(3, -3) }]);
    expect(parseMarkdown("before\n\\[x^2\\]\nafter").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("```tex\n\\[x\\]\n```")).toEqual([{ type: "code", language: "tex", value: "\\[x\\]" }]);
    expect(parseMarkdown("\\[unfinished")).toEqual([{ type: "paragraph", lines: [[{ type: "text", value: "\\[unfinished" }]] }]);
  });

  test("recognizes $$ display math and a math fence", () => {
    expect(parseMarkdown("$$\n\\int_0^1 x\\,dx\n$$")).toEqual([{ type: "math", value: "\\int_0^1 x\\,dx", dollar: true }]);
    expect(parseMarkdown("before\n$$x^2$$\nafter").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("$$unfinished\n\n# Still a heading").map((block) => block.type)).toEqual(["paragraph", "heading"]);
    expect(parseMarkdown("$$ a\n$$ b\n```\ncode\n```\n$$ c $$").map((block) => block.type)).toEqual(["paragraph", "paragraph", "code", "math"]);
    // a formula left open does not hide one a later line opens and closes, with either delimiter
    expect(parseMarkdown("$$oops\n\n# Heading\n\n$$x^2$$").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    expect(parseMarkdown("\\[oops\n\n# Heading\n\n\\[x^2\\]").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    // a blank line ends the search for a close (display math holds none), so a later formula on several lines is drawn
    expect(parseMarkdown("$$ is the shell PID.\n\nLater:\n\n$$\na^2+b^2\n$$").map((block) => block.type)).toEqual(["paragraph", "paragraph", "math"]);
    expect(parseMarkdown("\\[oops\n\n# Heading\n\n\\[\nx\n\\]").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    // nor does it reach past a line that opens a formula with the other delimiter
    expect(parseMarkdown("$$oops\n\\[\nx\n\\]\n$$").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("\\[oops\n$$\nx\n$$\n\\]").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    // a line that closes its formula and goes on in prose is prose, and takes nothing after it
    expect(parseMarkdown("$$E=mc^2$$ where E is energy\n\n## Units\n\n- joules\n\n$$\nE\n$$").map((block) => block.type)).toEqual(["paragraph", "heading", "list", "math"]);
    expect(parseMarkdown("```math\nx^2\n```")).toEqual([{ type: "code", language: "math", value: "x^2" }]);
  });


  test("keeps later markdown and code intact after an unclosed display formula", () => {
    for (const code of ["raw code", "\\]"]) {
      expect(parseMarkdown(`\\[unfinished\n\n# Still a heading\n\n\`\`\`tex\n${code}\n\`\`\`\n\n- still a list`).map((block) => block.type)).toEqual([
        "paragraph", "heading", "code", "list",
      ]);
    }
  });

  test("parses a GFM table", () => {
    const [table] = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | b |");
    expect(table).toMatchObject({ type: "table", header: [[{ value: "Name" }], [{ value: "Value" }]], rows: [[[{ value: "a" }], [{ value: "b" }]]] });
  });
});

test.describe("inline markdown", () => {
  test("turns Codex local file citations into file links, including source metadata and Unicode paths", () => {
    const path = "/Users/u/My Documents/보고서.pdf";
    const output = `:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`;
    const source = `:codex-file-citation{purpose="source" page_number="4" path=${JSON.stringify(path)}}`;
    const file: InlineNode = { type: "file", path, children: [{ type: "text", value: "보고서.pdf" }] };
    expect(parseInline(output)).toEqual([file]);
    expect(parseInline(`See ${source}.`)).toEqual([{ type: "text", value: "See " }, file, { type: "text", value: "." }]);
    const windows = "C:\\Users\\u\\My Docs\\report.docx";
    expect(parseInline(`:codex-file-citation{path=${JSON.stringify(windows)} purpose="output"}`)).toMatchObject([{ type: "file", path: windows }]);
    expect(parseInline(output, false)).toEqual([{ type: "text", value: output }]);
  });

  test("leaves incomplete, invalid and non-local Codex citations as written", () => {
    for (const citation of [
      ':codex-file-citation{path="/tmp/report.pdf" purpose="output"',
      ':codex-file-citation{path="https://example.com/x" purpose="output"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" path="/tmp/y"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" mode="live"}',
      ':codex-file-citation{path="/tmp/x" purpose="unknown"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" broken}',
    ]) expect(parseInline(citation).some((node) => node.type === "file")).toBe(false);
    const citation = ':codex-file-citation{path="/tmp/report.pdf" purpose="output"}';
    expect(parseInline(`\`${citation}\``)).toEqual([{ type: "code", value: citation }]);
    expect(parseMarkdown(`\`\`\`text\n${citation}\n\`\`\``)).toEqual([{ type: "code", language: "text", value: citation }]);
  });

  test("opens a Codex citation only where a file:/// link could: no network share, no control character", () => {
    for (const path of ["//server/share/a.txt", "\\\\server\\share\\a.txt", "/tmp/a\u007fb"]) {
      expect(parseInline(`:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`).some((node) => node.type === "file")).toBe(false);
    }
    // the same share, its slashes written as JSON escapes
    expect(parseInline(':codex-file-citation{path="\\u002f\\u002fserver/share/a.txt" purpose="output"}').some((node) => node.type === "file")).toBe(false);
  });

  test("leaves the markdown after an unfinished Codex citation as markdown, and reads a brace inside a quoted path", () => {
    const nodes = parseInline(':codex-file-citation{unfinished **urgent** and `code` } then :codex-file-citation{path="/tmp/a.pdf" purpose="output"}');
    expect(nodes.map((node) => node.type)).toEqual(["text", "strong", "text", "code", "text", "file"]);
    expect(parseInline(':codex-file-citation{path="/tmp/a}b.pdf" purpose="output"}')).toEqual([{ type: "file", path: "/tmp/a}b.pdf", children: [{ type: "text", value: "a}b.pdf" }] }]);
    expect(parseInline(':codex-file-citation{path="/tmp/a.pdf" purpose="output" }')).toMatchObject([{ type: "file", path: "/tmp/a.pdf" }]);
    // an escape JSON has no reading for is no directive: the markdown inside it stays markdown
    expect(parseInline(':codex-file-citation{path="/tmp/\\q **urgent**" purpose="output"}').some((node) => node.type === "strong")).toBe(true);
  });


  test("parses links and rejects unsafe protocols", () => {
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(parseInline("[safe](https://example.com) [unsafe](javascript:bad)" )).toMatchObject([
      { type: "link", href: "https://example.com" },
      { type: "text", value: " " },
      { type: "text", value: "unsafe" },
    ]);
  });

  test("keeps a link to a local file as that file, not only its label", () => {
    expect(parseInline("근거: [실험 결과](/home/u/repo/output/REPORT.md)")).toEqual([
      { type: "text", value: "근거: " },
      { type: "file", path: "/home/u/repo/output/REPORT.md", children: [{ type: "text", value: "실험 결과" }] },
    ]);
    expect(parseInline("[x](src/x.ts#L12) [y](~/y.md:3:1)")).toMatchObject([
      { type: "file", path: "src/x.ts#L12" },
      { type: "text", value: " " },
      { type: "file", path: "~/y.md:3:1" },
    ]);
    expect(parseInline("[range](src/x.ts#L12-L18) [section](docs/a.md#usage)")).toMatchObject([
      { type: "file", path: "src/x.ts#L12-L18" },
      { type: "text", value: " " },
      { type: "file", path: "docs/a.md" },
    ]);
    for (const target of ["javascript:bad", "data:text/html,x", "#section"]) {
      expect(parseInline(`[label](${target})`)).toEqual([{ type: "text", value: "label" }]);
    }
  });

  test("links an address written without its scheme, and leaves files and non-addresses alone", () => {
    expect(parseInline("[docs](www.example.com/x)")).toEqual([{ type: "link", href: "https://www.example.com/x", children: [{ type: "text", value: "docs" }] }]);
    expect(parseInline("[guide](docs.example.com/guide)")).toMatchObject([{ type: "link", href: "https://docs.example.com/guide" }]);
    expect(parseInline("[here](localhost:7317)")).toMatchObject([{ type: "link", href: "http://localhost:7317" }]);
    expect(parseInline("[api](api.example.com:8443/v1)")).toMatchObject([{ type: "link", href: "https://api.example.com:8443/v1" }]);
    expect(parseInline("[readme](README.md)")).toMatchObject([{ type: "file", path: "README.md" }]);
    expect(parseInline("[x](src/x.ts)")).toMatchObject([{ type: "file", path: "src/x.ts" }]);
    expect(parseInline("see www.example.com/a/b.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://www.example.com/a/b", children: [{ type: "text", value: "www.example.com/a/b" }] },
      { type: "text", value: "." },
    ]);
    // a file and its line, or a folder with a dot, is not an address
    expect(parseInline("[main.ts](main.ts:42)")).toMatchObject([{ type: "file", path: "main.ts:42" }]);
    expect(parseInline("[README.md](README.md:3:1)")).toMatchObject([{ type: "file", path: "README.md:3:1" }]);
    expect(parseInline("[notes](notes.v2/todo.md)")).toMatchObject([{ type: "file", path: "notes.v2/todo.md" }]);
    expect(parseInline("[call](tel:123)")).toEqual([{ type: "text", value: "call" }]);
    // a local server by address is plain http, as localhost is
    expect(parseInline("[server](127.0.0.1:8080)")).toMatchObject([{ type: "link", href: "http://127.0.0.1:8080" }]);
    expect(parseInline("[dev](192.168.0.10:5173/app)")).toMatchObject([{ type: "link", href: "http://192.168.0.10:5173/app" }]);
    expect(parseInline("[v](1.2.3.4)")).toMatchObject([{ type: "file", path: "1.2.3.4" }]);
    // a bare domain in prose stays prose, and a code span keeps its address as code (rendered as a link)
    expect(parseInline("example.com is fine")).toEqual([{ type: "text", value: "example.com is fine" }]);
    expect(parseInline("`https://example.com/x`")).toEqual([{ type: "code", value: "https://example.com/x" }]);
  });

  test("parses inline code, bold, italic, and strikethrough", () => {
    expect(parseInline("`code` **bold** *italic* ~~gone~~").map((node) => node.type)).toEqual([
      "code", "text", "strong", "text", "em", "text", "del",
    ]);
  });

  test("renders inline math in prose but not in code spans", () => {
    expect(parseInline("Result \\(x_i + \\frac{1}{N}\\) and `\\(raw\\)`")).toEqual([
      { type: "text", value: "Result " },
      { type: "math", value: "x_i + \\frac{1}{N}" },
      { type: "text", value: " and " },
      { type: "code", value: "\\(raw\\)" },
    ]);
    expect(parseInline("\\(unfinished")).toEqual([{ type: "text", value: "\\(unfinished" }]);
  });

  test("reads $…$ as math only where a price cannot be", () => {
    const text = (value: string): InlineNode[] => [{ type: "text", value }];
    for (const prose of [
      "costs $5 and $10 today", "$5 or $10", "from $5 to $10.", "I paid $5 for X$ and", "$20, $30 and $40",
      "a$b$c", "$x$5", "$ x$", "$x $", "\\$x$", "$$x$$ inline", "echo $HOME and $PATH", "Run $HOME/${PATH} now", "cd $HOME/$(whoami)", "echo $A$#", "$5 or six$", "${HOME} and ${PATH}", "$x$y",
    ]) expect(parseInline(prose)).toEqual(text(prose));
    expect(parseInline("$x^2$ and $\\alpha$.")).toEqual([
      { type: "math", value: "x^2", dollar: true }, { type: "text", value: " and " }, { type: "math", value: "\\alpha", dollar: true }, { type: "text", value: "." },
    ]);
    expect(parseInline("solve $2x+1 = 0$")).toEqual([{ type: "text", value: "solve " }, { type: "math", value: "2x+1 = 0", dollar: true }]);
    expect(parseInline("($E=mc^2$)")).toEqual([{ type: "text", value: "(" }, { type: "math", value: "E=mc^2", dollar: true }, { type: "text", value: ")" }]);
    expect(parseInline("$2 + 2 = 4$")).toEqual([{ type: "math", value: "2 + 2 = 4", dollar: true }]);
    // a formula touching Korean, Japanese or Chinese text (a particle) is still one
    expect(parseInline("$x$는 실수이다")).toEqual([{ type: "math", value: "x", dollar: true }, { type: "text", value: "는 실수이다" }]);
    expect(parseInline("함수 $f(x)$를 보자").map((node) => node.type)).toEqual(["text", "math", "text"]);
    expect(parseInline("값은$x$이다").map((node) => node.type)).toEqual(["text", "math", "text"]);
    // sentence punctuation after a formula ends the sentence, not the formula
    for (const end of ["?", "!", ".", ","]) expect(parseInline(`What is $x$${end}`).map((node) => node.type)).toEqual(["text", "math", "text"]);
    expect(parseInline("$3$ apples")).toEqual([{ type: "math", value: "3", dollar: true }, { type: "text", value: " apples" }]);
    expect(parseInline("`$x$`")).toEqual([{ type: "code", value: "$x$" }]);
    // a code span after a dollar stays a code span: its backtick never joins a formula
    expect(parseInline("$x `y$` z")).toEqual([{ type: "text", value: "$x " }, { type: "code", value: "y$" }, { type: "text", value: " z" }]);
    expect(parseInline("Set $FOO `bar$`")).toEqual([{ type: "text", value: "Set $FOO " }, { type: "code", value: "bar$" }]);
    expect(parseInline("$a`$ b")).toEqual([{ type: "text", value: "$a`$ b" }]);
  });

  test("preserves underscores in identifiers while retaining standalone emphasis", () => {
    for (const value of ["MAC_QA_CHAT_OK", "api_key_name", "foo__bar__baz", "한글_세션_이름"]) {
      expect(parseInline(value)).toEqual([{ type: "text", value }]);
    }
    expect(parseInline("_italic_ (__bold__) `api_key_name`").map((node) => node.type)).toEqual([
      "em", "text", "strong", "text", "code",
    ]);
    expect(parseInline("__MAC_QA_CHAT_OK__")).toEqual([
      { type: "strong", children: [{ type: "text", value: "MAC_QA_CHAT_OK" }] },
    ]);
  });
});

test.describe("autolinks", () => {
  const link = (href: string): InlineNode => ({ type: "link", href, children: [{ type: "text", value: href }] });

  test("links a bare http(s) URL and keeps the text around it", () => {
    expect(parseInline("https://github.com/devswha/ovis/pull/36 이런거")).toEqual([
      link("https://github.com/devswha/ovis/pull/36"),
      { type: "text", value: " 이런거" },
    ]);
    // no space before Korean: the address ends at the first non-ASCII character
    expect(parseInline("see https://example.com/a에서 확인")).toEqual([
      { type: "text", value: "see " }, link("https://example.com/a"), { type: "text", value: "에서 확인" },
    ]);
  });

  test("leaves the sentence's punctuation out, and keeps parentheses the URL opened", () => {
    expect(parseInline("(see https://example.com/a).")).toEqual([
      { type: "text", value: "(see " }, link("https://example.com/a"), { type: "text", value: ")." },
    ]);
    expect(parseInline("https://en.wikipedia.org/wiki/Rust_(language), then")).toEqual([
      link("https://en.wikipedia.org/wiki/Rust_(language)"), { type: "text", value: ", then" },
    ]);
    expect(parseInline("done: https://example.com/x?y=1&z=2!")).toEqual([
      { type: "text", value: "done: " }, link("https://example.com/x?y=1&z=2"), { type: "text", value: "!" },
    ]);
  });

  test("links an <angle> URL, and nothing inside code, a markdown link, or another scheme", () => {
    expect(parseInline("<https://example.com/a>")).toEqual([link("https://example.com/a")]);
    expect(parseInline("`https://example.com`")).toEqual([{ type: "code", value: "https://example.com" }]);
    expect(parseInline("[https://example.com](https://example.com/b)")).toEqual([
      { type: "link", href: "https://example.com/b", children: [{ type: "text", value: "https://example.com" }] },
    ]);
    for (const value of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "http:/x"]) {
      expect(parseInline(value).some((node) => node.type === "link")).toBe(false);
    }
  });

  test("links inside emphasis", () => {
    expect(parseInline("**https://example.com**")).toEqual([{ type: "strong", children: [link("https://example.com")] }]);
  });
  test("opens a labeled local file URI through the file viewer", () => {
    expect(parseInline("file:///tmp/README.md")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "file:///tmp/README.md" }] },
    ]);
    // Korean written straight after the address is prose, as it is after an http one
    expect(parseInline("file:///tmp/a.md에서 확인")).toEqual([
      { type: "file", path: "/tmp/a.md", children: [{ type: "text", value: "file:///tmp/a.md" }] },
      { type: "text", value: "에서 확인" },
    ]);
    expect(parseInline("file:///tmp/Bob's-notes.md")).toEqual([
      { type: "file", path: "/tmp/Bob's-notes.md", children: [{ type: "text", value: "file:///tmp/Bob's-notes.md" }] },
    ]);
    expect(parseInline("[README](file:///tmp/README.md)")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "README" }] },
    ]);
  });
});

test.describe("foldCode", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  test("shows blocks up to the limit whole", () => {
    expect(foldCode(lines(12))).toBeNull();
    expect(foldCode(lines(FOLD_CODE_AFTER_LINES))).toBeNull();
  });

  test("folds a longer block to its first lines and counts all of them", () => {
    const fold = foldCode(lines(382));
    expect(fold?.lines).toBe(382);
    expect(fold?.head.split("\n")).toHaveLength(FOLDED_CODE_LINES);
    expect(fold?.head.startsWith("line 1\n")).toBe(true);
    expect(fold?.head.endsWith(`line ${FOLDED_CODE_LINES}`)).toBe(true);
  });
});

/**
 * This thread's CPU time in milliseconds, where the system keeps a clock for it (Linux, macOS), or
 * null. process.threadCpuUsage() counts in whole ticks of a millisecond, so a run of two read none
 * on a busy runner, and the ratio was infinite.
 */
// ovis reads the thread CPU clock through bun:ffi; Node has no such call, so the process clock fallback it ships is used
const threadClock = null as (() => number) | null;

test.describe("text no one wrote by hand", () => {
  // These eight time the parser's CPU on texts up to 200k characters (about 2 minutes together), which
  // does not fit a unit run. Opt in like T68: OVIS_PERF=1 npx playwright test tests/terminal/t80-ovis-port-unit.spec.ts
  test.skip(!process.env.OVIS_PERF, "CPU-time linearity checks (~2 min) — run with OVIS_PERF=1");
  // what an agent prints, or a changelog holds, is not always prose: the page parses it while it
  // draws, so a line that takes seconds freezes the tab, and one that nests without end crashes it
  /**
   * What `parse` makes of `text(size)`, having checked that it reads in linear time: ten times the
   * text takes under thirty times as long (linear is ten, a search of the rest of the line from
   * every character a hundred). A budget in milliseconds failed on GitHub's runners with nothing
   * slower in the parser, so this counts the CPU time this thread spent, which a busy runner does
   * not stretch as it does the clock (the process's time also counts the compiler's and the garbage
   * collector's threads, and reached 32 on a busy runner, #2084). Small and large are timed in
   * turn, up to five rounds, and the fastest of each are compared: being preempted or slowed only
   * adds time, so the fastest run is the one closest to the parser's own work. A count of the
   * parser's steps would not see what some of these cases guard against, a regular expression
   * backtracking in one call.
   */
  const linear = <T,>(text: (size: number) => string, size: number, parse: (text: string) => T): T => {
    const small = text(size / 10);
    const large = text(size);
    // both read once untimed, so the first timed run is not the one that compiles the parser
    parse(small);
    const read = parse(large);
    const cpu = (): number => {
      if (threadClock !== null) return threadClock();
      const { user, system } = process.cpuUsage();
      return (user + system) / 1000;
    };
    // a parse of microseconds is timed over as many runs as take two milliseconds; twenty where the
    // process's clock may count in steps of milliseconds, so no run of the small text reads none
    const shortest = threadClock === null ? 20 : 2;
    let runs = 1;
    const timed = (input: string): number => {
      const start = cpu();
      for (let run = 0; run < runs; run += 1) parse(input);
      return cpu() - start;
    };
    while (timed(small) < shortest) runs *= 2;
    let fastestSmall = Infinity;
    let fastestLarge = Infinity;
    for (let round = 0; round < 5 && !(fastestLarge / fastestSmall < 30); round += 1) {
      fastestSmall = Math.min(fastestSmall, timed(small));
      fastestLarge = Math.min(fastestLarge, timed(large));
    }
    expect(fastestLarge / fastestSmall).toBeLessThan(30);
    return read;
  };
  /** every string of up to `length` of the `parts`, in order */
  const everyLine = (parts: string[], length: number): string[] => {
    let lines = [""];
    const all = [""];
    for (let step = 0; step < length; step += 1) {
      lines = lines.flatMap((line) => parts.map((part) => line + part));
      all.push(...lines);
    }
    return all;
  };

  test("cuts a URL's closing parentheses as it did, counting them once", () => {
    // the rule as it was written first: both counts taken again at every closing parenthesis
    const asBefore = (url: string): string => {
      let end = url.length;
      for (;;) {
        const last = url[end - 1];
        if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
        if (last === ")") {
          const text = url.slice(0, end);
          if (text.split(")").length > text.split("(").length) { end -= 1; continue; }
        }
        break;
      }
      return url.slice(0, end);
    };
    const urls = everyLine(["a", "(", ")", ".", "_"], 6).map((tail) => `https://x.dev/${tail}`);
    expect(urls.length).toBeGreaterThan(19_000);
    for (const url of urls) expect(trimUrl(url)).toBe(asBefore(url));
    const closing = (count: number): string => `https://x.dev/${")".repeat(count)}`;
    expect(linear(closing, 48_000, trimUrl)).toBe("https://x.dev/");
    linear(closing, 48_000, (text) => parseMarkdown(text));
  });

  test("knows a table's separator line as it did, cell by cell", () => {
    // the one pattern it was: it shares a run of spaces between its parts in every way there is
    const asBefore = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
    const lines = everyLine([" ", "|", "---", "--", ":", "x"], 6);
    expect(lines.length).toBeGreaterThan(55_000);
    let separators = 0;
    for (const line of lines) {
      expect(`${line}: ${isTableSeparator(line)}`).toBe(`${line}: ${asBefore.test(line)}`);
      if (isTableSeparator(line)) separators += 1;
    }
    expect(separators).toBeGreaterThan(100);
    for (const line of ["|---|---|", "---|---", " | :--- | ---: | :---: | ", "\t|---\t|\t---|\t", "|--|--|", "|---|:-:|-|"]) expect(isTableSeparator(line)).toBe(true);
    for (const line of ["", "---", "|---|", "||---|---", "|---|---||", "|---|:|", "|---|-x-|"]) expect(isTableSeparator(line)).toBe(false);
    linear((spaces) => `a|b\n${" ".repeat(spaces)}x`, 96_000, (text) => parseMarkdown(text));
    linear((spaces) => `a|b\n---|---${" ".repeat(spaces)}x`, 96_000, (text) => parseMarkdown(text));
  });

  test("looks once for the end of a formula that never closes", () => {
    const indexOf = String.prototype.indexOf;
    // characters the closer searches read, not how many there are: one search per opener over the
    // rest of the text is as many calls as one per line, but reads the text over and over
    let scanned = 0;
    let expectedMaximum = 0;
    const closer = spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, position) {
      const found = indexOf.call(this, search, position);
      if (search === "\\]") {
        const from = Math.max(0, Math.min(this.length, Number(position ?? 0)));
        scanned += (found === -1 ? this.length : found + search.length) - from;
        // Fail promptly on a quadratic search instead of finishing its work.
        expect(scanned).toBeLessThanOrEqual(expectedMaximum);
      }
      return found;
    });
    let blocks: ReturnType<typeof parseMarkdown> = [];
    try {
      for (const lines of [3_200, 32_000]) {
        const text = "\\[\n".repeat(lines);
        scanned = 0;
        // the text read about once, with a few characters for each line's own search
        expectedMaximum = text.length + 4 * (lines + 1);
        blocks = parseMarkdown(text);
        expect(scanned).toBeGreaterThan(0);
        expect(scanned).toBeLessThanOrEqual(expectedMaximum);
      }
    } finally {
      closer.mockRestore();
    }
    expect(blocks).toHaveLength(32_000);
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    // the search ends at a fence: what opens after it is looked for again
    expect(parseMarkdown("\\[ a\n\\[ b\n```\ncode\n```\n\\[ c \\]\n\\[ d").map((block) => block.type))
      .toEqual(["paragraph", "paragraph", "code", "math", "paragraph"]);
  });

  test("looks once for what closes a bracket, an inline formula or an underscore", () => {
    const exec = RegExp.prototype.exec;
    // These searches have no variable-length backtracking inside one attempt. The token pattern
    // is deliberately absent: a single global exec of it can search quadratically before failing.
    const searches = new Set([
      /[`[<*_~$]|:codex-file-citation\{|\\\(|file:\/\/\/|https?:\/\/|www\./g,
      /\n/g, /}/g, /[\n\r\u2028\u2029]/g, /\\\)/g, /\$/g, /[\]\n]/g, /[\s)]/g,
      /(?<=\S)_(?![\p{L}\p{N}\p{M}_])/gu,
      /(?<=\S)__(?![\p{L}\p{N}\p{M}_])/gu,
      // Only the single-underscore token can succeed in the last fixture; trying the bold
      // alternative first would rescan the whole suffix at every `__`.
      /(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu,
    ].map((pattern) => pattern.toString()));
    const counted = (text: string): InlineNode[] => {
      let scanned = 0;
      let unbounded = 0;
      const closer = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input) {
        if (input !== text) return exec.call(this, input);
        if (!searches.has(this.toString())) {
          unbounded += 1;
          // Stop before running a potentially quadratic search, even on the largest fixture.
          expect(unbounded).toBe(0);
        }
        const start = this.lastIndex;
        const match = exec.call(this, input);
        // Count the span searched, not calls: failed searches consume the remaining suffix.
        scanned += Math.max(0, (match === null ? input.length : match.index + match[0].length) - start);
        return match;
      });
      let nodes: InlineNode[];
      try {
        nodes = parseInline(text);
      } finally {
        closer.mockRestore();
      }
      expect(scanned).toBeGreaterThan(0);
      // Each opener/closer search gets one pass; tokens consume their own text.
      expect(scanned).toBeLessThanOrEqual(10 * text.length);
      return nodes;
    };
    // a megabyte of each took from one minute to four: every one was searched from to the line's end
    for (const part of ["[a", "\\(", "_a ", "__a ", "a$", ":codex-file-citation{"]) {
      const line = (length: number): string => part.repeat(Math.ceil(length / part.length));
      for (const length of [20_000, 200_000]) {
        expect(counted(line(length))).toEqual([{ type: "text", value: line(length) }]);
      }
    }
    // a label closed with an address that is not, and a `__` that only a `_` closes
    for (const count of [4_000, 40_000]) expect(counted("[a](b".repeat(count))).toHaveLength(1);
    for (const count of [3_000, 30_000]) expect(counted("__a b_ ".repeat(count))).toHaveLength(count * 2);
    // the marks are the ones it found as one pattern, searching the whole line
    const asBefore = /(`[^`\n]+`|\\\(.+?\\\)|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/gu;
    const found = (marks: Iterable<RegExpMatchArray>): string => [...marks].map((mark) => `${mark.index}:${mark[0]}`).join("\n");
    const lines = everyLine(["_", "a", " ", "[", "](", ")", "\\(", "\\)", "\n"], 5);
    expect(lines.length).toBeGreaterThan(66_000);
    let marked = 0;
    for (const line of lines) {
      const marks = found(inlineMarks(line));
      expect(`${line}: ${marks}`).toBe(`${line}: ${found(line.matchAll(asBefore))}`);
      if (marks !== "") marked += 1;
    }
    expect(marked).toBeGreaterThan(1000);
  });

  test("reads a line of dollars that never closes in linear time", () => {
    for (const part of ["$a ", "$5 ", "$a\\$", " $a$b"]) linear((size) => part.repeat(size / part.length), 200_000, (line) => parseInline(line));
  });

  test("adds an item's lines to it without copying the item at every line", () => {
    const [list] = linear((lines) => `- a\n${"  x\n".repeat(lines)}`, 48_000, (text) => parseMarkdown(text)) as [ListBlock];
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.content).toHaveLength(96_001);
  });

  test("stops nesting emphasis after a few levels, and keeps what is inside as text", () => {
    const depth = (nodes: InlineNode[]): number => {
      let levels = 0;
      for (let level = nodes; level.length > 0; levels += 1) {
        level = level.flatMap((node) => "children" in node ? node.children : []);
      }
      return levels;
    };
    const nodes = linear((count) => `${"_".repeat(count)} x`, 48_000, (text) => parseInline(text));
    expect(depth(nodes)).toBeLessThan(20);
    // nothing is lost: what the levels left over hold is still there, as text
    expect(JSON.stringify(nodes)).toContain("_".repeat(40_000));
    // what people write nests as before
    expect(parseInline("**a _b ~~c~~_**")).toEqual([{ type: "strong", children: [{ type: "text", value: "a " },
      { type: "em", children: [{ type: "text", value: "b " }, { type: "del", children: [{ type: "text", value: "c" }] }] }] }]);
    expect(depth(parseInline(`${"__".repeat(8)}a${"__".repeat(8)}`))).toBe(9);
    // a link around it is not a level: sixteen of emphasis read whole inside a label too
    const sixteen = `${"__".repeat(16)}a\`x\`b${"__".repeat(16)}`;
    expect(JSON.stringify(parseInline(sixteen))).toContain('{"type":"code","value":"x"}');
    expect(JSON.stringify(parseInline(`[${sixteen}](https://x.dev)`))).toContain('{"type":"code","value":"x"}');
  });

  test("reads a heading or an item whose text holds a line separator, without trying every split of its spaces", () => {
    // U+2028 is not a line here (only \n is), and `.` stops at it unless told otherwise
    const [heading] = linear((spaces) => `# ${" ".repeat(spaces)}a\u2028b`, 48_000, (text) => parseMarkdown(text));
    expect(heading).toEqual({ type: "heading", level: 1, content: [{ type: "text", value: "a\u2028b" }] });
    const [list] = linear((spaces) => `- ${" ".repeat(spaces)}a\u2028b`, 48_000, (text) => parseMarkdown(text)) as [ListBlock];
    expect(list.items).toEqual([{ content: [{ type: "text", value: "a\u2028b" }] }]);
    linear((spaces) => `1. ${" ".repeat(spaces)}\u2029`, 48_000, (text) => parseMarkdown(text));
  });

});

test.describe("numbered lists as agents write them", () => {
  // Playwright's own JSX transform turns every <element> in a .tsx file into a test-runner object, so the real
  // Markdown.tsx cannot be imported into a Playwright test; it is bundled here by esbuild (plain automatic JSX) and rendered with react-dom/server
  let renderMarkdown: (source: string) => string = () => { throw new Error('Markdown bundle not built') };
  test.beforeAll(async () => { renderMarkdown = await buildMarkdownRenderer() });
  const render = (source: string): string => renderMarkdown(source);
  const lists = (source: string) => parseMarkdown(source).map((block) => block.type === "list" ? { start: block.start ?? 1, items: block.items.length } : block.type);


  test("reads a task list item's box as checked or open, and keeps the rest as its text", () => {
    const [block] = parseMarkdown("- [x] done\n- [ ] open\n- [X] also done\n- [ ]\n- [y] not a box\n- plain");
    expect((block as ListBlock).items.map((item) => [item.checked, item.content])).toEqual([
      [true, [{ type: "text", value: "done" }]],
      [false, [{ type: "text", value: "open" }]],
      [true, [{ type: "text", value: "also done" }]],
      [false, []],
      [undefined, [{ type: "text", value: "[y] not a box" }]],
      [undefined, [{ type: "text", value: "plain" }]],
    ]);
  });

  test("keeps one list across blank lines between its items", () => {
    expect(lists("1. a\n\n2. b\n\n3. c")).toEqual([{ start: 1, items: 3 }]);
  });

  test("goes on from its own number after a code block or other break, and starts where it says", () => {
    expect(lists("1. first\n```\ncode\n```\n2. second\n3. third")).toEqual([{ start: 1, items: 1 }, "code", { start: 2, items: 2 }]);
    expect(lists("3. three\n4. four")).toEqual([{ start: 3, items: 2 }]);
  });

  test("reads an item's indented lines as its own text, and an indented fence as code", () => {
    const blocks = parseMarkdown("1. first\n   more about it\n2. second");
    expect(lists("1. first\n   more about it\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const first = (blocks[0] as Extract<ReturnType<typeof parseMarkdown>[number], { type: "list" }>).items[0]!;
    expect(first.content.map((node) => node.type === "text" ? node.value : "").join("")).toBe("first more about it");
    const fenced = parseMarkdown("1. run it\n   ```sh\n   bun test\n   ```\n2. then this");
    expect(fenced.map((block) => block.type)).toEqual(["list", "code", "list"]);
    expect(fenced[1]).toEqual({ type: "code", language: "sh", value: "bun test" });
  });

  test("shows a table indented under an item as a table in that item, not as the item's text", () => {
    const blocks = parseMarkdown("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n     | b | `[2,3]` |\n\n   - after it\n\n2. second");
    expect(lists("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n\n   - after it\n\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const item = (blocks[0] as ListBlock).items[0]!;
    const nested = item.blocks?.[0] as ListBlock;
    // the sibling after the table stays nested, in the same list as the item the table is under
    expect(nested.items.map((entry) => entry.content)).toEqual([[{ type: "text", value: "Example:" }], [{ type: "text", value: "after it" }]]);
    expect(nested.items[0]?.blocks?.[0]).toMatchObject({ type: "table", header: [[{ value: "Way" }], [{ value: "Box" }]], rows: [[[{ value: "a" }], [{ type: "code", value: "[0,1]" }]], [[{ value: "b" }], [{ type: "code", value: "[2,3]" }]]] });
  });

  test("goes on counting after a table in an item, the way agents number every item 1.", () => {
    const source = "1. first\n\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n\n1. second\n1. third";
    expect(lists(source)).toEqual([{ start: 1, items: 3 }]);
    const html = render(source);
    expect(html.match(/<ol/g)).toHaveLength(1);
  });

  test("keeps a table and a nested list under one item in the order they were written", () => {
    const [list] = parseMarkdown("- item\n  - sub\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n  - more\n- next");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type)).toEqual(["list", "table", "list"]);
    expect((list as ListBlock).items).toHaveLength(2);
  });

  test("keeps an item's text after its table below the table", () => {
    const source = "1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   After the table.\n   And more.\n\n   Another paragraph.\n\n1. Next";
    const [list] = parseMarkdown(source);
    expect(lists(source)).toEqual([{ start: 1, items: 2 }]);
    const item = (list as ListBlock).items[0]!;
    expect(item.content).toEqual([{ type: "text", value: "Before" }]);
    expect(item.blocks).toMatchObject([
      { type: "table" },
      { type: "paragraph", lines: [[{ value: "After the table." }], [{ value: "And more." }]] },
      { type: "paragraph", lines: [[{ value: "Another paragraph." }]] },
    ]);
    expect(render(source)).toContain("</table></div><p>");
  });

  test("ends the list at a quote after an item's table, as before tables nested", () => {
    const blocks = parseMarkdown("1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   > Note\n\n1. Next");
    expect(blocks.map((block) => block.type)).toEqual(["list", "blockquote", "list"]);
  });

  test("ends an item's table at the next item or a line outside the item", () => {
    const [list] = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\n- next | value");
    expect((list as ListBlock).items.map((item) => item.content)).toEqual([[{ type: "text", value: "item" }], [{ type: "text", value: "next | value" }]]);
    expect((list as ListBlock).items[0]?.blocks?.[0]).toMatchObject({ type: "table", rows: [[[{ value: "x" }], [{ value: "y" }]]] });
    const blocks = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\nnot | in it");
    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
  });

  test("keeps both of two nested lists under one item", () => {
    const [list] = parseMarkdown("- item\n  - bullet\n  1. step");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type === "list" && block.ordered)).toEqual([false, true]);
  });

  test("escapes markup in a table cell inside a list item", () => {
    const html = render("- item\n\n  | <b>x</b> | y |\n  |---|---|\n  | <script>alert(1)</script> | <img src=x onerror=alert(1)> |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });
});

test.describe("quotes nested beyond reason", () => {
  test("parses a line of thousands of quote marks without overflowing the stack", () => {
    const blocks = parseMarkdown(`${">".repeat(30_000)} deep\n\nafter`);
    expect(blocks.map((block) => block.type)).toEqual(["blockquote", "paragraph"]);
    let depth = 0;
    for (let block = blocks[0]; block?.type === "blockquote"; block = block.blocks[0]) depth += 1;
    expect(depth).toBe(33);
  });

  test("still nests the quotes people write", () => {
    const [outer] = parseMarkdown("> one\n> > two");
    expect(outer?.type === "blockquote" && outer.blocks.map((block) => block.type)).toEqual(["paragraph", "blockquote"]);
  });

  test("reads ![alt](src) as an image whose fallback is the `!` and the link it was", () => {
    expect(parseInline("see ![a pic](img/a.png) now")).toEqual([
      { type: "text", value: "see " },
      { type: "image", alt: "a pic", src: "img/a.png", fallback: [{ type: "text", value: "!" }, { type: "file", path: "img/a.png", children: [{ type: "text", value: "a pic" }] }] },
      { type: "text", value: " now" },
    ]);
    expect(parseInline("![x](https://a.dev/x.png)")[0]).toMatchObject({ type: "image", fallback: [{ type: "text", value: "!" }, { type: "link", href: "https://a.dev/x.png" }] });
  });
});


})
