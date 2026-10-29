// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only control interface. Not imported by build.mjs or wrangler.toml.
import worker, { PublisherState as ProductionState } from "../worker.mjs";
export default worker;

// Keep automatic alarms from racing tests that deliberately step the handler.
// The production-bundle test separately exercises the real automatic alarm.
function manualAlarmStorage(storage) {
  return new Proxy(storage, {
    get(target, key) {
      if (key === "transaction")
        return (callback) =>
          target.transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(transaction, name) {
                  if (name === "setAlarm") return () => transaction.setAlarm(Date.now() + 3_600_000);
                  const value = transaction[name];
                  return typeof value === "function" ? value.bind(transaction) : value;
                },
              }),
            ),
          );
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export class PublisherState extends ProductionState {
  constructor(ctx, env) {
    super({ storage: manualAlarmStorage(ctx.storage) }, env);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (this.env.TEST_DO_FAILURE === "1") throw new Error("injected backend failure");
    if (path === "/__inspect")
      return Response.json({
        state: await this.ctx.storage.get("state"),
        alarm: await this.ctx.storage.getAlarm(),
      });
    if (path === "/__alarm") {
      await this.alarm();
      return new Response("ok");
    }
    return super.fetch(request);
  }
}
