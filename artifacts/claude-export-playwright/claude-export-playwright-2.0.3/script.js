// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Connector — Official Export (Playwright)
 *
 * An alternative to the live-API `claude-playwright` connector that uses
 * Anthropic's first-party data export (Settings → Privacy → Export data):
 *   POST /api/organizations/:org/export_data  → { nonce }
 *   then a navigation download of /export/:org/download/:nonce → a ZIP.
 *
 * The ZIP is a strict superset of the live-API collection (all conversations
 * with full threads, projects, profile), retrieved in one shot with no
 * per-conversation rate limiting. It is produced by an async job, so this
 * connector is resumable: run 1 requests the export and checkpoints the nonce;
 * if the archive is not ready yet (or cannot be read) the run marks the scopes
 * `omitted` and emits no payload for them, and a later run captures it. An
 * omitted scope is never emitted empty: a host would ingest the empty payload
 * as if the account held no data. Output is the same honest-telemetry scoped
 * result the live-API connector emits (claude.conversations /
 * claude.projects), so the two are interchangeable downstream.
 *
 * Two export shapes are read. The original is one ZIP holding conversations.json
 * and projects/*.json. Since 2026-09-22 Claude can instead deliver a MANIFEST
 * ({ data_files: [{ category, part, filename, export_url }] }) plus one ZIP per
 * category (conversations-000.zip, projects-000.zip, ...). The manifest comes
 * either in the POST export_data response or as the file the nonce download
 * saves. Each export_url is a one-shot link. A category that was not downloaded,
 * or a conversations category that holds no conversations.json, is `omitted`,
 * never an empty collected scope.
 *
 * Requires runner page methods: page.captureDownload(url) and
 * page.extractZipEntries(path) (DataConnect playwright-runner). The page-API
 * runtime cannot otherwise retrieve the binary ZIP (in-browser fetch is
 * Sec-Fetch-gated to the SPA shell; httpFetch reads text and corrupts binary).
 */

const CLAUDE_HOME_URL = 'https://claude.ai/new';
const CLAUDE_LOGIN_URL = 'https://claude.ai/login';
const CKPT_DB = 'pdpconnect_claude_export_ckpt';
// The export is an async job; poll within the run so it completes in one click.
const POLL_ATTEMPT_TIMEOUT_MS = 25000;     // per attempt: navigate + wait for the download to fire
const POLL_INTERVAL_MS = 8000;             // pause between attempts while the job is still preparing
const MAX_WAIT_MS = 15 * 60 * 1000;        // overall cap before falling back to a resumable partial
const ALL_SCOPES = ['claude.conversations', 'claude.projects'];

// ─── Scope resolution ────────────────────────────────────────────────
const resolveRequestedScopes = async () => {
  try {
    if (typeof page.requestedScopes === 'function') {
      const s = await page.requestedScopes();
      if (Array.isArray(s) && s.length > 0) return s;
    }
  } catch (err) { /* older runner */ }
  return ALL_SCOPES.slice();
};

// ─── Minimal checkpoint: persist the pending export nonce across runs ─
const CKPT_INPAGE = `
const __ckpt = (function () {
  const DB = ${JSON.stringify(CKPT_DB)};
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function get() {
    let db; try { db = await open(); } catch (e) { return {}; }
    return await new Promise((res) => { const g = db.transaction('meta').objectStore('meta').get('export'); g.onsuccess = () => res(g.result && g.result.v ? g.result.v : {}); g.onerror = () => res({}); });
  }
  async function set(v) {
    const db = await open(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ k: 'export', v });
    return await new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
  }
  async function clear() {
    const db = await open(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('export');
    return await new Promise((res) => { tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
  }
  return { get, set, clear };
})();
`;
const ckptGet = async () => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.get(); } catch (e) { return {}; } })()`); }
  catch (e) { return {}; }
};
const ckptSet = async (v) => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.set(${JSON.stringify(v)}); } catch (e) { return false; } })()`); }
  catch (e) { return false; }
};
const ckptClear = async () => {
  try { return await page.evaluate(`(async () => { ${CKPT_INPAGE} try { return await __ckpt.clear(); } catch (e) { return false; } })()`); }
  catch (e) { return false; }
};

// ─── Login / session ─────────────────────────────────────────────────
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLogin = !!document.querySelector('button[type="submit"]') &&
          !!document.querySelector('input[type="email"], input[name="email"]');
        if (hasLogin) return false;
        return !!document.querySelector('button[data-testid="user-menu-button"]') ||
          !!document.querySelector('nav[aria-label="Sidebar"]') ||
          !!document.querySelector('a[href="/new"][aria-label="New chat"]');
      })()
    `);
  } catch (e) { return false; }
};

const readProfile = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const t = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const b = document.querySelector('button[data-testid="user-menu-button"]');
        const name = t(b?.querySelector('span')?.textContent);
        const plan = t((b ? Array.from(b.querySelectorAll('span')) : []).map(n => n.textContent || '').find(x => x && x !== name) || '');
        return { name: name || null, plan: plan || null };
      })()
    `);
  } catch (e) { return { name: null, plan: null }; }
};

// Run an in-page JSON request (cookies + TLS fingerprint).
const apiGet = async (url) => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { accept: 'application/json' } });
          let json = null; try { json = await r.json(); } catch (_) {}
          return { ok: r.ok, status: r.status, json };
        } catch (e) { return { ok: false, status: 0, error: e.message }; }
      })()
    `);
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
};

const resolveOrganizationId = async () => {
  const r = await apiGet('https://claude.ai/api/organizations');
  if (r.ok && Array.isArray(r.json) && r.json.length) {
    const org = r.json.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'))
      || r.json.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('claude_pro'))
      || r.json[0];
    if (org && org.uuid) return org.uuid;
  }
  return null;
};

const requestExport = async (organizationId) => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const r = await fetch('https://claude.ai/api/organizations/' + ${JSON.stringify(organizationId)} + '/export_data', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', accept: '*/*' }, body: '{}'
          });
          let json = null; try { json = await r.json(); } catch (_) {}
          return { ok: r.ok, status: r.status, nonce: json && json.nonce ? json.nonce : null, manifest: json && Array.isArray(json.data_files) ? json : null };
        } catch (e) { return { ok: false, status: 0, error: e.message }; }
      })()
    `);
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
};

// ─── Normalization (mirrors claude-export-ingest.cjs / the live connector) ──
const flattenMessageText = (m) => {
  if (typeof m?.text === 'string' && m.text.length > 0) return m.text;
  const c = m?.content;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => !p ? '' : (typeof p === 'string' ? p : (typeof p.text === 'string' ? p.text : (typeof p.content === 'string' ? p.content : '')))).filter(Boolean).join('\n');
  if (typeof c.text === 'string') return c.text;
  return '';
};

const normalizeConversation = (conv) => {
  const id = conv?.uuid || conv?.id || null;
  const raw = Array.isArray(conv?.chat_messages) ? conv.chat_messages.slice() : [];
  raw.sort((a, b) => (Date.parse(a?.created_at || '') || 0) - (Date.parse(b?.created_at || '') || 0));
  // Personal Server payload is the readable conversation only. The raw Claude
  // content blocks (tool_use / tool_result / thinking + per-block metadata) are
  // ~79% of the bytes and are NOT carried into the PS — the full-fidelity raw
  // archive stays local in the downloaded export ZIP (see persistedArchivePath).
  const messages = raw.map(m => ({
    id: m?.uuid || null,
    sender: m?.sender || null,
    parentId: m?.parent_message_uuid || null,
    createdAt: m?.created_at || null,
    updatedAt: m?.updated_at || null,
    content: flattenMessageText(m),
    attachments: Array.isArray(m?.attachments) ? m.attachments : [],
  }));
  return {
    id,
    title: conv?.name || conv?.summary || 'Untitled',
    href: id ? `/chat/${id}` : null,
    createdAt: conv?.created_at || null,
    updatedAt: conv?.updated_at || null,
    starred: typeof conv?.is_starred === 'boolean' ? conv.is_starred : null,
    projectId: conv?.project_uuid || null,
    messageCount: messages.length,
    messages,
    fetchError: null,
  };
};

const normalizeProject = (p) => {
  const id = p?.uuid || p?.id || null;
  return {
    id,
    title: p?.name || 'Untitled project',
    href: id ? `/project/${id}` : null,
    label: p?.name ? `Project, ${p.name}` : null,
    createdAt: p?.created_at || null,
    updatedAt: p?.updated_at || null,
    archived: Boolean(p?.archived_at),
    detail: p || null,
  };
};

// Export parts the connector reads. Everything else in a split export
// (memories, design_chats, light_metadata other than users.json) is not used.
const SCOPE_C = 'claude.conversations';
const SCOPE_P = 'claude.projects';

// ctx.omitted maps a scope to the reason it was not collected. ctx.pending
// omits every requested scope with ctx.pendingReason. A scope in neither is
// collected, and is emitted even when empty.
const buildResult = (requestedScopes, ctx) => {
  const omittedReasons = {};
  const defaultReason = ctx.pendingReason ||
    'Claude is still preparing the export. The request is checkpointed — re-run in a few minutes to finish.';
  for (const scope of requestedScopes) {
    if (ctx.pending) omittedReasons[scope] = defaultReason;
    else if (ctx.omitted && ctx.omitted[scope]) omittedReasons[scope] = ctx.omitted[scope];
  }
  const isOmitted = (scope) => Object.prototype.hasOwnProperty.call(omittedReasons, scope);
  const wantsC = requestedScopes.includes(SCOPE_C) && !isOmitted(SCOPE_C);
  const wantsP = requestedScopes.includes(SCOPE_P) && !isOmitted(SCOPE_P);
  const conversations = wantsC ? (ctx.conversations || []) : [];
  const projects = wantsP ? (ctx.projects || []) : [];
  const totalMessages = conversations.reduce((s, c) => s + (c.messageCount || 0), 0);
  const profile = ctx.profile || { name: null, plan: null };

  // An omitted scope is reported and has no payload (below): an empty payload
  // marked `degraded` would be ingested as if the account had no data.
  const errors = Object.keys(omittedReasons).map((scope) => (
    { errorClass: 'upstream_error', reason: omittedReasons[scope], disposition: 'omitted', scope, phase: 'export' }
  ));

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '2.0.0-export',
    platform: 'claude',
    exportSummary: {
      count: conversations.length + projects.length,
      label: 'items',
      details: {
        conversations: conversations.length,
        messages: totalMessages,
        projects: projects.length,
        designChats: ctx.designChats || 0,
        pending: Boolean(ctx.pending),
        exportFormat: ctx.exportFormat || null,
        source: 'official-export',
        organizationId: ctx.organizationId || null,
        // Markers so a tester can confirm this is the trimmed v2 build:
        payloadMode: 'text-only',
        rawContentInPayload: false,
        rawArchivePath: ctx.rawArchivePath || null,
      },
    },
    errors,
  };
  const payloads = {
    [SCOPE_C]: { profile, organizationId: ctx.organizationId || null, conversations, total: conversations.length, messageTotal: totalMessages, source: 'official-export' },
    [SCOPE_P]: { profile, organizationId: ctx.organizationId || null, projects, total: projects.length, source: 'official-export' },
  };
  for (const scope of Object.keys(payloads)) {
    if (requestedScopes.includes(scope) && !isOmitted(scope)) result[scope] = payloads[scope];
  }
  return result;
};

// ─── Reading an export ───────────────────────────────────────────────

const ZIP_INCLUDE = ['conversations.json', 'projects/', 'users.json', 'design_chats/'];
const PART_DOWNLOAD_TIMEOUT_MS = 60000;
// A manifest is a small JSON file; anything larger is not one.
const MAX_MANIFEST_CHARS = 1024 * 1024;

const isManifest = (m) => Boolean(m) && typeof m === 'object' && !Array.isArray(m) && Array.isArray(m.data_files);

// The runner can only parse ZIPs, so a manifest the nonce download saved is
// read by opening the saved file in the page and taking its text. Returns the
// manifest, or null when the file is not (or cannot be read as) a manifest.
const readSavedManifest = async (filePath) => {
  try {
    await page.goto('file://' + encodeURI(filePath));
    const text = await page.evaluate(`(() => (document.body ? document.body.innerText : '') || '')()`);
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_MANIFEST_CHARS) return null;
    const json = JSON.parse(text);
    return isManifest(json) ? json : null;
  } catch (e) { return null; }
};

// Download and read one category ZIP of a manifest. Never throws: a part that
// cannot be downloaded or read is reported as failed.
const downloadPart = async (dataFile) => {
  const label = `${dataFile.category}/${dataFile.filename || dataFile.part}`;
  try {
    const dl = await page.captureDownload(dataFile.export_url, { timeout: PART_DOWNLOAD_TIMEOUT_MS });
    if (!dl || !dl.ok || !dl.ready) return { ok: false, label, category: dataFile.category };
    const extracted = await page.extractZipEntries(dl.path, { include: ZIP_INCLUDE });
    if (!extracted || !extracted.ok) return { ok: false, label, category: dataFile.category };
    return { ok: true, label, category: dataFile.category, json: extracted.json || {}, path: dl.path || null };
  } catch (e) { return { ok: false, label, category: dataFile.category }; }
};

const byPart = (a, b) => (a.part || 0) - (b.part || 0) || (a.batch_index || 0) - (b.batch_index || 0);

// Reads a manifest's category ZIPs (every part). Returns { omitted, conversations,
// projects, profile, designChats, rawArchivePath }; `omitted` maps each
// requested scope that was not positively collected to a reason.
const readManifestExport = async (manifest, requestedScopes) => {
  const wantsC = requestedScopes.includes(SCOPE_C);
  const wantsP = requestedScopes.includes(SCOPE_P);
  const files = manifest.data_files.filter(f => f && typeof f.category === 'string' && typeof f.export_url === 'string').sort(byPart);
  const omitted = {};
  let rawConversations = [];
  const rawProjects = [];
  let users = null;

  let rawArchivePath = null;

  const fetchCategory = async (category) => {
    const parts = files.filter(f => f.category === category);
    const done = [];
    for (const f of parts) done.push(await downloadPart(f));
    return { listed: parts.length, done, failed: done.filter(d => !d.ok) };
  };

  if (wantsC) {
    const c = await fetchCategory('conversations');
    if (c.listed === 0) {
      omitted[SCOPE_C] = 'Claude\'s export lists no conversations category, so the conversations were not collected. Re-run to retry.';
    } else if (c.failed.length > 0) {
      omitted[SCOPE_C] = `The conversations part(s) of Claude's export could not be downloaded or read (${c.failed.map(d => d.label).join(', ')}). Re-run to retry.`;
    } else {
      // Only a conversations.json that parsed to an array proves the category:
      // items, or a literal [] for an account with no conversations.
      let found = false;
      for (const d of c.done) {
        const list = d.json['conversations.json'];
        if (Array.isArray(list)) { found = true; rawConversations = rawConversations.concat(list); }
        rawArchivePath = rawArchivePath || d.path;
        if (d.json['users.json'] !== undefined && users === null) users = d.json['users.json'];
      }
      if (!found) omitted[SCOPE_C] = 'Claude\'s conversations export held no readable conversations.json, so the conversations were not collected. Re-run to retry.';
    }
  }
  if (wantsP) {
    const pr = await fetchCategory('projects');
    if (pr.listed === 0) {
      omitted[SCOPE_P] = 'Claude\'s export lists no projects category, so the projects were not collected. Re-run to retry.';
    } else if (pr.failed.length > 0) {
      omitted[SCOPE_P] = `The projects part(s) of Claude's export could not be downloaded or read (${pr.failed.map(d => d.label).join(', ')}). Re-run to retry.`;
    } else {
      for (const d of pr.done) {
        for (const k of Object.keys(d.json)) if (k.startsWith('projects/')) rawProjects.push(d.json[k]);
      }
    }
  }
  // Account name: users.json from light_metadata, when that part is available.
  if (users === null) {
    const lm = files.filter(f => f.category === 'light_metadata');
    for (const f of lm) {
      const d = await downloadPart(f);
      if (d.ok && d.json['users.json'] !== undefined) { users = d.json['users.json']; break; }
    }
  }
  return { omitted, rawConversations, rawProjects, users, rawArchivePath };
};

const nameFromUsers = (users, profile) =>
  Array.isArray(users) && users[0] && users[0].full_name
    ? { name: users[0].full_name || profile.name || null, plan: profile.plan || null }
    : profile;

// Builds the result for a manifest export and returns { result, collectedAll }.
const resultFromManifest = async (manifest, requestedScopes, base) => {
  const m = await readManifestExport(manifest, requestedScopes);
  const conversations = m.rawConversations.map(normalizeConversation).filter(c => c.id);
  const projects = m.rawProjects.map(normalizeProject).filter(p => p.id);
  const result = buildResult(requestedScopes, {
    ...base, conversations, projects, omitted: m.omitted, pending: false,
    profile: nameFromUsers(m.users, base.profile), rawArchivePath: m.rawArchivePath, exportFormat: 'split-manifest',
  });
  return { result, collectedAll: Object.keys(m.omitted).length === 0 };
};

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const requestedScopes = await resolveRequestedScopes();

  // Capability check — this connector needs the runner download/zip methods.
  if (typeof page.captureDownload !== 'function' || typeof page.extractZipEntries !== 'function') {
    await page.setData('result', {
      requestedScopes,
      timestamp: new Date().toISOString(),
      version: '1.0.0-export',
      platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: {} },
      errors: [{ errorClass: 'runtime_error', reason: 'This runner lacks page.captureDownload / page.extractZipEntries required for the Claude export flow. Update DataConnect.', disposition: 'fatal', phase: 'capability' }],
    });
    await page.setData('error', 'Runner missing export capabilities (captureDownload/extractZipEntries).');
    return;
  }

  // Phase 1: login.
  await page.setData('status', 'Checking Claude session...');
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(2000);
  let isLoggedIn = await checkLoginStatus();
  if (!isLoggedIn) {
    await page.setData('status', 'Claude needs a live login. Opening a browser so you can sign in.');
    const { headed } = await page.showBrowser(CLAUDE_LOGIN_URL);
    if (!headed) { await page.setData('error', 'Could not open a browser window for Claude login.'); return; }
    await page.promptUser('Log in to Claude, then click Done once you can see the sidebar or new chat screen.', async () => await checkLoginStatus(), 2000);
    await page.goto(CLAUDE_HOME_URL);
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) { await page.setData('error', 'Claude login was not detected after manual sign-in.'); return; }
  }

  await page.goHeadless();
  await page.goto(CLAUDE_HOME_URL);
  await page.sleep(1500);

  const profile = await readProfile();
  const organizationId = await resolveOrganizationId();
  if (!organizationId) {
    await page.setData('result', {
      requestedScopes, timestamp: new Date().toISOString(), version: '1.0.0-export', platform: 'claude',
      exportSummary: { count: 0, label: 'items', details: {} },
      errors: [{ errorClass: 'auth_failed', reason: 'No active Claude organization could be resolved from the session.', disposition: 'fatal', phase: 'session' }],
    });
    await page.setData('status', 'Could not resolve a Claude organization. Re-run after signing in.');
    return;
  }

  // Completes the run from a built result. The pending nonce is dropped only
  // when every requested scope was collected; otherwise it stays for the re-run.
  const finish = async (built) => {
    await page.setData('result', built.result);
    if (built.collectedAll) {
      await ckptClear();
      const d = built.result.exportSummary.details;
      await page.setData('status', `Complete! Imported ${d.conversations} conversations (${d.messages} messages) and ${d.projects} projects from the Claude export.`);
    } else {
      await page.setData('status', 'Part of the Claude export could not be collected. Re-run to retry.');
    }
  };
  const notCollected = async (pendingReason, status) => {
    const ctx = { organizationId, profile, conversations: [], projects: [], pending: true, pendingReason };
    await page.setData('result', buildResult(requestedScopes, ctx));
    await page.setData('status', status);
  };

  // Phase 2: ensure an export exists (resume a checkpointed nonce, else request).
  const ckpt = await ckptGet();
  let nonce = ckpt && ckpt.organizationId === organizationId ? ckpt.nonce : null;

  if (!nonce) {
    await page.setProgress({ phase: { step: 1, total: 3, label: 'Requesting export' }, message: 'Asking Claude to prepare your data export...' });
    const req = await requestExport(organizationId);
    if (req.ok && req.manifest && !req.nonce) {
      // Claude answered with the split-export manifest directly. Its links are
      // one-shot and are not checkpointed.
      await page.setProgress({ phase: { step: 3, total: 3, label: 'Reading export' }, message: 'Downloading your Claude export...' });
      await finish(await resultFromManifest(req.manifest, requestedScopes, { organizationId, profile }));
      return;
    }
    if (!req.ok || !req.nonce) {
      await notCollected(
        `Could not start the export (HTTP ${req.status || 0}${req.error ? ': ' + req.error : ''}). Claude may rate-limit exports — try again later.`,
        'Could not start the Claude export. Re-run later.');
      return;
    }
    nonce = req.nonce;
    await ckptSet({ organizationId, nonce, requestedAt: new Date().toISOString() });
  }

  // Phase 3: wait for the async export to finish, then capture it — all in one
  // run. Each attempt navigates to the download URL; when the job is ready the
  // page triggers the download and captureDownload returns it, otherwise it
  // times out and we poll again until the overall cap.
  const downloadUrl = `https://claude.ai/export/${organizationId}/download/${nonce}`;
  const waitStart = Date.now();
  let dl = null;
  while (true) {
    const elapsed = Math.round((Date.now() - waitStart) / 1000);
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Preparing export' },
      message: elapsed === 0
        ? 'Waiting for Claude to prepare your export...'
        : `Still preparing your export (${elapsed}s elapsed)...`,
    });
    dl = await page.captureDownload(downloadUrl, { timeout: POLL_ATTEMPT_TIMEOUT_MS });
    if (dl && dl.ok && dl.ready) break;
    if (Date.now() - waitStart > MAX_WAIT_MS) break;
    await page.sleep(POLL_INTERVAL_MS);
  }

  if (!dl || !dl.ok || !dl.ready) {
    // Exceeded the wait budget — keep the nonce checkpointed so a re-run resumes
    // (the job will be ready by then) rather than discarding progress.
    const waited = Math.round((Date.now() - waitStart) / 60000);
    await notCollected(
      `Claude's export was still not ready after ${waited} min. The request is checkpointed — re-run to finish.`,
      'Export is taking longer than usual to prepare. Re-run shortly to finish.');
    return;
  }

  await page.setProgress({ phase: { step: 3, total: 3, label: 'Reading export' }, message: `Unpacking ${dl.name} (${Math.round((dl.size || 0) / 1048576)} MB)...` });
  const extracted = await page.extractZipEntries(dl.path, { include: ZIP_INCLUDE });
  if (!extracted || !extracted.ok) {
    // Not a ZIP. Claude's nonce download can deliver the split-export manifest.
    const manifest = await readSavedManifest(dl.path);
    await page.goto(CLAUDE_HOME_URL);
    if (manifest) {
      await finish(await resultFromManifest(manifest, requestedScopes, { organizationId, profile, rawArchivePath: dl.path || null }));
      return;
    }
    await notCollected(
      `The export file could not be read as an archive or a manifest (${extracted && extracted.error ? extracted.error : 'unknown'}). Re-run to retry.`,
      'Could not read the downloaded export. Re-run to retry.');
    return;
  }

  const json = extracted.json || {};
  // Only a conversations.json that parsed to an array proves a single-ZIP
  // export; a ZIP without one is an unknown layout, not an empty account.
  if (!Array.isArray(json['conversations.json'])) {
    const names = Array.isArray(extracted.names) ? extracted.names.slice(0, 20).join(', ') : '';
    await notCollected(
      `The export archive has no readable conversations.json (entries: ${names || 'none'}). Re-run to retry.`,
      'Could not read the downloaded export. Re-run to retry.');
    return;
  }

  const wantsC = requestedScopes.includes(SCOPE_C);
  const wantsP = requestedScopes.includes(SCOPE_P);
  const conversations = wantsC ? json['conversations.json'].map(normalizeConversation).filter(c => c.id) : [];
  const projects = wantsP
    ? Object.keys(json).filter(k => k.startsWith('projects/')).map(k => normalizeProject(json[k])).filter(p => p.id) : [];
  const designChats = Object.keys(json).filter(k => k.startsWith('design_chats/')).length;
  const exportProfile = Array.isArray(json['users.json']) && json['users.json'][0]
    ? { name: json['users.json'][0].full_name || profile.name || null, plan: profile.plan || null }
    : profile;

  // The downloaded export ZIP IS the full-fidelity raw archive; it stays on
  // the user's machine and never enters the Personal Server. captureDownload
  // returns its persisted path.
  await finish({
    result: buildResult(requestedScopes, { organizationId, profile: exportProfile, conversations, projects, designChats, pending: false,
      exportFormat: 'single-zip', rawArchivePath: dl.path || null }),
    collectedAll: true,
  });
})();
