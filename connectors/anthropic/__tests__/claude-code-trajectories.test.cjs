#!/usr/bin/env node
/**
 * Unit tests for the Claude Code trajectory builder.
 *
 * Covers the three things that decide whether this scope is safe to ship:
 * the trace really is an ordered action-observation loop, credential-shaped
 * strings never leave the machine, and the caps announce themselves instead of
 * quietly shrinking the corpus. Also asserts the whole result envelope stays
 * conformant to the honest-telemetry contract when the caps do fire.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyConnectorResult,
} = require('../../../scripts/validate-honest-telemetry-conformance.cjs');

// The connector is a plain script the runner evaluates as
// `new AsyncFunction("page", code)`, and this repo is `"type": "module"`, so it
// can be neither imported nor required. Load it the way the runner does — as a
// function body — and pick up the CommonJS handles it exports when `module` is
// in scope. Testing the real artifact, not a copy of it.
function loadConnector() {
  const file = path.join(__dirname, '..', 'claude-code-local.js');
  const code = fs.readFileSync(file, 'utf8');
  const factory = new Function('module', 'exports', 'require', 'page', code);
  const mod = { exports: {} };
  factory(mod, mod.exports, require, undefined);
  return mod.exports;
}

const {
  redactText,
  redactDeep,
  capText,
  blocksOf,
  toolResultText,
  buildTrajectorySteps,
  summarizeTranscript,
  mergeCounts,
} = loadConnector();

const { loadNodeBuiltins, listTranscripts, buildTrajectories } = loadConnector();

const cases = [];
const asyncCases = [];
function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      asyncCases.push(
        out.then(
          () => cases.push({ name, ok: true }),
          (err) => cases.push({ name, ok: false, err: err.message }),
        ),
      );
      return;
    }
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, err: err.message });
  }
}

/** A throwaway ~/.claude with one main session and one subagent transcript. */
function seedClaudeHome() {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-code-test-'));
  const project = path.join(home, 'projects', '-Users-dev-project');
  const subagents = path.join(project, 'ses-main', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });

  const line = (row) => JSON.stringify(row) + '\n';
  fs.writeFileSync(
    path.join(project, 'ses-main.jsonl'),
    transcript.map(line).join(''),
  );
  fs.writeFileSync(
    path.join(subagents, 'agent-abc.jsonl'),
    [
      {
        type: 'assistant',
        timestamp: '2026-07-30T10:00:05.000Z',
        isSidechain: true,
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'tool_use', id: 'toolu_9', name: 'Grep', input: { pattern: 'auth' } }],
        },
      },
    ]
      .map(line)
      .join(''),
  );
  return home;
}

// A minimal but realistic transcript: prompt, thinking, tool call, tool result,
// then the assistant's reply. Mirrors the row/block shape Claude Code writes.
const transcript = [
  { type: 'summary', summary: 'Fix the failing test' },
  {
    type: 'user',
    timestamp: '2026-07-30T10:00:00.000Z',
    cwd: '/Users/dev/project',
    gitBranch: 'main',
    version: '2.1.220',
    message: { role: 'user', content: [{ type: 'text', text: 'the auth test is red, fix it' }] },
  },
  {
    type: 'assistant',
    timestamp: '2026-07-30T10:00:03.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [
        { type: 'thinking', thinking: 'Run the suite first.', signature: 'opaque-blob' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test auth' } },
      ],
    },
  },
  {
    type: 'user',
    timestamp: '2026-07-30T10:00:09.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          is_error: true,
          content: 'FAIL auth.test.ts — expected 200, got 401',
        },
      ],
    },
  },
  {
    type: 'assistant',
    timestamp: '2026-07-30T10:00:20.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'The token header was missing. Fixed.' }],
    },
  },
];

test('trace is ordered and links each tool call to its result', () => {
  const { steps, stepCounts } = buildTrajectorySteps(transcript);

  assert.deepStrictEqual(
    steps.map((s) => s.type),
    ['prompt', 'thinking', 'tool_call', 'tool_result', 'message'],
  );
  assert.deepStrictEqual(
    steps.map((s) => s.index),
    [0, 1, 2, 3, 4],
  );

  const call = steps.find((s) => s.type === 'tool_call');
  const result = steps.find((s) => s.type === 'tool_result');
  assert.strictEqual(call.tool, 'Bash');
  assert.strictEqual(call.input.command, 'npm test auth');
  assert.strictEqual(result.callId, call.callId, 'result must link back to its call');
  assert.strictEqual(result.isError, true, 'a failed observation must stay marked as failed');
  assert.strictEqual(result.role, 'tool');
  assert.strictEqual(stepCounts.tool_call, 1);
});

test('assistant steps keep their model, tool results do not fabricate one', () => {
  const { steps } = buildTrajectorySteps(transcript);
  assert.strictEqual(steps.find((s) => s.type === 'message').model, 'claude-opus-5');
  assert.strictEqual(steps.find((s) => s.type === 'tool_result').model, undefined);
});

test('thinking keeps the reasoning and drops the signature blob', () => {
  const { steps } = buildTrajectorySteps(transcript);
  const thinking = steps.find((s) => s.type === 'thinking');
  assert.strictEqual(thinking.text, 'Run the suite first.');
  assert.strictEqual(thinking.signature, undefined);
});

test('includeThinking:false removes reasoning without disturbing the rest', () => {
  const { steps } = buildTrajectorySteps(transcript, { includeThinking: false });
  assert.deepStrictEqual(
    steps.map((s) => s.type),
    ['prompt', 'tool_call', 'tool_result', 'message'],
  );
});

test('empty text blocks are dropped rather than exported as blank steps', () => {
  const { steps } = buildTrajectorySteps([
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    },
  ]);
  assert.strictEqual(steps.length, 0);
});

test('credentials are redacted in prompts, tool inputs and tool outputs', () => {
  const secretTranscript = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA to call it' }],
      },
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Bash',
            input: { command: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefghij env' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
          },
        ],
      },
    },
  ];

  const { steps, redactions } = buildTrajectorySteps(secretTranscript);
  const joined = JSON.stringify(steps);

  assert.ok(!joined.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA'), 'API key must not survive');
  assert.ok(!joined.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'PAT must not survive');
  assert.ok(!joined.includes('wJalrXUtnFEMIabcdefghij'), 'assigned secret must not survive');
  assert.ok(joined.includes('[redacted:anthropic_key]'));
  assert.ok(joined.includes('[redacted:github_token]'));
  assert.ok(joined.includes('[redacted:secret_assignment]'));
  // The tally is reported; the matched text never is.
  assert.strictEqual(redactions.anthropic_key, 1);
  assert.ok(!JSON.stringify(redactions).includes('sk-ant'));
  // The command around the secret still reads correctly.
  assert.ok(steps[1].input.command.startsWith('AWS_SECRET_ACCESS_KEY='));
  assert.ok(steps[1].input.command.endsWith(' env'));
});

test('redaction leaves ordinary text and non-secret assignments alone', () => {
  const counts = {};
  const text = 'ran npm test, DEBUG=true, exit 0';
  assert.strictEqual(redactText(text, counts), text);
  assert.deepStrictEqual(counts, {});
});

test('redactDeep preserves object shape and bottoms out on deep nesting', () => {
  const counts = {};
  const out = redactDeep({ a: ['sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBB', 2], b: { c: 'ok' } }, counts);
  assert.strictEqual(out.a[0], '[redacted:anthropic_key]');
  assert.strictEqual(out.a[1], 2);
  assert.strictEqual(out.b.c, 'ok');

  let deep = 'leaf';
  for (let i = 0; i < 10; i += 1) deep = { next: deep };
  assert.strictEqual(JSON.stringify(redactDeep(deep, counts)).includes('depth-limited'), true);
});

test('oversized bodies are truncated and say so', () => {
  const long = 'x'.repeat(50);
  const { steps, truncatedSteps } = buildTrajectorySteps(
    [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: long }],
        },
      },
    ],
    { maxStepChars: 10 },
  );

  assert.strictEqual(steps[0].output.length, 10);
  assert.strictEqual(steps[0].truncated, true);
  assert.strictEqual(steps[0].originalLength, 50);
  assert.strictEqual(truncatedSteps, 1);
});

test('capText leaves short strings untouched', () => {
  assert.deepStrictEqual(capText('short', 10), { text: 'short', truncated: false });
});

test('content arrives as a string, a block array, or a structured payload', () => {
  assert.deepStrictEqual(blocksOf({ content: 'plain' }), [{ type: 'text', text: 'plain' }]);
  assert.deepStrictEqual(blocksOf({ content: [{ type: 'text', text: 'a' }, null] }), [
    { type: 'text', text: 'a' },
  ]);
  assert.deepStrictEqual(blocksOf(null), []);
  assert.strictEqual(toolResultText({ content: [{ type: 'text', text: 'x' }, 'y'] }), 'x\ny');
  assert.strictEqual(toolResultText({ content: { ok: true } }), '{"ok":true}');
  assert.strictEqual(toolResultText({}), '');
});

test('session metadata is derived from the same transcript', () => {
  const meta = summarizeTranscript(transcript, '-Users-dev-project');
  assert.strictEqual(meta.project, '/Users/dev/project');
  assert.strictEqual(meta.gitBranch, 'main');
  assert.strictEqual(meta.cliVersion, '2.1.220');
  assert.strictEqual(meta.title, 'Fix the failing test');
  assert.deepStrictEqual(meta.models, ['claude-opus-5']);
  assert.strictEqual(meta.messageCount, 4);
});

test('mergeCounts sums tallies across sessions', () => {
  assert.deepStrictEqual(mergeCounts({ jwt: 1 }, { jwt: 2, bearer: 1 }), { jwt: 3, bearer: 1 });
});

test('a capped export still classifies as a conformant partial success', () => {
  const trace = buildTrajectorySteps(transcript, { maxStepChars: 5 });
  const result = {
    requestedScopes: ['claude_code.sessions', 'claude_code.trajectories'],
    errors: [
      {
        errorClass: 'runtime_error',
        reason: '2 step bodies were truncated at 5 characters.',
        disposition: 'degraded',
        scope: 'claude_code.trajectories',
        phase: 'collection',
      },
    ],
    'claude_code.sessions': { sessions: [], total: 0 },
    'claude_code.trajectories': { sessions: [{ steps: trace.steps }], total: 1 },
    exportSummary: { count: 1, label: 'items', details: { trajectorySessions: 1 } },
    timestamp: '2026-07-30T10:01:00.000Z',
    version: '1.1.0-vanilla',
    platform: 'claude_code',
  };

  const verdict = classifyConnectorResult(result);
  assert.strictEqual(verdict.validity, 'valid', verdict.debug || '');
  assert.strictEqual(verdict.classification.outcome, 'partial');
  assert.strictEqual(verdict.classification.scopeSummary.degraded, 1);
});

test('subagent transcripts are collected and linked to the session that ran them', async () => {
  const home = seedClaudeHome();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    await loadNodeBuiltins();

    const found = listTranscripts();
    assert.strictEqual(found.length, 2, 'the nested subagent trace must not be missed');

    const main = found.find((t) => t.sessionId === 'ses-main');
    const sub = found.find((t) => t.sessionId === 'agent-abc');
    assert.strictEqual(main.kind, 'session');
    assert.strictEqual(main.parentSessionId, null);
    assert.strictEqual(sub.kind, 'subagent');
    assert.strictEqual(sub.parentSessionId, 'ses-main');

    const out = buildTrajectories({ email: null });
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.toolCalls, 2, 'both the session and its subagent contribute tool calls');
    const traced = out.sessions.find((s) => s.sessionId === 'agent-abc');
    assert.strictEqual(traced.parentSessionId, 'ses-main');
    assert.strictEqual(traced.steps[0].sidechain, true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

Promise.all(asyncCases).then(() => {
  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) {
    console.log(`${c.ok ? 'ok' : 'FAIL'} — ${c.name}${c.ok ? '' : `: ${c.err}`}`);
  }
  console.log(`\n${cases.length - failed.length}/${cases.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
});
