// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { configuration, HttpError } from "./config.mjs";
import { verifyGitHub } from "./auth.mjs";
import { atom, boundedJSON, readyRecord } from "./catalog.mjs";

// Tests inject trust roots through an emulator outbound HTTP handler for the
// pinned GitHub JWKS URL. Production has no trust-root or verifier override.
export default {
  async fetch(request, env) {
    try {
      const config = configuration(env),
        url = new URL(request.url);
      if (url.origin !== new URL(config.topic).origin) return new Response("not found", { status: 404 });
      const stub = env.PUBLISHER.get(env.PUBLISHER.idFromName("catalog"));
      if (url.pathname === "/topic" && request.method === "GET")
        return await stub.fetch("https://state/topic");
      if (url.pathname !== "/ready" || request.method !== "POST")
        return new Response("not found", { status: 404 });
      const auth = request.headers.get("authorization");
      if (!auth?.startsWith("Bearer ")) throw new HttpError(401, "GitHub identity required");
      const identity = await verifyGitHub(auth.slice(7), config.audience);
      const record = readyRecord(await boundedJSON(request));
      return await stub.fetch("https://state/ready", {
        method: "POST",
        body: JSON.stringify({ record, identity }),
      });
    } catch (e) {
      return new Response(e instanceof HttpError ? e.message : "publisher unavailable", {
        status: e instanceof HttpError ? e.status : 503,
      });
    }
  },
};

export class PublisherState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const config = configuration(this.env),
      path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/topic") {
      const state = await this.ctx.storage.get("state");
      return new Response(atom(state?.record, config), {
        headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST" || path !== "/ready") return new Response("not found", { status: 404 });
    const { record: input, identity } = await request.json();
    const record = readyRecord(input);
    const result = await this.ctx.storage.transaction(async (tx) => {
      const prior = await tx.get("state");
      const seen = await tx.get(`digest:${record.digest}`);
      // A digest has immutable metadata. Duplicate declarations preserve pending work.
      if (seen && JSON.stringify(seen) !== JSON.stringify(record))
        return { status: 409, error: "digest metadata collision" };
      if (prior) {
        const old = prior.identity;
        if (identity.run === old.run && identity.runId !== old.runId)
          return { status: 409, error: "run identity collision" };
        if (identity.run < old.run || (identity.run === old.run && identity.attempt < old.attempt))
          return { status: 409, error: "stale run" };
        if (
          identity.run === old.run &&
          identity.attempt === old.attempt &&
          prior.record.digest !== record.digest
        )
          return { status: 409, error: "run declaration collision" };
      }
      if (seen) {
        if (prior.record.digest !== record.digest) return { status: 409, error: "obsolete digest" };
        // A newer run declaring the unchanged catalog still advances the fence.
        prior.identity = identity;
        await tx.put("state", prior);
        return { status: 200, duplicate: true };
      }
      const state = { record, identity, pending: true, attempts: 0 };
      await tx.put("state", state);
      await tx.put(`digest:${record.digest}`, record);
      // Alarm and work are committed in the SAME storage transaction. A crash
      // cannot acknowledge a declaration without leaving a wakeup behind.
      await tx.setAlarm(Date.now());
      return { status: 202, accepted: true };
    });
    return Response.json(result, { status: result.status });
  }
  async alarm() {
    const snapshot = await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get("state");
      if (!state?.pending) return null;
      state.attempts += 1;
      const delay = Math.min(3_600_000, 1000 * 2 ** Math.min(state.attempts, 12));
      await tx.put("state", state);
      // Pre-arm before network I/O. Forced restart after hub acceptance causes
      // a harmless duplicate publish rather than a permanently stranded item.
      await tx.setAlarm(Date.now() + delay);
      return state;
    });
    if (!snapshot) return;
    let failureCode = "configuration";
    try {
      // A broken redeployment must not strand already accepted work after the
      // platform's finite automatic alarm retries. The next alarm is pre-armed.
      const config = configuration(this.env);
      failureCode = "hub_transport";
      const response = await fetch(config.hub, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "hub.mode": "publish", "hub.url": config.topic }),
      });
      // WebSub publish success is 2xx. It is hub acceptance, not subscriber receipt.
      await response.body?.cancel();
      if (!response.ok) {
        failureCode = `hub_http_${response.status}`;
        throw new Error("hub rejected publish");
      }
      failureCode = "completion_storage";
      await this.ctx.storage.transaction(async (tx) => {
        const state = await tx.get("state");
        if (state?.record.digest !== snapshot.record.digest || state.attempts !== snapshot.attempts) return;
        state.pending = false;
        delete state.lastError;
        await tx.put("state", state);
        await tx.deleteAlarm();
      });
    } catch {
      await this.ctx.storage.transaction(async (tx) => {
        const state = await tx.get("state");
        if (state?.record.digest === snapshot.record.digest && state.attempts === snapshot.attempts) {
          state.lastError = failureCode;
          await tx.put("state", state);
        }
      });
      console.error(`catalog hub publish failed (${failureCode}); durable retry scheduled`);
    }
  }
}
