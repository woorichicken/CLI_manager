#!/usr/bin/env python3
"""
Writes the synthetic transcripts T73 reads (tests/terminal/fixtures/transcripts/*).

Synthetic on purpose: real transcripts hold names, paths, prompts and secrets,
and must never be committed. The record shapes follow Claude Code 2.1.317 and
Codex 0.164 rollouts as seen on a real machine (field names only — every value
here is made up). Run from anywhere: python3 make-fixtures.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE = os.path.join(HERE, 'claude')
CODEX = os.path.join(HERE, 'codex')
os.makedirs(CLAUDE, exist_ok=True)
os.makedirs(CODEX, exist_ok=True)

SESSION = '00000000-0000-4000-8000-000000000001'
CWD = '/Users/someone/project'
counter = [0]


def ts(seconds):
    return f'2026-11-03T01:{seconds // 60:02d}:{seconds % 60:02d}.000Z'


def uid():
    counter[0] += 1
    return f'00000000-0000-4000-8000-{counter[0]:012d}'


class Claude:
    def __init__(self):
        self.lines = []
        self.last = None
        self.t = 0

    def add(self, entry, step=2):
        self.t += step
        u = uid()
        base = {'parentUuid': self.last, 'isSidechain': False, 'userType': 'external', 'cwd': CWD,
                'sessionId': SESSION, 'version': '2.1.317', 'gitBranch': 'main', 'uuid': u, 'timestamp': ts(self.t)}
        base.update(entry)
        self.lines.append(base)
        self.last = u
        return u

    def noise(self):
        # bookkeeping records the parser must ignore (seen in real 2.1.317 files)
        self.lines.append({'type': 'mode', 'mode': 'normal', 'sessionId': SESSION})
        self.lines.append({'type': 'api-request-blob', 'hash': 'x', 'sessionId': SESSION,
                           'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'internal request copy'}]}})

    def prompt(self, text, **extra):
        return self.add({'type': 'user', 'message': {'role': 'user', 'content': text}, 'promptSource': 'user',
                         'origin': {'kind': 'human'}, **extra})

    def say(self, blocks, stop):
        return self.add({'type': 'assistant', 'message': {'role': 'assistant', 'model': 'claude-model',
                                                          'content': blocks, 'stop_reason': stop}})

    def result(self, tool_id, output, error=False):
        return self.add({'type': 'user', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': tool_id, 'content': output, 'is_error': error}]}})

    def write(self, name, torn_tail=None):
        path = os.path.join(CLAUDE, name)
        with open(path, 'w') as f:
            for line in self.lines:
                f.write(json.dumps(line, ensure_ascii=False) + '\n')
            if torn_tail is not None:
                f.write(torn_tail)


ANSWER_MD = """Here is the summary.

| file | change |
| --- | --- |
| `src/a.ts` | added a guard |
| `src/b.ts` | renamed `foo` |

```ts
export function guard(value: unknown): value is string {
  return typeof value === "string";
}
```

- first point
- second point"""

# 1 short — one prompt, one answer
c = Claude()
c.noise()
c.prompt('What does this project do?')
c.say([{'type': 'text', 'text': 'It manages terminal sessions.'}], 'end_turn')
c.write('short.jsonl')

# 2 tools — thinking, Bash, Edit, final answer with a table and a code block
c = Claude()
c.prompt('Add a guard to src/a.ts and show me')
c.say([{'type': 'thinking', 'thinking': 'Look at the file first.'}], 'tool_use')
c.say([{'type': 'tool_use', 'id': 'toolu_01', 'name': 'Bash', 'input': {'command': 'cat src/a.ts', 'description': 'Read the file'}}], 'tool_use')
c.result('toolu_01', 'export const a = 1\n')
c.say([{'type': 'tool_use', 'id': 'toolu_02', 'name': 'Edit', 'input': {'file_path': '/Users/someone/project/src/a.ts', 'old_string': 'a', 'new_string': 'b'}}], 'tool_use')
c.result('toolu_02', 'The file has been updated.')
c.noise()
c.say([{'type': 'text', 'text': ANSWER_MD}], 'end_turn')
c.write('tools.jsonl')

# 3 resent — a send Claude Code cancelled before any reply, re-sent from the same parent: only the re-send shows
c = Claude()
first = c.prompt('Hello there')
c.say([{'type': 'text', 'text': 'Hi!'}], 'end_turn')
parent = c.last
c.prompt('Draft that was cancelled')
c.last = parent
c.prompt('The message I really sent')
c.say([{'type': 'text', 'text': 'Got the real one.'}], 'end_turn')
c.write('resent.jsonl')

# 4 compacted — a compaction summary in the person's seat, then the conversation goes on
c = Claude()
c.prompt('Old question')
c.say([{'type': 'text', 'text': 'Old answer.'}], 'end_turn')
c.add({'type': 'user', 'isCompactSummary': True, 'message': {'role': 'user', 'content': 'Summary: we talked about the old question.'}})
c.prompt('New question after compact')
c.say([{'type': 'text', 'text': 'New answer.'}], 'end_turn')
c.write('compacted.jsonl')

# 5 cleared — /clear starts the conversation over
c = Claude()
c.prompt('Before clear')
c.say([{'type': 'text', 'text': 'Answer before clear.'}], 'end_turn')
c.add({'type': 'user', 'message': {'role': 'user', 'content': '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'}})
c.prompt('After clear')
c.say([{'type': 'text', 'text': 'Answer after clear.'}], 'end_turn')
c.write('cleared.jsonl')

# 6 subagent — a Task call and the subagent's task notification
c = Claude()
c.prompt('Research this in the background')
c.say([{'type': 'tool_use', 'id': 'toolu_10', 'name': 'Task', 'input': {'description': 'Find the config', 'prompt': 'look', 'subagent_type': 'Explore'}}], 'tool_use')
c.result('toolu_10', 'Started agent a1b2c3')
c.say([{'type': 'text', 'text': 'Started a helper.'}], 'end_turn')
c.add({'type': 'user', 'message': {'role': 'user', 'content': '<task-notification>\n<task-id>a1b2c3</task-id>\n<tool-use-id>toolu_10</tool-use-id>\n<status>completed</status>\n<summary>Agent "Find the config" completed</summary>\n<result>The config is in config.json.</result>\n</task-notification>'}})
c.say([{'type': 'text', 'text': 'The helper found it.'}], 'end_turn')
c.write('subagent.jsonl')

# 7 image — a pasted picture (a 1x1 PNG) with words
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
c = Claude()
c.add({'type': 'user', 'message': {'role': 'user', 'content': [
    {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': PNG}},
    {'type': 'text', 'text': 'What is in this screenshot?'}]}})
c.say([{'type': 'text', 'text': 'A single pixel.'}], 'end_turn')
c.write('image.jsonl')

# 8 denied — a permission the person refused: the call fails, the turn goes on
c = Claude()
c.prompt('Delete the build folder')
c.say([{'type': 'tool_use', 'id': 'toolu_20', 'name': 'Bash', 'input': {'command': 'rm -rf build', 'description': 'Remove build output'}}], 'tool_use')
c.result('toolu_20', "The user doesn't want to proceed with this tool use. The tool use was rejected.", True)
c.say([{'type': 'text', 'text': 'Okay, I left it alone.'}], 'end_turn')
c.write('denied.jsonl')

# 9 queued — a message typed while Claude worked, recorded as a queued_command attachment
c = Claude()
c.prompt('Start a long task')
c.say([{'type': 'tool_use', 'id': 'toolu_30', 'name': 'Bash', 'input': {'command': 'sleep 5'}}], 'tool_use')
c.add({'type': 'attachment', 'attachment': {'type': 'queued_command', 'prompt': 'Also check the tests', 'commandMode': 'prompt', 'origin': {'kind': 'human'}}})
c.result('toolu_30', '')
c.say([{'type': 'text', 'text': 'Done, and the tests pass.'}], 'end_turn')
c.write('queued.jsonl')

# 10 working — a turn still running: the last tool has no result yet, and the file ends in a torn line
c = Claude()
c.prompt('Run the slow script')
c.say([{'type': 'tool_use', 'id': 'toolu_40', 'name': 'Bash', 'input': {'command': 'node slow.js'}}], 'tool_use')
torn = json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'half'}]}})[:40]
c.write('working.jsonl', torn_tail=torn)

# Codex rollout — session_meta, a prompt (event + response copies), reasoning, a command, the answer
codex = [
    {'timestamp': ts(0), 'type': 'session_meta', 'payload': {'id': '00000000-0000-4000-8000-0000000000c1', 'cwd': CWD, 'source': 'cli', 'originator': 'codex_cli_rs'}},
    {'timestamp': ts(1), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '<environment_context>\n  <cwd>/Users/someone/project</cwd>\n</environment_context>'}]}},
    {'timestamp': ts(2), 'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't1'}},
    {'timestamp': ts(2), 'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'List the files', 'kind': 'plain'}},
    {'timestamp': ts(2), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'List the files'}]}},
    {'timestamp': ts(3), 'type': 'response_item', 'payload': {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': 'I will run ls.'}]}},
    {'timestamp': ts(4), 'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command', 'arguments': json.dumps({'cmd': 'ls'}), 'call_id': 'call_1'}},
    {'timestamp': ts(5), 'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'Process exited with code 0\na.ts\nb.ts'}},
    {'timestamp': ts(6), 'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'There are **two** files: `a.ts` and `b.ts`.', 'phase': 'final_answer'}},
    {'timestamp': ts(6), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'There are **two** files: `a.ts` and `b.ts`.'}], 'phase': 'final_answer'}},
    {'timestamp': ts(7), 'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 't1'}},
]
with open(os.path.join(CODEX, 'rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'), 'w') as f:
    for line in codex:
        f.write(json.dumps(line, ensure_ascii=False) + '\n')

print('ok')
