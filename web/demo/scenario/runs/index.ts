// The four synthetic review runs of the online demo (README.md "Runs"), built once when the run mock installs.
// Ids are fixed so that links such as #/runs/r-20261114-3c9e51 work in every build; times of the three unfinished runs
// are computed from `now` so that elapsed times and gate waits stay plausible.
import { BLOG_RUN_ID, buildBlogRun } from './blog-storage';
import { buildLogRun, LOG_RUN_ID } from './log-pipeline';
import { buildSyncRun, SYNC_RUN_ID } from './offline-sync';
import { buildPaymentRun, PAYMENT_RUN_ID } from './payment-idempotency';
import type { RunBundle } from './common';

export type { RunBundle } from './common';

/** Run ids by state, for the verifier and other demo modules. */
export const DEMO_RUN_IDS = { completed: BLOG_RUN_ID, waiting: SYNC_RUN_ID, blocked: PAYMENT_RUN_ID, running: LOG_RUN_ID } as const;

export function buildRunBundles(now: number): RunBundle[] {
  return [buildLogRun(now), buildSyncRun(now), buildPaymentRun(now), buildBlogRun()];
}
