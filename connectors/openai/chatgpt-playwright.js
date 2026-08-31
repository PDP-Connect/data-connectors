// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatGPT Connector (Playwright) — Resumable, rate-limit-aware
 *
 * v4.0.0 hot-path changes (see the three inline WHY comments):
 *   - Discovery: cursor-paginated /conversations/search (empty query), fetched in
 *     parallel by computed cursor — replaces O(n^2) offset pagination. Incremental
 *     watermark stops enumeration at the last full-sync time on repeat runs.
 *   - Content: K real parallel /conversations/batch POSTs with AIMD on K (no fixed
 *     700ms floor) — replaces one-POST-at-a-time behind a hard delay.
 *   - Flush: checkpoint-only. The old per-25-conv page.setData('result', <whole
 *     accumulator>) re-serialized the entire result to a listener-less event; gone.
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session (headless)
 *   - If not logged in, shows browser for user to log in
 *   - Extracts auth credentials (token + deviceId + email)
 *
 * Phase 2 (Browser, headless — invisible to user):
 *   - Switches to headless mode so browser window disappears
 *   - Fetches memories, conversation list, and conversation details
 *   - Uses page.evaluate() with fetch() to preserve Cloudflare TLS fingerprint
 *
 * Durability + resume (NEW):
 *   - Every fetched conversation is written to an IndexedDB checkpoint store on
 *     the chatgpt.com origin. The runner's persistent browser profile keeps that
 *     store across runs, so a crash/stop/rate-limit mid-run loses nothing: the
 *     next run reloads the checkpoint and only fetches what's missing or changed.
 *   - v4: durability is the checkpoint ALONE. The result is delivered to the host
 *     exactly once, at the end (page.setData('result', result)) — no per-flush
 *     re-serialization of the whole accumulator.
 *
 * Rate-limit politeness (NEW):
 *   - Adaptive parallelism (AIMD): starts low, adds a parallel request after a
 *     couple of clean waves, resets to one-in-flight on ANY throttle signal
 *     (429 / retry-after / short batch / non-200 / challenge).
 *   - Honors the Retry-After header; exponential backoff with jitter.
 *   - Circuit breaker: after several consecutive fully-rate-limited batches it
 *     stops, checkpoints, and returns a `partial` result instead of hammering the
 *     API thousands of times (the failure mode seen in production: 2410/2484
 *     conversations returned 429).
 *
 * Honest reporting (NEW):
 *   - Conversations that couldn't be fetched are NOT emitted as empty successes.
 *     They are left out of the result and reported via the protocol `errors[]`
 *     array with disposition `degraded`, which classifies the run as `partial`
 *     (data delivered) rather than `failure` (data discarded). Telemetry lives
 *     inside exportSummary.details — never as a non-canonical top-level key.
 */

// ─── Tunables ────────────────────────────────────────────────────────
const CKPT_DB = 'pdpconnect_chatgpt_ckpt';
const CKPT_FORMAT = 1;

// v4: "concurrency" is now the number of /conversations/batch POSTs IN FLIGHT at
// once (real request parallelism), NOT ids-per-POST. Each POST still carries up to
// BATCH_MAX ids (server hard cap; 422 above). Shipped 3.x ran exactly ONE POST at a
// time behind a fixed 700ms floor — that single-in-flight + floor was the ~30-min
// wall. v4 runs K POSTs concurrently with AIMD on K (see the download loop).
const BATCH_MAX = 10;              // server hard cap on conversation_ids per POST
const START_PARALLELISM = 2;       // conservative default (the official web client reads at K=1)
const MAX_PARALLELISM = 4;         // measured: no throttle up to K=3 in a short burst
const MIN_PARALLELISM = 1;
const HEALTHY_WAVES_TO_RAMP = 2;   // consecutive fully-clean waves before K += 1
const BASE_PACE_MS = 200;          // light inter-wave pacing; AIMD halves it toward 0 on healthy waves
const MAX_PACE_MS = 8000;
const MAX_ATTEMPTS = 8;            // per-conversation retry budget for non-throttle errors (5xx/network)
const SERVER_ERROR_MAX_ATTEMPTS = 3; // after this many 5xx on one conversation, skip it (server-side broken)
const CONV_FETCH_TIMEOUT_MS = 30000;
const FLUSH_EVERY_CONVS = 25;      // checkpoint flush cadence (by new convs)
const FLUSH_INTERVAL_MS = 15000;   // …or by time
// v4 discovery: the cursor-paginated search endpoint. Page size is fixed at 30 by
// the server (a `limit` param is ignored) and the cursor is a plain integer that
// advances by exactly one page — so pages are computable and fetched in parallel.
const DISCOVERY_PARALLELISM = 6;   // parallel search pages (measured: 3598 convs in ~23s, no throttle)
const DISCOVERY_PAGE_SIZE = 30;    // server-fixed page size for /conversations/search

// Patient backoff. ChatGPT returns 429 with NO Retry-After / rate-limit headers,
// so we self-pace: once the initial burst is throttled, drop to one request at a
// time and wait progressively longer to let the limit clear, instead of bailing
// immediately. Keep going until the limit recovers, the run-time budget is hit,
// or we stall (then defer the remainder to the next run via the checkpoint).
const PATIENT_BACKOFF_START_MS = 20000;  // first long wait after the burst is throttled
const PATIENT_BACKOFF_MAX_MS = 120000;   // cap per wait
const MAX_RUN_MS = 12 * 60 * 1000;       // overall run budget before deferring to resume
const MAX_STALLED_BATCHES = 6;           // consecutive throttled batches with zero success → defer

// Reuse a recently-cached conversation list on resume so we don't re-walk all
// pages (and risk throttling the list itself) every run.
const LIST_CACHE_MS = 6 * 60 * 60 * 1000; // 6h

// State management
const state = {
  email: null,
  accessToken: null,
  deviceId: null,
  isComplete: false
};

// ─── Browser-Phase Helpers ───────────────────────────────────────────

// Dismiss interrupting popups
const dismissInterruptingDialogs = async () => {
  try {
    await page.evaluate(`
      (() => {
        const buttonElements = document.querySelectorAll('button, a');
        const maybeLaterButton = Array.from(buttonElements).find(el =>
          el.textContent?.toLowerCase().includes('maybe later')
        );
        const rejectNonEssentialButton = Array.from(buttonElements).find(el =>
          el.textContent?.toLowerCase().includes('reject non-essential')
        );

        if (maybeLaterButton && typeof maybeLaterButton.click === 'function') {
          maybeLaterButton.click();
          return 'clicked maybe later';
        }
        if (rejectNonEssentialButton && typeof rejectNonEssentialButton.click === 'function') {
          rejectNonEssentialButton.click();
          return 'clicked reject non-essential';
        }
        return 'no dialogs found';
      })()
    `);
  } catch (err) {
    // Ignore errors
  }
};

// Extract email from page
const extractEmail = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
          const content = script.textContent || script.innerText || '';
          if (content.length > 100) {
            const emailMatch = content.match(/"email":"([^"]+)"/);
            if (emailMatch) {
              return { success: true, email: emailMatch[1] };
            }
          }
        }
        return { success: false };
      })()
    `);

    if (result?.success) return result.email;
    return null;
  } catch (err) {
    return null;
  }
};

// Get authentication credentials from page
const getAuthCredentials = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        let userToken = null;
        let deviceId = null;

        const bootstrapScript = document.getElementById('client-bootstrap');
        if (bootstrapScript) {
          try {
            const bootstrapData = JSON.parse(bootstrapScript.textContent);
            userToken = bootstrapData?.session?.accessToken;
          } catch (e) {}
        }

        if (!userToken && window.CLIENT_BOOTSTRAP) {
          userToken = window.CLIENT_BOOTSTRAP?.session?.accessToken;
        }

        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
          const [name, value] = cookie.trim().split('=');
          if (name === 'oai-did') {
            deviceId = value;
            break;
          }
        }

        return { userToken, deviceId };
      })()
    `);

    return result || { userToken: null, deviceId: null };
  } catch (err) {
    return { userToken: null, deviceId: null };
  }
};

// Check if logged in
const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const allButtons = document.querySelectorAll('button, a');
        const hasLoginButton = Array.from(allButtons).some(el => {
          const text = el.textContent?.toLowerCase() || '';
          return text.includes('log in') || text.includes('sign up');
        });
        if (hasLoginButton) return false;

        const hasSidebar = !!document.querySelector('nav[aria-label="Chat history"]') ||
                          !!document.querySelector('nav a[href^="/c/"]') ||
                          document.querySelectorAll('nav').length > 0;
        const hasUserMenu = !!document.querySelector('[data-testid="profile-button"]') ||
                           !!document.querySelector('button[aria-label*="User menu"]');

        return hasSidebar || hasUserMenu;
      })()
    `);
    return result;
  } catch (err) {
    return false;
  }
};

// ─── Checkpoint store (IndexedDB on the chatgpt.com origin) ──────────
// Persists across runs via the runner's persistent browser profile. The block
// between the sentinels below is extracted verbatim by the connector tests, so
// keep it self-contained (no closures over outer scope, no arrow IIFEs at the
// start of a line — the runner detects the main IIFE by a line-leading
// `(async () => {`).
//
// <inpage-checkpoint>
const CHECKPOINT_INPAGE = `
const __ckpt = (function () {
  const DB_NAME = ${JSON.stringify(CKPT_DB)};
  const FORMAT = ${CKPT_FORMAT};
  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }
  async function loadAll() {
    let db;
    try { db = await openDb(); } catch (e) { return { ok: false, conversations: {}, memories: [], meta: {} }; }
    const meta = await new Promise(function (resolve) {
      const g = db.transaction('meta').objectStore('meta').get('state');
      g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
      g.onerror = function () { resolve({}); };
    });
    // A format bump invalidates the old store.
    if (meta && meta.format && meta.format !== FORMAT) {
      return { ok: true, conversations: {}, memories: [], meta: {}, reset: true };
    }
    const conversations = await new Promise(function (resolve) {
      const out = {};
      const cur = db.transaction('conversations').objectStore('conversations').openCursor();
      cur.onsuccess = function (e) {
        const c = e.target.result;
        if (!c) { resolve(out); return; }
        out[c.value.id] = c.value;
        c.continue();
      };
      cur.onerror = function () { resolve(out); };
    });
    return { ok: true, conversations: conversations, memories: (meta && meta.memories) || [], meta: meta || {} };
  }
  async function putBatch(records, memories, metaPatch) {
    const db = await openDb();
    const stores = ['conversations', 'meta'];
    const tx = db.transaction(stores, 'readwrite');
    const convStore = tx.objectStore('conversations');
    for (let i = 0; i < records.length; i++) convStore.put(records[i]);
    if (memories || metaPatch) {
      const metaStore = tx.objectStore('meta');
      const existing = await new Promise(function (resolve) {
        const g = metaStore.get('state');
        g.onsuccess = function () { resolve(g.result && g.result.v ? g.result.v : {}); };
        g.onerror = function () { resolve({}); };
      });
      const merged = Object.assign({ format: FORMAT }, existing, metaPatch || {});
      if (memories) merged.memories = memories;
      metaStore.put({ k: 'state', v: merged });
    }
    await txDone(tx);
    return { ok: true, wrote: records.length };
  }
  async function clearAll() {
    const db = await openDb();
    const tx = db.transaction(['conversations', 'meta'], 'readwrite');
    tx.objectStore('conversations').clear();
    tx.objectStore('meta').clear();
    await txDone(tx);
    return { ok: true };
  }
  return { loadAll: loadAll, putBatch: putBatch, clearAll: clearAll };
})();
`;
// </inpage-checkpoint>

const ckptLoad = async () =>
  page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.loadAll(); })()`);

const ckptPutBatch = async (records, memories, metaPatch) =>
  page.evaluate(
    `(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.putBatch(` +
      `${JSON.stringify(records || [])}, ${JSON.stringify(memories || null)}, ${JSON.stringify(metaPatch || null)}); })()`
  );

const ckptClear = async () =>
  page.evaluate(`(async () => { ${CHECKPOINT_INPAGE}; return await __ckpt.clearAll(); })()`);

// ─── Data Fetch Helpers (use page.evaluate for Cloudflare compat) ────

// Fetch memories. Returns { ok, status, memories }.
const fetchMemories = async (accessToken, deviceId) => {
  try {
    const result = await page.evaluate(`
      (async () => {
        const token = ${JSON.stringify(accessToken)};
        const device = ${JSON.stringify(deviceId)};
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch("https://chatgpt.com/backend-api/memories?include_memory_entries=true", {
            headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
            method: "GET", credentials: "include", signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!response.ok) return { ok: false, status: response.status };
          const data = await response.json();
          return { ok: true, status: 200, memories: data.memories || [] };
        } catch (err) {
          return { ok: false, status: 0, error: err.message };
        }
      })()
    `);
    return result || { ok: false, status: 0 };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
};

// Discover ALL conversation ids via the cursor-paginated search endpoint.
//
// WHY (v4): the old offset endpoint (/conversations?offset=N) is O(n^2) — server
// latency grows with offset depth (measured 365ms@0 → 6830ms@3000), so a large
// account spends minutes just enumerating. The search endpoint with an EMPTY query
// enumerates every conversation at FLAT latency (~700–1400ms) regardless of depth,
// and its cursor is a plain integer that advances by exactly PAGE (30) per page —
// so the cursor is computable and pages can be fetched IN PARALLEL. We fire K pages
// at once (cursor 0,30,60,…), dedupe ids into a Set (search order can shift between
// pages), and stop at the tail (a page with < PAGE items) or an empty page.
//
// ARCHIVED CONVERSATIONS ARE OUT OF SCOPE for v4 discovery: empty-query search
// returned 3598 where offset probing suggested ~4019, i.e. search appears to EXCLUDE
// archived conversations (the item's `is_archived` is effectively always false on
// this path). We deliberately do NOT add a second archived-enumeration pass here —
// that endpoint/flag behavior is unverified and the parent validated only this empty-
// query path live. Any archived item that DOES surface is still captured (we keep the
// is_archived field flowing through); we simply don't hunt for them. Revisit if
// archived capture becomes a requirement.
//
// Hard-stops on 429 / non-200 / non-JSON, surfacing the trip like other errors.
// Returns { ok, items:[{id,title,update_time,is_archived}], pages, trip, tripStatus }.
const discoverConversations = async (accessToken, deviceId, watermark, K, pageSize) => {
  const result = await page.evaluate(`
    (async () => {
      const token = ${JSON.stringify(accessToken)};
      const device = ${JSON.stringify(deviceId)};
      const K = ${K};
      const PAGE = ${pageSize};
      const watermark = ${JSON.stringify(watermark || null)};
      const H = { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" };

      const fetchPage = async (cursor) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
        try {
          const response = await fetch(
            "https://chatgpt.com/backend-api/conversations/search?query=&cursor=" + cursor,
            { headers: H, method: "GET", credentials: "include", signal: controller.signal }
          );
          clearTimeout(timeout);
          if (response.status === 429) return { trip: 'rate_limited', status: 429, cursor };
          if (response.status !== 200) {
            const t = (await response.text()).slice(0, 80);
            return { trip: 'http_' + response.status, status: response.status, cursor, note: t };
          }
          const ctype = response.headers.get('content-type') || '';
          if (!ctype.includes('application/json')) {
            const t = (await response.text()).slice(0, 80);
            return { trip: 'non_json', status: response.status, cursor, note: t };
          }
          const data = await response.json();
          return { items: data.items || [], cursor };
        } catch (err) {
          clearTimeout(timeout);
          return { trip: 'network', status: 0, cursor, note: err.message };
        }
      };

      const seen = new Set();
      const items = [];
      let cursor = 0, done = false, pages = 0, trip = null, tripStatus = null;
      while (!done && !trip) {
        const wave = [];
        for (let k = 0; k < K; k++) wave.push(fetchPage(cursor + k * PAGE));
        const results = await Promise.all(wave);
        cursor += K * PAGE;
        for (const res of results) {
          if (res.trip) { trip = res.trip + (res.note ? (':' + res.note) : ''); tripStatus = res.status; break; }
          pages++;
          if (res.items.length < PAGE) done = true;            // reached the tail
          for (const it of res.items) {
            const cid = it.conversation_id || it.id;
            if (!cid || seen.has(cid)) continue;                // dedupe: page order can shift
            // Incremental watermark: search is newest-first, so once we cross an item
            // at/older than the last full sync, everything remaining is already saved.
            if (watermark && it.update_time && it.update_time <= watermark) { done = true; continue; }
            seen.add(cid);
            items.push({ id: cid, title: it.title, update_time: it.update_time, is_archived: it.is_archived });
          }
        }
      }
      return { ok: !trip, items, pages, trip, tripStatus };
    })()
  `);
  return result || { ok: false, items: [], pages: 0, trip: 'evaluate_failed', tripStatus: 0 };
};

// Fetch ONE batch (≤ BATCH_MAX ids) via the /conversations/batch endpoint (POST).
// Unlike the per-conversation GET (backend-api/conversation/{id}), this endpoint
// returns full conversation content WITHOUT the brutal per-conversation rate limit —
// it's the path the iOS/macOS ChatGPT apps use, which is why they never hit the 429
// wall the web client does.
//
// v4: this is now a SINGLE POST (the caller fires K of these IN PARALLEL — see the
// download loop's AIMD). Message extraction from each conversation's mapping tree is
// UNCHANGED (walkMessages below, verbatim). We additionally report `meta.batchReturned`
// (raw conversations the server put in the array, BEFORE any single-id fallback) so
// the caller can detect a SHORT batch — fewer returned than requested — which, now
// that a healthy batch is exactly requested/requested, is a reliable throttle signal.
//
// Returns { items: [ per-id { id, ok, status, retryAfter?, rl?, title?, create_time?, update_time?, messages? } ],
//           meta: { requested, batchReturned, status, retryAfter } }.
const fetchConversationBatch = async (accessToken, deviceId, convIds) => {
  const result = await page.evaluate(`
    (async () => {
      const token = ${JSON.stringify(accessToken)};
      const device = ${JSON.stringify(deviceId)};
      const chunk = ${JSON.stringify(convIds)};

      const parseRetryAfter = (resp) => {
        const h = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
        if (!h) return null;
        const secs = Number(h);
        if (!isNaN(secs)) return Math.max(0, secs);
        const when = Date.parse(h);
        if (!isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
        return null;
      };

      // Walk the message tree along the path to current_node (active branch).
      const walkMessages = (data) => {
        const mapping = data.mapping || {};
        const currentNode = data.current_node;

        let rootId = null;
        for (const [nodeId, node] of Object.entries(mapping)) {
          if (!node.parent || !mapping[node.parent]) { rootId = nodeId; break; }
        }

        const ancestorsOfCurrent = new Set();
        let walkUp = currentNode;
        while (walkUp && mapping[walkUp]) {
          ancestorsOfCurrent.add(walkUp);
          walkUp = mapping[walkUp].parent;
        }

        const messages = [];
        let cursor = rootId;
        while (cursor && mapping[cursor]) {
          const node = mapping[cursor];
          if (node.message) {
            const msg = node.message;
            const role = msg.author?.role;
            const contentType = msg.content?.content_type;
            if ((role === 'user' || role === 'assistant') &&
                (contentType === 'text' || contentType === 'multimodal_text')) {
              const textParts = (msg.content?.parts || []).filter(p => typeof p === 'string').join('\\n');
              if (textParts.length > 0) {
                messages.push({
                  id: msg.id, role, content: textParts, content_type: contentType,
                  create_time: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
                  model: msg.metadata?.model_slug || null,
                });
              }
            }
          }
          const children = node.children || [];
          let nextCursor = null;
          for (const childId of children) {
            if (ancestorsOfCurrent.has(childId)) { nextCursor = childId; break; }
          }
          if (!nextCursor && children.length > 0) nextCursor = children[children.length - 1];
          cursor = nextCursor;
        }
        return messages;
      };

      // Single-conversation fallback (mirrors the app's "fetch via remote ID batch
      // fallback"): batch occasionally omits a conversation (e.g. oversized), so we
      // fetch those individually. This path IS subject to the per-id rate limit, but
      // it only runs for the rare omitted conversation, and a 429 just requeues it.
      const fetchOneFallback = async (convId) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
          const response = await fetch(
            "https://chatgpt.com/backend-api/conversation/" + convId,
            { headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US" },
              method: "GET", credentials: "include", signal: controller.signal }
          );
          clearTimeout(timeout);
          if (!response.ok) {
            const rl = {};
            for (const [k, v] of response.headers.entries()) {
              if (/retry-after|rate.?limit|reset|remaining/i.test(k)) rl[k] = v;
            }
            return { id: convId, ok: false, status: response.status, retryAfter: parseRetryAfter(response), rl };
          }
          const data = await response.json();
          return { id: convId, ok: true, status: 200, title: data.title, create_time: data.create_time, update_time: data.update_time, messages: walkMessages(data) };
        } catch (err) {
          return { id: convId, ok: false, status: 0, error: err.message };
        }
      };

      const out = [];
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${CONV_FETCH_TIMEOUT_MS});
        const response = await fetch(
          "https://chatgpt.com/backend-api/conversations/batch",
          { headers: { accept: "*/*", authorization: "Bearer " + token, "oai-device-id": device, "oai-language": "en-US", "content-type": "application/json" },
            method: "POST", credentials: "include", body: JSON.stringify({ conversation_ids: chunk }), signal: controller.signal }
        );
        clearTimeout(timeout);
        const ctype = response.headers.get('content-type') || '';
        // Non-200 OR an HTML challenge served with 200 both count as failure; the
        // caller reads status + batchReturned=0 (short) as a throttle/challenge signal.
        if (!response.ok || !ctype.includes('application/json')) {
          const rl = {};
          for (const [k, v] of response.headers.entries()) {
            if (/retry-after|rate.?limit|reset|remaining/i.test(k)) rl[k] = v;
          }
          const retryAfter = parseRetryAfter(response);
          for (const id of chunk) out.push({ id, ok: false, status: response.status, retryAfter, rl });
          return { items: out, meta: { requested: chunk.length, batchReturned: 0, status: response.status, retryAfter } };
        }
        const arr = await response.json();
        const list = Array.isArray(arr) ? arr : [];
        const byId = new Map(list.map(c => [c.id, c]));
        for (const id of chunk) {
          const data = byId.get(id);
          // batch occasionally omits a conversation (e.g. oversized) → fetch it
          // individually via the fallback below (per-id, and 429-requeued by the caller).
          if (!data) { out.push(await fetchOneFallback(id)); continue; }
          out.push({ id, ok: true, status: 200, title: data.title, create_time: data.create_time, update_time: data.update_time, messages: walkMessages(data) });
        }
        // batchReturned = raw convs the server returned in the array (before fallback):
        // < requested means a short batch, which the caller treats as a throttle signal.
        return { items: out, meta: { requested: chunk.length, batchReturned: list.length, status: 200, retryAfter: null } };
      } catch (err) {
        for (const id of chunk) out.push({ id, ok: false, status: 0, error: err.message });
        return { items: out, meta: { requested: chunk.length, batchReturned: 0, status: 0, retryAfter: null } };
      }
    })()
  `);

  return result || { items: [], meta: { requested: convIds.length, batchReturned: 0, status: 0, retryAfter: null } };
};

// ─── Pure helpers (Node side) ────────────────────────────────────────

const sleep = (ms) => page.sleep(ms);
const jitter = (ms) => Math.floor(Math.random() * ms);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isRateLimited = (status) => status === 429;
const isAuthError = (status) => status === 401 || status === 403;

const toConversationRecord = (listed, fetched) => ({
  id: fetched.id,
  title: fetched.title || listed?.title || 'Untitled',
  create_time: listed?.create_time ?? fetched.create_time ?? null,
  update_time: listed?.update_time ?? fetched.update_time ?? null,
  message_count: fetched.messages.length,
  messages: fetched.messages,
  fetched_at: new Date().toISOString(),
});

const resolveRequestedScopes = async () => {
  const fallback = ['chatgpt.conversations', 'chatgpt.memories'];
  try {
    if (typeof page.requestedScopes === 'function') {
      const scopes = await page.requestedScopes();
      if (Array.isArray(scopes) && scopes.length > 0) return scopes;
    }
  } catch (err) {
    // older runner — fall back
  }
  return fallback;
};

// Build the protocol-compliant result. Telemetry goes under exportSummary.details
// (a permitted object), NEVER as a top-level key — a non-canonical top-level key
// is a protocol_violation that discards the entire run.
const buildResult = (requestedScopes, convMap, memories, telemetry) => {
  const conversations = Array.from(convMap.values());
  const totalMessages = conversations.reduce((sum, c) => sum + (c.message_count || 0), 0);

  const transformedMemories = (memories || []).map((memory) => ({
    id: memory.id || '',
    content: memory.content || '',
    created_at: memory.created_at || memory.createdAt || new Date().toISOString(),
    updated_at: memory.updated_at || memory.updatedAt,
    type: memory.type || 'memory',
  }));

  const wantsConversations = requestedScopes.includes('chatgpt.conversations');
  const wantsMemories = requestedScopes.includes('chatgpt.memories');

  const errors = [];
  const pending = telemetry.pending || 0;
  if (wantsConversations && pending > 0) {
    errors.push({
      errorClass: telemetry.authFailed ? 'auth_failed' : 'rate_limited',
      reason:
        `${pending} of ${telemetry.totalConversations} conversations were not retrieved` +
        (telemetry.authFailed ? ' (session expired mid-run)' : ' (rate limited)') +
        '. They are checkpointed as missing and will be fetched on the next run.',
      disposition: 'degraded',
      scope: 'chatgpt.conversations',
      phase: 'conversations',
    });
  }
  if (wantsMemories && telemetry.memoriesFailed && transformedMemories.length === 0) {
    errors.push({
      errorClass: telemetry.authFailed ? 'auth_failed' : 'rate_limited',
      reason: 'Memories could not be retrieved this run.',
      disposition: 'degraded',
      scope: 'chatgpt.memories',
      phase: 'memories',
    });
  }

  const result = {
    requestedScopes,
    timestamp: new Date().toISOString(),
    version: '4.0.0-playwright',
    platform: 'chatgpt',
    exportSummary: {
      count: conversations.length,
      label: conversations.length === 1 ? 'conversation' : 'conversations',
      details: {
        memories: transformedMemories.length,
        conversations: conversations.length,
        messages: totalMessages,
        // resume/rate-limit telemetry — diagnostic only, lives inside details
        newlyFetched: telemetry.newlyFetched || 0,
        resumedFromCheckpoint: telemetry.resumed || 0,
        pending,
        skipped: telemetry.skipped || 0,   // conversations that 5xx server-side (unfetchable); excluded from pending
        totalConversations: telemetry.totalConversations || conversations.length,
        statusCounts: telemetry.statusCounts || {},
        stoppedReason: telemetry.stoppedReason || null,
      },
    },
    errors,
  };

  // Attach only the requested scopes. Keys are written as literals so the
  // produced scope surface is statically obvious.
  const scopePayloads = {
    'chatgpt.conversations': { conversations, total: conversations.length },
    'chatgpt.memories': { memories: transformedMemories, total: transformedMemories.length },
  };
  for (const scope of Object.keys(scopePayloads)) {
    if (requestedScopes.includes(scope)) result[scope] = scopePayloads[scope];
  }

  return result;
};

// ─── Main Export Flow ─────────────────────────────────────────────────

(async () => {
  // ═══ PHASE 1: Browser — Login & Credential Extraction ═══

  await page.setData('status', 'Checking login status...');
  await page.goto('https://chatgpt.com/');
  await page.sleep(3000);

  // Dismiss any interrupting dialogs
  await dismissInterruptingDialogs();
  await page.sleep(1000);

  // Check if logged in (persistent session from previous run)
  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
  }

  if (!isLoggedIn) {
    // Navigate to ChatGPT login page
    await page.goto('https://chatgpt.com/auth/login');
    await page.sleep(3000);
    await dismissInterruptingDialogs();
    await page.sleep(1000);

    // Click "Log in" button to reach auth.openai.com
    await page.evaluate(`
      (() => {
        const buttons = document.querySelectorAll('button, a');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'log in') { btn.click(); return true; }
        }
        return false;
      })()
    `);
    await page.sleep(3000);

    // Check if we're on the OpenAI auth page with email field
    const hasEmailField = await page.evaluate(`
      !!document.querySelector('input[name="email"]') ||
      !!document.querySelector('input[type="email"]') ||
      !!document.querySelector('#email-input')
    `);

    const supportsRequestInput = typeof page.requestInput === 'function';

    if (supportsRequestInput && hasEmailField) {
      const { email } = await page.requestInput({
        message: "Log in to ChatGPT — enter your OpenAI account email",
        schema: {
          type: "object",
          properties: {
            email: { type: "string", description: "OpenAI account email address" },
          },
          required: ["email"],
        },
      });

      await page.evaluate(`
        (() => {
          const emailInput = document.querySelector('input[name="email"]') ||
                             document.querySelector('input[type="email"]') ||
                             document.querySelector('#email-input');
          if (emailInput) {
            emailInput.value = ${JSON.stringify(email)};
            emailInput.dispatchEvent(new Event('input', {bubbles:true}));
            emailInput.dispatchEvent(new Event('change', {bubbles:true}));
          }
        })()
      `);
      await page.sleep(500);
      await page.evaluate(`
        (() => {
          const btn = document.querySelector('button[type="submit"]') ||
                      document.querySelector('button._button-login-id');
          if (btn) btn.click();
        })()
      `);
      await page.sleep(3000);

      // Password page
      const hasPasswordField = await page.evaluate(`
        !!document.querySelector('input[type="password"]') ||
        !!document.querySelector('input[name="password"]')
      `);

      if (hasPasswordField) {
        const { password } = await page.requestInput({
          message: "Enter your OpenAI account password",
          schema: {
            type: "object",
            properties: {
              password: { type: "string", format: "password" },
            },
            required: ["password"],
          },
        });

        await page.evaluate(`
          (() => {
            const passwordInput = document.querySelector('input[type="password"]') ||
                                  document.querySelector('input[name="password"]');
            if (passwordInput) {
              passwordInput.value = ${JSON.stringify(password)};
              passwordInput.dispatchEvent(new Event('input', {bubbles:true}));
              passwordInput.dispatchEvent(new Event('change', {bubbles:true}));
            }
          })()
        `);
        await page.sleep(500);
        await page.evaluate(`
          (() => {
            const btn = document.querySelector('button[type="submit"]') ||
                        document.querySelector('button._button-login-password');
            if (btn) btn.click();
          })()
        `);
        await page.sleep(5000);

        // Handle 2FA if present
        const needs2fa = await page.evaluate(`
          !!document.querySelector('input[name="code"]') ||
          !!document.querySelector('input[type="tel"]') ||
          !!document.querySelector('input[inputmode="numeric"]')
        `);
        if (needs2fa) {
          const { code } = await page.requestInput({
            message: "Enter your OpenAI 2FA verification code",
            schema: {
              type: "object",
              properties: { code: { type: "string", description: "6-digit verification code" } },
              required: ["code"],
            },
          });
          await page.evaluate(`
            (() => {
              const input = document.querySelector('input[name="code"]') ||
                            document.querySelector('input[type="tel"]') ||
                            document.querySelector('input[inputmode="numeric"]');
              if (input) {
                input.value = ${JSON.stringify(code)};
                input.dispatchEvent(new Event('input', {bubbles:true}));
              }
            })()
          `);
          await page.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
          await page.sleep(5000);
        }
      }

      await dismissInterruptingDialogs();
      await page.sleep(2000);
      isLoggedIn = await checkLoginStatus();
    }

    // Fallback to headed browser if programmatic login failed
    // (needed for SSO flows: Google, Microsoft, Apple)
    if (!isLoggedIn) {
      const { headed } = await page.showBrowser('https://chatgpt.com/');
      if (headed) {
        await page.setData('status', 'Please complete login in the browser (SSO or remaining verification)...');
        await page.promptUser(
          'Complete login in the browser, then click "Done".',
          async () => {
            await dismissInterruptingDialogs();
            return await checkLoginStatus();
          },
          2000
        );
        await page.goHeadless();
      }
    }

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
    await dismissInterruptingDialogs();
    await page.sleep(1000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  await dismissInterruptingDialogs();
  await page.sleep(500);

  // Extract email
  await page.setData('status', 'Extracting credentials...');
  let email = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    email = await extractEmail();
    if (email) break;
    await page.sleep(1500);
  }

  if (!email) {
    await page.setData('error', 'Could not extract email');
    return { error: 'Could not extract email' };
  }

  state.email = email;
  await page.setData('email', email);

  // Get auth credentials
  const { userToken, deviceId } = await getAuthCredentials();
  if (!userToken || !deviceId) {
    await page.setData('error', 'Could not get authentication credentials');
    return { error: 'Could not get authentication credentials' };
  }

  state.accessToken = userToken;
  state.deviceId = deviceId;

  // ═══ Switch to headless — browser window disappears ═══
  await page.setData('status', `Credentials captured for ${email}. Switching to background mode...`);
  await page.goHeadless();

  // ═══ PHASE 2: Headless Browser — Resumable Data Collection ═══

  const requestedScopes = await resolveRequestedScopes();

  // Load checkpoint from a previous (possibly interrupted) run.
  let checkpoint = { ok: false, conversations: {}, memories: [], meta: {} };
  try {
    checkpoint = await ckptLoad();
  } catch (err) {
    await page.setData('status', `Checkpoint unavailable (${err.message}); starting fresh.`);
  }

  // Conversation map: id -> record. Seed with whatever we already have.
  const convMap = new Map();
  for (const id of Object.keys(checkpoint.conversations || {})) {
    convMap.set(id, checkpoint.conversations[id]);
  }
  const resumedCount = convMap.size;
  if (resumedCount > 0) {
    await page.setData('status', `Resuming: ${resumedCount} conversations already saved from a previous run.`);
  }

  const telemetry = {
    statusCounts: {},
    newlyFetched: 0,
    resumed: resumedCount,
    pending: 0,
    totalConversations: 0,
    memoriesFailed: false,
    authFailed: false,
    stoppedReason: null,
    skipped: 0,         // conversations dropped after a persistent server error (5xx)
  };
  const bumpStatus = (s) => {
    const key = String(s);
    telemetry.statusCounts[key] = (telemetry.statusCounts[key] || 0) + 1;
  };

  // Step 1: Memories (cheap, single request). Fall back to checkpointed copy.
  await page.setProgress({ phase: { step: 1, total: 3, label: 'Fetching memories' }, message: 'Downloading memories...' });
  let memories = checkpoint.memories || [];
  const memResult = await fetchMemories(userToken, deviceId);
  if (memResult.ok) {
    memories = memResult.memories;
  } else {
    telemetry.memoriesFailed = memories.length === 0;
  }
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching memories' },
    message: `Fetched ${memories.length} memories${memResult.ok ? '' : ' (from checkpoint)'}`,
    count: memories.length,
  });

  // Step 2: Conversation discovery via the cursor search endpoint. Rarely rate
  // limited; if it fails entirely we fall back to the checkpointed ids.
  await page.setProgress({ phase: { step: 2, total: 3, label: 'Fetching conversation list' }, message: 'Discovering conversations...', count: 0 });

  const listMap = new Map();    // id -> { id, title, create_time, update_time, is_archived }
  let listOk = true;
  const fullSyncDone = !!(checkpoint.meta && checkpoint.meta.fullSyncDone);

  // v4 incremental watermark: on a prior COMPLETED full sync, resume discovery only
  // back to the last full-sync time. Search returns newest-first, so once we cross a
  // conversation whose update_time is <= this marker, everything older is already
  // checkpointed and we stop enumerating — turning repeat syncs from minutes into
  // seconds. NOTE: assumes update_time is an ISO-8601 string (lexically comparable to
  // lastFullSyncAt); if OpenAI ever returns epoch numbers the compare simply never
  // trips and we fall back to a full enumeration (still correct, just slower).
  const watermark = (fullSyncDone && checkpoint.meta && checkpoint.meta.lastFullSyncAt)
    ? checkpoint.meta.lastFullSyncAt : null;

  // Resume fast-path: reuse a recently-cached list instead of re-discovering every
  // page. Only when we already have a partial checkpoint to extend (a mid-download
  // resume — distinct from the cross-full-sync watermark above).
  const cachedList = checkpoint.meta && Array.isArray(checkpoint.meta.listSnapshot) ? checkpoint.meta.listSnapshot : null;
  const cachedFresh = cachedList && checkpoint.meta.listCachedAt &&
    (Date.now() - Date.parse(checkpoint.meta.listCachedAt) < LIST_CACHE_MS);
  let usedCachedList = false;
  if (cachedFresh && convMap.size > 0 && convMap.size < cachedList.length) {
    for (const item of cachedList) listMap.set(item.id, item);
    usedCachedList = true;
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching conversation list' },
      message: `Using cached list — ${listMap.size.toLocaleString()} conversations`,
      count: listMap.size,
    });
  }

  // v4 discovery: enumerate conversation ids via the parallel cursor search
  // (replaces the O(n^2) offset pagination — see discoverConversations).
  if (!usedCachedList) {
    const disc = await discoverConversations(userToken, deviceId, watermark, DISCOVERY_PARALLELISM, DISCOVERY_PAGE_SIZE);
    for (const item of disc.items) {
      // search omits create_time; toConversationRecord falls back to the value from
      // the fetched conversation, so a null here is fine.
      listMap.set(item.id, { id: item.id, title: item.title, create_time: null, update_time: item.update_time, is_archived: item.is_archived });
    }
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching conversation list' },
      message: `Discovered ${listMap.size.toLocaleString()} conversations` +
        (watermark ? ' (incremental)' : '') + (disc.trip ? ` — stopped: ${disc.trip}` : ''),
      count: listMap.size,
    });
    if (!disc.ok) {
      // Hard-stop discovery (429 / non-200 / non-JSON). If we got nothing and have no
      // checkpoint to fall back on, treat the list as unavailable (same as before).
      if (listMap.size === 0 && convMap.size === 0) listOk = false;
      if (disc.tripStatus === 429) telemetry.stoppedReason = 'discovery_rate_limited';
    }
  }

  if (!listOk) {
    // Nothing to work with at all.
    telemetry.stoppedReason = 'conversation_list_unavailable';
    const result = buildResult(requestedScopes, convMap, memories, telemetry);
    result.errors.push({ errorClass: 'upstream_error', reason: 'Could not load the conversation list.', disposition: 'fatal', phase: 'conversations' });
    await page.setData('result', result);
    await page.setData('status', 'Could not load conversation list — try again later.');
    return result;
  }

  // Determine the work set: conversations we don't have, or whose update_time changed.
  const work = [];
  for (const [id, listed] of listMap.entries()) {
    const have = convMap.get(id);
    if (!have || have.update_time !== listed.update_time) {
      work.push({ id, attempts: 0, listed });
    }
  }
  // v4: on an incremental (watermark) run, listMap holds only new/changed convs, so
  // the account total is at least what we already have checkpointed.
  telemetry.totalConversations = Math.max(listMap.size, convMap.size);

  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: work.length === 0
      ? `Up to date — ${convMap.size} conversations already saved`
      : `Downloading ${work.length} new/updated of ${telemetry.totalConversations} conversations...`,
    count: convMap.size,
  });

  // Persist memories + list snapshot early so even a list-only run checkpoints,
  // and so the next resume run can skip the full re-list.
  const listMetaPatch = { lastListAt: new Date().toISOString() };
  if (!usedCachedList && listMap.size > 0) {
    listMetaPatch.listSnapshot = Array.from(listMap.values()).map(i => ({ id: i.id, title: i.title, create_time: i.create_time, update_time: i.update_time }));
    listMetaPatch.listCachedAt = new Date().toISOString();
  }
  await ckptPutBatch([], memories, listMetaPatch).catch(() => {});

  // Step 3: Parallel, AIMD-throttled, resumable conversation download.
  const runStart = Date.now();
  const queue = work.slice();
  const skipped = new Set();        // conv ids dropped after a persistent 5xx (server-side broken)
  let parallelism = START_PARALLELISM;   // K = /conversations/batch POSTs in flight at once
  let paceMs = BASE_PACE_MS;             // light inter-wave pacing; AIMD shrinks toward 0
  let patientWaitMs = PATIENT_BACKOFF_START_MS;  // grows while throttled, resets on recovery
  let consecutiveRL = 0;           // throttled waves with ZERO success since the last progress
  let consecutiveHealthy = 0;      // fully-clean waves since the last K ramp
  let pendingBuffer = [];          // records to flush to the checkpoint
  let convsSinceFlush = 0;
  let lastFlush = Date.now();
  let rlDiagLogged = false;        // diagnostic: log the first 429's rate headers once

  // v4: checkpoint-only flush. Durability is the IndexedDB checkpoint (ckptPutBatch).
  // Shipped 3.x ALSO called page.setData('result', <the ENTIRE accumulator>) here
  // every 25 convs — re-serializing the whole growing result each time (~9.2GB of
  // JSON.stringify over a run for a 117MB export) and shipping it to a `connector-data`
  // event that has NO listener. We drop that flush-to-nowhere; the result is delivered
  // exactly once, at the end (the terminal page.setData('result', result)).
  const flush = async (force) => {
    if (pendingBuffer.length > 0) {
      const toWrite = pendingBuffer;
      pendingBuffer = [];
      await ckptPutBatch(toWrite, memories, null).catch(() => {});
    }
    if (force || convsSinceFlush >= FLUSH_EVERY_CONVS || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
      // Refresh telemetry counters for progress/diagnostics only — do NOT re-serialize
      // and ship the whole result here (that happens once at the end).
      telemetry.skipped = skipped.size;
      telemetry.pending = queue.length + work.filter(w => w.attempts >= MAX_ATTEMPTS && !convMap.has(w.id) && !skipped.has(w.id)).length;
      convsSinceFlush = 0;
      lastFlush = Date.now();
    }
  };

  while (queue.length > 0) {
    // One wave = up to K chunks of ≤ BATCH_MAX ids, fired as K PARALLEL POSTs. K
    // (parallelism) is the NEW concurrency dimension — real requests in flight, NOT
    // ids-per-POST — which is what breaks the shipped single-in-flight wall.
    const waveItems = queue.splice(0, parallelism * BATCH_MAX);
    const chunks = [];
    for (let i = 0; i < waveItems.length; i += BATCH_MAX) chunks.push(waveItems.slice(i, i + BATCH_MAX));
    const chunkResults = await Promise.all(
      chunks.map((chunk) => fetchConversationBatch(userToken, deviceId, chunk.map(s => s.id)))
    );

    // Merge per-id results; read wave-level throttle signals from each POST's meta.
    const byId = new Map();
    let shortBatch = false, sawRateLimit = false, sawOtherHttp = false, sawRetryAfter = false;
    let maxRetryAfter = 0;
    for (const cr of chunkResults) {
      for (const r of cr.items) byId.set(r.id, r);
      const m = cr.meta || {};
      if (m.status === 429) sawRateLimit = true;
      if (m.status && m.status !== 200 && m.status !== 429) sawOtherHttp = true;
      if (typeof m.retryAfter === 'number' && m.retryAfter > 0) { sawRetryAfter = true; maxRetryAfter = Math.max(maxRetryAfter, m.retryAfter); }
      // Short batch: server returned fewer conversations than requested on a 200.
      // Now that a healthy batch is exactly requested/requested, this is a reliable
      // throttle/challenge signal (an HTML challenge also lands here as 0/N).
      if (m.status === 200 && typeof m.batchReturned === 'number' && m.batchReturned < m.requested) shortBatch = true;
    }
    const throttled = sawRateLimit || sawOtherHttp || sawRetryAfter || shortBatch;

    let okInBatch = 0;
    let rlInBatch = 0;
    let rlDiagHeaders = null;

    for (const item of waveItems) {
      const r = byId.get(item.id) || { ok: false, status: 0 };
      bumpStatus(r.ok ? 200 : (r.status || 'no_status'));

      if (r.ok) {
        const record = toConversationRecord(item.listed, r);
        convMap.set(item.id, record);
        pendingBuffer.push(record);
        okInBatch++;
        telemetry.newlyFetched++;
        convsSinceFlush++;
      } else if (isAuthError(r.status)) {
        telemetry.authFailed = true;
      } else if (isRateLimited(r.status)) {
        rlInBatch++;
        if (typeof r.retryAfter === 'number') maxRetryAfter = Math.max(maxRetryAfter, r.retryAfter);
        if (!rlDiagHeaders && r.rl) rlDiagHeaders = r.rl;
        // Throttling isn't the item's fault — requeue without spending its retry
        // budget. The run-time/stall budgets below bound the patient waiting.
        queue.push(item);
      } else {
        // 5xx / network / timeout — retry with budget.
        item.attempts++;
        const isServerError = r.status >= 500 && r.status < 600;
        if (isServerError && item.attempts >= SERVER_ERROR_MAX_ATTEMPTS) {
          // Persistent server error: this conversation is broken server-side
          // (it 5xx's on both batch and the per-id fallback — and even on delete).
          // Skip it terminally so the run can COMPLETE instead of being stuck
          // "partial" forever. Recorded as skipped (telemetry), not silently lost.
          skipped.add(item.id);
        } else if (item.attempts < MAX_ATTEMPTS) {
          queue.push(item);
        }
        // else: exhausted network/timeout (status 0) — left out; a future run retries.
      }
    }

    await page.setProgress({
      phase: { step: 3, total: 3, label: 'Downloading conversations' },
      message: `Saved ${convMap.size}/${telemetry.totalConversations} conversations` +
        (throttled ? ` (easing off — throttled, K→1)` : ` (K=${parallelism})`),
      count: convMap.size,
    });

    // One-time diagnostic: only if OpenAI ever starts sending pacing hints
    // (today it sends none on these 429s, so this stays silent).
    if (rlInBatch > 0 && !rlDiagLogged && (maxRetryAfter > 0 || (rlDiagHeaders && Object.keys(rlDiagHeaders).length))) {
      rlDiagLogged = true;
      await page.setData('status', 'RL-DIAG retryAfter=' + maxRetryAfter + ' headers=' + JSON.stringify(rlDiagHeaders || {}));
    }

    // Stop immediately on auth expiry — token is dead, nothing more to do this run.
    if (telemetry.authFailed) {
      telemetry.stoppedReason = 'auth_expired';
      break;
    }

    if (okInBatch > 0 && !throttled) {
      // Fully-healthy wave. AIMD additive increase: after a couple of clean waves add
      // one parallel request; shrink the light inter-wave pace toward zero. NO fixed
      // floor (the old unconditional 700ms floor was half the ~30-min wall).
      consecutiveRL = 0;
      patientWaitMs = PATIENT_BACKOFF_START_MS;
      consecutiveHealthy++;
      if (consecutiveHealthy >= HEALTHY_WAVES_TO_RAMP && parallelism < MAX_PARALLELISM) {
        parallelism++;
        consecutiveHealthy = 0;
      }
      paceMs = clamp(Math.floor(paceMs / 2), 0, MAX_PACE_MS);
      await flush(false);
      if (paceMs > 0) await sleep(paceMs + jitter(100));
    } else if (throttled) {
      // Any throttle signal (429 / retry-after / short batch / non-200 / challenge).
      // AIMD multiplicative decrease: reset K=1 and back off, honoring retry-after.
      // A wave that still made progress resets the stall counter (we're moving).
      consecutiveHealthy = 0;
      parallelism = MIN_PARALLELISM;
      paceMs = BASE_PACE_MS;
      if (okInBatch > 0) { consecutiveRL = 0; patientWaitMs = PATIENT_BACKOFF_START_MS; }
      else consecutiveRL++;
      const waitMs = Math.max(maxRetryAfter * 1000, patientWaitMs);
      patientWaitMs = Math.min(Math.floor(patientWaitMs * 1.5), PATIENT_BACKOFF_MAX_MS);
      await flush(false);

      if (Date.now() - runStart >= MAX_RUN_MS) {
        telemetry.stoppedReason = 'run_time_budget';
        break;
      }
      if (consecutiveRL >= MAX_STALLED_BATCHES) {
        // The limit isn't clearing right now — defer the rest to the next run
        // (everything saved so far is checkpointed; nothing is lost or redone).
        telemetry.stoppedReason = 'rate_limited_no_recovery';
        break;
      }
      await page.setData('status',
        `Rate limited — easing off (K=1), waiting ${Math.round(waitMs / 1000)}s for the limit to clear ` +
        `(${convMap.size} saved, attempt ${consecutiveRL}/${MAX_STALLED_BATCHES})...`);
      await sleep(waitMs + jitter(1000));
    } else {
      // Transient errors only, no successes and no throttle — modest pause.
      await flush(false);
      await sleep(BASE_PACE_MS + jitter(250));
    }
  }

  // Final checkpoint write + classification.
  await flush(true);
  telemetry.skipped = skipped.size;
  // Skipped (persistently-broken 5xx) conversations are NOT counted as pending —
  // they're unfetchable by any means, so the run is as complete as it can be.
  telemetry.pending = Math.max(0, telemetry.totalConversations - convMap.size - skipped.size);

  // Mark a full sync complete only when nothing is outstanding.
  if (telemetry.pending === 0 && !telemetry.authFailed) {
    await ckptPutBatch([], memories, { fullSyncDone: true, lastFullSyncAt: new Date().toISOString() }).catch(() => {});
  }

  const result = buildResult(requestedScopes, convMap, memories, telemetry);

  state.isComplete = telemetry.pending === 0;
  await page.setData('result', result);

  const totalMessages = result.exportSummary.details.messages;
  const pendingSuffix = telemetry.pending > 0
    ? ` — ${telemetry.pending} still pending (will resume next run)`
    : (skipped.size > 0 ? ` — ${skipped.size} skipped (broken server-side)` : '');
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Downloading conversations' },
    message: `Saved ${convMap.size}/${telemetry.totalConversations} conversations${pendingSuffix}`,
    count: convMap.size,
  });
  await page.setData('status',
    `${telemetry.pending === 0 ? 'Complete' : 'Partial'}! ${result.exportSummary.details.memories} memories and ` +
    `${convMap.size} conversations (${totalMessages} messages) saved for ${state.email}${pendingSuffix}`
  );

  return result;
})();
