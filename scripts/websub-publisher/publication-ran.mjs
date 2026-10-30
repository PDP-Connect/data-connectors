#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const name = "Publish and verify the connector catalog";
const terminal = new Set(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped", "stale", "startup_failure"]);

// An unsuccessful attempt may already have moved latest before its response was lost.
export function publicationRan(pages) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.jobs)))
    throw new Error("invalid workflow job response");
  const jobs = pages.flatMap((page) => page.jobs).filter((job) => job?.name === name);
  if (jobs.length !== 1 || jobs[0].status !== "completed" || !terminal.has(jobs[0].conclusion))
    throw new Error("catalog job is missing, ambiguous or unfinished");
  if (jobs[0].conclusion === "skipped") return false;
  if (!Array.isArray(jobs[0].steps)) throw new Error("catalog job has no steps");
  const steps = jobs[0].steps.filter((step) => step?.name === name);
  if (steps.length !== 1 || steps[0].status !== "completed" || !terminal.has(steps[0].conclusion))
    throw new Error("catalog publication step is missing, ambiguous or unfinished");
  return steps[0].conclusion !== "skipped";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: publication-ran.mjs JOBS_JSON");
    console.log(publicationRan(JSON.parse(await readFile(process.argv[2], "utf8"))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
