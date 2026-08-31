// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code Connector (vanilla / local filesystem)
 *
 * Exports your on-device Claude Code (CLI) data. Unlike the Playwright
 * connectors there is no website to log into — Claude Code already stores
 * everything under your home directory (`~/.claude`), so this connector runs
 * in the runner's Node context, reads those files directly, and never needs
 * the page. The manifest declares `"runtime": "vanilla"` for exactly this case.
 *
 * Exports:
 * - claude_code.usage        — aggregate usage stats from ~/.claude/stats-cache.json
 * - claude_code.sessions     — per-session metadata from ~/.claude/projects/<proj>/<sessionId>.jsonl
 * - claude_code.prompts      — typed prompt history from ~/.claude/history.jsonl
 * - claude_code.trajectories — the full agent trace: every prompt, assistant turn,
 *                              tool call (with its input) and tool result (with its
 *                              output), in order, from the same transcripts
 *
 * WHY TRAJECTORIES ARE A SEPARATE SCOPE
 * `claude_code.sessions` deliberately carries only the shape of a run (turn
 * counts, models, timing). `claude_code.trajectories` carries the bodies: the
 * commands the agent ran and what came back. That is what makes it useful for
 * studying agent behaviour, and also what makes it sensitive — these payloads
 * contain source code, file paths, and command output from the machine. It is
 * its own scope so a user can grant the cheap metadata without ever granting
 * the transcript, and so a host can gate the two differently.
 *
 * SAFETY RAILS ON THE TRAJECTORY SCOPE
 * - credential-shaped strings are redacted before export (see REDACTIONS);
 *   the count of redactions is reported, never the matched text;
 * - every step body is capped (`maxStepChars`) and marks itself `truncated`;
 * - the whole scope is capped (`maxBytes`), newest sessions first, and reports
 *   what it dropped as a `degraded` telemetry error rather than silently
 *   shipping a partial corpus.
 * Redaction is best-effort pattern matching, not a de-identification pipeline.
 * It is the floor, not the guarantee.
 *
 * The DataConnect runner runs connector scripts via `new AsyncFunction("page", code)`,
 * so only `page` is in scope — there is no `require`. Node's built-ins are pulled
 * in with dynamic `import()` at the start of the run (with a `require` fallback for
 * other harnesses), and assigned to the module-scoped bindings the helpers close over.
 * The pure builders are also exported through `module.exports` when this file is
 * loaded as a CommonJS module, so they can be unit-tested without a runner.
 */

// Node built-ins + derived paths — populated at the start of the run.
let fs;
let os;
let path;
let CLAUDE_HOME;
let CLAUDE_JSON;

const loadNodeBuiltins = async () => {
  const load = async (name) =>
    typeof require !== 'undefined' ? require(name) : await import('node:' + name);
  fs = await load('fs');
  os = await load('os');
  path = await load('path');
  CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
};

// ─── Small fs helpers (all fail-soft: a missing/corrupt file never throws) ───

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
};

const readJsonl = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (e) {
      // skip malformed line
    }
  }
  return rows;
};

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
};

const toIso = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};

// ─── Redaction ───────────────────────────────────────────────────────────────
//
// Credential shapes only. Anything that looks like a live secret is replaced
// with a typed placeholder so the trace still reads correctly ("the command
// exported a token") without carrying the token itself. Ordered most-specific
// first: a JWT should not be eaten by the generic assignment rule.

const REDACTIONS = [
  {
    label: 'private_key',
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  { label: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { label: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { label: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { label: 'hex_secret', re: /\b0x[0-9a-fA-F]{64}\b/g },
  // KEY=value / "key": "value" for obviously-secret names — value only. The
  // lookahead keeps this last-resort rule from re-redacting (and so mislabeling)
  // a value an earlier, more specific rule already replaced.
  {
    label: 'secret_assignment',
    re: /((?:[A-Za-z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_-]*)["']?\s*[:=]\s*["']?)(?!\[redacted:)([^\s"',;)}]{6,})/gi,
    replace: (match, prefix) => prefix + '[redacted:secret_assignment]',
  },
];

/**
 * Replace credential-shaped substrings. Returns the scrubbed text and tallies
 * each hit by type, so a run can report "12 redactions" without echoing any.
 */
function redactText(value, counts) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const rule of REDACTIONS) {
    out = out.replace(rule.re, function () {
      if (counts) counts[rule.label] = (counts[rule.label] || 0) + 1;
      return rule.replace
        ? rule.replace.apply(null, arguments)
        : '[redacted:' + rule.label + ']';
    });
  }
  return out;
}

/** Redact recursively through a tool-input object, preserving its shape. */
function redactDeep(value, counts, depth) {
  const d = depth || 0;
  if (d > 6) return '[depth-limited]';
  if (typeof value === 'string') return redactText(value, counts);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts, d + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key], counts, d + 1);
    return out;
  }
  return value;
}

/** Cap a string, reporting how much was dropped. */
function capText(value, maxChars) {
  if (typeof value !== 'string') return { text: value, truncated: false };
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: value.slice(0, maxChars),
    truncated: true,
    originalLength: value.length,
  };
}

// ─── Profile (best-effort, from ~/.claude.json oauthAccount — no secrets) ────

const buildProfile = () => {
  const cfg = readJson(CLAUDE_JSON) || {};
  const acct = cfg.oauthAccount || {};
  return {
    displayName: acct.displayName || null,
    email: acct.emailAddress || null,
    organizationName: acct.organizationName || null,
    plan: cfg.claudeMaxTier || acct.seatTier || null,
    numStartups: typeof cfg.numStartups === 'number' ? cfg.numStartups : null,
    firstStartTime: toIso(cfg.firstStartTime),
  };
};

// ─── claude_code.usage (from stats-cache.json) ───────────────────────────────

const buildUsage = (profile) => {
  const stats = readJson(path.join(CLAUDE_HOME, 'stats-cache.json'));
  if (!stats) {
    return {
      profile,
      totals: null,
      models: [],
      dailyActivity: [],
      dailyModelTokens: [],
      hourCounts: {},
      longestSession: null,
      totalCostUSD: 0,
      source: 'stats-cache-missing',
    };
  }

  const modelUsage = stats.modelUsage || {};
  const models = Object.keys(modelUsage).map((model) => {
    const m = modelUsage[model] || {};
    return {
      model,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
      webSearchRequests: m.webSearchRequests ?? 0,
      costUSD: m.costUSD ?? 0,
      contextWindow: m.contextWindow ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
    };
  });

  const totalCostUSD = models.reduce((sum, m) => sum + (m.costUSD || 0), 0);

  const longest = stats.longestSession || null;

  return {
    profile,
    totals: {
      sessions: stats.totalSessions ?? null,
      messages: stats.totalMessages ?? null,
      firstSessionDate: toIso(stats.firstSessionDate),
      lastComputedDate: stats.lastComputedDate || null,
      speculationTimeSavedMs: stats.totalSpeculationTimeSavedMs ?? null,
    },
    models,
    dailyActivity: Array.isArray(stats.dailyActivity) ? stats.dailyActivity : [],
    dailyModelTokens: Array.isArray(stats.dailyModelTokens) ? stats.dailyModelTokens : [],
    hourCounts: stats.hourCounts || {},
    longestSession: longest
      ? {
          sessionId: longest.sessionId || null,
          durationMs: longest.duration ?? null,
          messageCount: longest.messageCount ?? null,
          timestamp: toIso(longest.timestamp),
        }
      : null,
    totalCostUSD,
    source: 'stats-cache',
  };
};

// ─── Transcript walking (shared by sessions + trajectories) ──────────────────

// Project dirs are the absolute cwd with path separators replaced by '-'.
// We can't perfectly invert that (dashes in real paths are ambiguous), so this
// is only a fallback when no `cwd` field was found in the transcript itself.
const decodeProjectDir = (dirName) => {
  if (!dirName) return null;
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
};

/**
 * Every transcript under ~/.claude/projects.
 *
 * The main thread of a session is `<project>/<sessionId>.jsonl`, but a session
 * that dispatched subagents also writes `<project>/<sessionId>/subagents/
 * agent-*.jsonl` — one transcript per subagent, each a full trace of its own.
 * On a machine that uses subagents these outnumber the main threads, so the
 * walk recurses and tags each transcript with its kind and parent instead of
 * stopping at the top level.
 */
function listTranscripts() {
  const projectsRoot = path.join(CLAUDE_HOME, 'projects');
  const out = [];

  const walk = (dirPath, projectDir, parentSessionId, depth) => {
    if (depth > 4) return;
    for (const entry of listDir(dirPath)) {
      const full = path.join(dirPath, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }

      if (stat.isDirectory()) {
        // A directory named after a session holds that session's subagents;
        // anything else (e.g. the `subagents` folder itself) just passes the
        // current parent through.
        const nextParent = entry === 'subagents' ? parentSessionId : entry;
        walk(full, projectDir, nextParent, depth + 1);
        continue;
      }

      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace(/\.jsonl$/, '');
      out.push({
        file: full,
        projectDir,
        sessionId,
        parentSessionId: parentSessionId && parentSessionId !== sessionId ? parentSessionId : null,
        kind: parentSessionId && parentSessionId !== sessionId ? 'subagent' : 'session',
        mtimeMs: stat.mtimeMs || 0,
      });
    }
  };

  for (const projectDir of listDir(projectsRoot)) {
    const dirPath = path.join(projectsRoot, projectDir);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch (e) {
      continue;
    }
    walk(dirPath, projectDir, null, 1);
  }

  return out;
}

/** Metadata common to both transcript-derived scopes. */
function summarizeTranscript(rows, projectDir) {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let cwd = null;
  let gitBranch = null;
  let cliVersion = null;
  let title = null;
  const models = new Set();

  for (const row of rows) {
    const type = row.type;
    if (type === 'user') userMessageCount += 1;
    else if (type === 'assistant') assistantMessageCount += 1;
    else if (type === 'ai-title' && row.aiTitle) title = title || row.aiTitle;
    else if (type === 'summary' && row.summary) title = title || row.summary;

    if (row.cwd && !cwd) cwd = row.cwd;
    if (row.gitBranch && !gitBranch) gitBranch = row.gitBranch;
    if (row.version && !cliVersion) cliVersion = row.version;

    const model = row.message && row.message.model;
    // Skip synthetic placeholders (e.g. "<synthetic>") that aren't real models.
    if (model && !String(model).startsWith('<')) models.add(model);

    const ts = toIso(row.timestamp);
    if (ts) {
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }
  }

  return {
    project: cwd || decodeProjectDir(projectDir),
    gitBranch: gitBranch || null,
    cliVersion: cliVersion || null,
    title: title || null,
    firstTimestamp,
    lastTimestamp,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    models: Array.from(models),
  };
}

// ─── claude_code.sessions (metadata only, no bodies) ─────────────────────────

const buildSessions = (profile) => {
  const sessions = [];
  for (const transcript of listTranscripts()) {
    const rows = readJsonl(transcript.file);
    if (!rows.length) continue;
    sessions.push(
      Object.assign(
        {
          sessionId: transcript.sessionId,
          kind: transcript.kind,
          parentSessionId: transcript.parentSessionId,
        },
        summarizeTranscript(rows, transcript.projectDir),
      ),
    );
  }

  sessions.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));

  return {
    profile,
    sessions,
    total: sessions.length,
    source: 'projects-transcripts',
  };
};

// ─── claude_code.trajectories (the full trace) ───────────────────────────────

const DEFAULT_TRAJECTORY_OPTIONS = {
  maxStepChars: 8000,
  maxBytes: 24 * 1024 * 1024,
  includeThinking: true,
};

/** Content blocks arrive as a string or as a typed-block array. */
function blocksOf(message) {
  if (!message) return [];
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === 'object');
  return [];
}

/** tool_result content is a string, or blocks, or a structured payload. */
function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch (e) {
      return '';
    }
  }
  return '';
}

/**
 * Turn one transcript into an ordered agent trace.
 *
 * Every step is one thing that happened: a prompt, a thinking block, an
 * assistant message, a tool call, or the observation that came back. Tool
 * calls and their results are linked by `callId`, so a consumer can rebuild
 * the action-observation loop without reparsing the transcript.
 */
function buildTrajectorySteps(rows, options) {
  const opts = Object.assign({}, DEFAULT_TRAJECTORY_OPTIONS, options || {});
  const counts = {};
  const steps = [];
  let truncatedSteps = 0;

  const push = (step, bodyKey) => {
    if (bodyKey && typeof step[bodyKey] === 'string') {
      const capped = capText(step[bodyKey], opts.maxStepChars);
      step[bodyKey] = capped.text;
      if (capped.truncated) {
        step.truncated = true;
        step.originalLength = capped.originalLength;
        truncatedSteps += 1;
      }
    }
    step.index = steps.length;
    steps.push(step);
  };

  for (const row of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const at = toIso(row.timestamp);
    const rawModel = row.message && row.message.model;
    const model = rawModel && !String(rawModel).startsWith('<') ? rawModel : undefined;
    const sidechain = row.isSidechain === true ? true : undefined;

    for (const block of blocksOf(row.message)) {
      const base = { at, sidechain };

      if (block.type === 'text') {
        const text = redactText(String(block.text || ''), counts);
        if (!text.trim()) continue;
        push(
          Object.assign({}, base, {
            role: row.type === 'user' ? 'user' : 'assistant',
            type: row.type === 'user' ? 'prompt' : 'message',
            text,
            model: row.type === 'assistant' ? model : undefined,
          }),
          'text',
        );
      } else if (block.type === 'thinking') {
        if (!opts.includeThinking) continue;
        // `signature` is an opaque attestation blob, not reasoning — drop it.
        const text = redactText(String(block.thinking || ''), counts);
        if (!text.trim()) continue;
        push(
          Object.assign({}, base, { role: 'assistant', type: 'thinking', text, model }),
          'text',
        );
      } else if (block.type === 'tool_use') {
        push(
          Object.assign({}, base, {
            role: 'assistant',
            type: 'tool_call',
            callId: block.id || null,
            tool: block.name || null,
            input: redactDeep(block.input, counts),
            model,
          }),
        );
      } else if (block.type === 'tool_result') {
        const output = redactText(toolResultText(block), counts);
        push(
          Object.assign({}, base, {
            role: 'tool',
            type: 'tool_result',
            callId: block.tool_use_id || null,
            isError: block.is_error === true,
            output,
          }),
          'output',
        );
      }
    }
  }

  const stepCounts = steps.reduce((acc, step) => {
    acc[step.type] = (acc[step.type] || 0) + 1;
    return acc;
  }, {});

  return { steps, stepCounts, truncatedSteps, redactions: counts };
}

/** Merge per-session redaction tallies into a run-level total. */
function mergeCounts(target, source) {
  for (const key of Object.keys(source || {})) {
    target[key] = (target[key] || 0) + source[key];
  }
  return target;
}

const buildTrajectories = (profile, options) => {
  const opts = Object.assign({}, DEFAULT_TRAJECTORY_OPTIONS, options || {});
  const transcripts = listTranscripts().sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions = [];
  const redactions = {};
  let bytes = 0;
  let truncatedSteps = 0;
  let toolCalls = 0;
  let skippedForBudget = 0;

  for (const transcript of transcripts) {
    if (bytes >= opts.maxBytes) {
      skippedForBudget += 1;
      continue;
    }
    const rows = readJsonl(transcript.file);
    if (!rows.length) continue;

    const trace = buildTrajectorySteps(rows, opts);
    if (!trace.steps.length) continue;

    const session = Object.assign(
      {
        sessionId: transcript.sessionId,
        kind: transcript.kind,
        parentSessionId: transcript.parentSessionId,
      },
      summarizeTranscript(rows, transcript.projectDir),
      { steps: trace.steps, stepCounts: trace.stepCounts },
    );

    // Measure what we are actually about to ship, so the cap is honest about
    // payload size rather than about row counts. The first session is always
    // exported, even if it alone exceeds the budget — an empty scope would be
    // worse than an oversized one, and the degraded telemetry says so.
    let size = 0;
    try {
      size = JSON.stringify(session).length;
    } catch (e) {
      continue;
    }
    if (bytes + size > opts.maxBytes && sessions.length > 0) {
      skippedForBudget += 1;
      continue;
    }

    bytes += size;
    truncatedSteps += trace.truncatedSteps;
    toolCalls += trace.stepCounts.tool_call || 0;
    mergeCounts(redactions, trace.redactions);
    sessions.push(session);
  }

  const totalRedactions = Object.keys(redactions).reduce((sum, k) => sum + redactions[k], 0);

  return {
    profile,
    sessions,
    total: sessions.length,
    totalSteps: sessions.reduce((sum, s) => sum + s.steps.length, 0),
    toolCalls,
    approximateBytes: bytes,
    limits: {
      maxStepChars: opts.maxStepChars,
      maxBytes: opts.maxBytes,
      includeThinking: opts.includeThinking,
    },
    truncatedSteps,
    skippedForBudget,
    redactions: { total: totalRedactions, byType: redactions },
    source: 'projects-transcripts',
  };
};

// ─── claude_code.prompts (from history.jsonl) ────────────────────────────────

const buildPrompts = (profile) => {
  const rows = readJsonl(path.join(CLAUDE_HOME, 'history.jsonl'));
  // Collapse runs of whitespace to single spaces so multi-line prompts read as
  // clean one-line index entries (mirrors the Claude connector's readTextValue).
  const normalize = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
  const counts = {};
  const prompts = rows.map((row) => ({
    display: redactText(normalize(row.display), counts),
    timestamp: toIso(row.timestamp),
    project: row.project || null,
    sessionId: row.sessionId || null,
    hasPastedContent: !!(
      row.pastedContents &&
      typeof row.pastedContents === 'object' &&
      Object.keys(row.pastedContents).length > 0
    ),
  }));

  prompts.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return {
    profile,
    prompts,
    total: prompts.length,
    source: 'history-jsonl',
  };
};

// ─── Main export flow ────────────────────────────────────────────────────────

const ALL_SCOPES = [
  'claude_code.usage',
  'claude_code.sessions',
  'claude_code.prompts',
  'claude_code.trajectories',
];

const readTrajectoryOptions = () => {
  const num = (name, fallback) => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxStepChars: num('CLAUDE_CODE_MAX_STEP_CHARS', DEFAULT_TRAJECTORY_OPTIONS.maxStepChars),
    maxBytes:
      num('CLAUDE_CODE_MAX_MB', DEFAULT_TRAJECTORY_OPTIONS.maxBytes / (1024 * 1024)) *
      1024 *
      1024,
    includeThinking: process.env.CLAUDE_CODE_INCLUDE_THINKING !== 'false',
  };
};

(async () => {
  // Loaded as a CommonJS module by the unit tests — nothing to run.
  if (typeof page === 'undefined') return;

  await loadNodeBuiltins();

  const requested =
    typeof page.requestedScopes === 'function' && page.requestedScopes().length
      ? page.requestedScopes()
      : ALL_SCOPES.slice();
  const wants = (scope) => requested.indexOf(scope) !== -1;
  const errors = [];

  await page.setData('status', 'Reading local Claude Code data from ' + CLAUDE_HOME + '...');

  if (!fs.existsSync(CLAUDE_HOME)) {
    const reason =
      'No Claude Code data found at ' +
      CLAUDE_HOME +
      '. Install and run Claude Code first, or set CLAUDE_CONFIG_DIR.';
    await page.setData('error', reason);
    await page.setData('result', {
      requestedScopes: requested,
      errors: [
        { errorClass: 'upstream_error', reason, disposition: 'fatal', phase: 'discovery' },
      ],
      exportSummary: { count: 0, label: 'items', details: { claudeHome: CLAUDE_HOME } },
      timestamp: new Date().toISOString(),
      version: '1.1.0-vanilla',
      platform: 'claude_code',
    });
    return;
  }

  const totalSteps = requested.length;
  let stepNumber = 0;
  const progress = async (label, message) => {
    stepNumber += 1;
    await page.setProgress({ phase: { step: stepNumber, total: totalSteps, label }, message });
  };

  const profile = buildProfile();
  const result = {
    requestedScopes: requested,
    errors,
    timestamp: new Date().toISOString(),
    version: '1.1.0-vanilla',
    platform: 'claude_code',
  };

  let usage = null;
  let sessions = null;
  let prompts = null;
  let trajectories = null;

  if (wants('claude_code.usage')) {
    await progress('Usage', 'Aggregating usage statistics...');
    usage = buildUsage(profile);
    result['claude_code.usage'] = usage;
  }

  if (wants('claude_code.sessions')) {
    await progress('Sessions', 'Scanning project session transcripts...');
    sessions = buildSessions(profile);
    result['claude_code.sessions'] = sessions;
  }

  if (wants('claude_code.prompts')) {
    await progress('Prompts', 'Collecting prompt history...');
    prompts = buildPrompts(profile);
    result['claude_code.prompts'] = prompts;
  }

  if (wants('claude_code.trajectories')) {
    await progress('Trajectories', 'Building agent traces from session transcripts...');
    trajectories = buildTrajectories(profile, readTrajectoryOptions());
    result['claude_code.trajectories'] = trajectories;

    // A capped export is still a good export — but say so, per scope, instead
    // of letting a partial corpus look complete.
    if (trajectories.skippedForBudget > 0) {
      errors.push({
        errorClass: 'runtime_error',
        reason:
          'Trajectory export hit its ' +
          Math.round(trajectories.limits.maxBytes / (1024 * 1024)) +
          ' MB budget; ' +
          trajectories.skippedForBudget +
          ' older sessions were not exported. Raise CLAUDE_CODE_MAX_MB to include them.',
        disposition: 'degraded',
        scope: 'claude_code.trajectories',
        phase: 'collection',
      });
    }
    if (trajectories.truncatedSteps > 0) {
      errors.push({
        errorClass: 'runtime_error',
        reason:
          trajectories.truncatedSteps +
          ' step bodies were truncated at ' +
          trajectories.limits.maxStepChars +
          ' characters. Raise CLAUDE_CODE_MAX_STEP_CHARS for full bodies.',
        disposition: 'degraded',
        scope: 'claude_code.trajectories',
        phase: 'collection',
      });
    }
  }

  const count =
    (sessions ? sessions.total : 0) +
    (prompts ? prompts.total : 0) +
    (trajectories ? trajectories.total : 0);

  result.exportSummary = {
    count,
    label: 'items',
    details: {
      sessions: sessions ? sessions.total : 0,
      prompts: prompts ? prompts.total : 0,
      trajectorySessions: trajectories ? trajectories.total : 0,
      trajectorySteps: trajectories ? trajectories.totalSteps : 0,
      toolCalls: trajectories ? trajectories.toolCalls : 0,
      redactions: trajectories ? trajectories.redactions.total : 0,
      models: usage ? usage.models.length : 0,
      lifetimeMessages: (usage && usage.totals && usage.totals.messages) || 0,
    },
  };

  await page.setData('result', result);
  await page.setData(
    'status',
    'Complete! Exported ' +
      result.exportSummary.details.sessions +
      ' sessions, ' +
      result.exportSummary.details.trajectorySteps +
      ' trace steps (' +
      result.exportSummary.details.toolCalls +
      ' tool calls) from Claude Code.',
  );
})();

// Exported for unit tests; invisible to the runner (no `module` in AsyncFunction scope).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REDACTIONS,
    DEFAULT_TRAJECTORY_OPTIONS,
    loadNodeBuiltins,
    listTranscripts,
    buildTrajectories,
    redactText,
    redactDeep,
    capText,
    blocksOf,
    toolResultText,
    buildTrajectorySteps,
    summarizeTranscript,
    mergeCounts,
  };
}
