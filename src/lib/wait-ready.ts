import { api } from "./api.js";

export interface AppSnapshot {
  status?: string;
  deployStatus?: string | null;
  restartedAt?: number | string | null;
  domain?: string;
}

export interface WaitResult {
  ok: boolean;
  /** "running" on success; "failed" | "crashed" on a reported failure; "timeout" if the
   *  wait ran out before a terminal state for this attempt was reached. */
  status: string;
  /** Identifies the specific restart/deploy attempt that was waited on (the app's
   *  restartedAt value once it changed from the pre-trigger baseline) — an old,
   *  already-`running` read from before the trigger is never mistaken for success. */
  attemptId: number | string | null;
  domain?: string;
  waitedMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Two consecutive successful checks, spaced apart, against the app's own domain.
 * A single 200 isn't enough during a restart handover — LIZARD-174's reproduction
 * found one healthy response immediately followed by a 502 while the old process
 * was still finishing its shutdown. Not run for apps with no domain (workers) —
 * platform-reported readiness is the only signal available for those.
 */
async function debounceHealthCheck(domain: string): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`https://${domain}/`, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 500) return false;
    } catch {
      return false;
    }
    if (i === 0) await sleep(1500);
  }
  return true;
}

/**
 * Waits for a *specific* restart/deploy attempt to become ready, distinguishing
 * it from the app simply already being `running` from before the attempt was
 * triggered — the exact gap LIZARD-174 reports: `lizard restart --json` returned
 * as soon as the restart was accepted, and the very next request could still hit
 * the outgoing old process (200) or a mid-handover 502/503.
 *
 * `baselineRestartedAt` must be captured from GET /api/apps/:id *before* the
 * restart call is made — readiness is only trusted once `restartedAt` has moved
 * past that baseline, so an unrelated, still-`running` read from the old attempt
 * never short-circuits the wait. Pass `undefined` (not `null`) for callers whose
 * trigger doesn't touch restartedAt at all (e.g. redeploy, which is tracked by
 * its own buildId instead) — this skips the restartedAt gate entirely and trusts
 * deployStatus/status transitions directly, since deployStatus is flipped to
 * building/deploying synchronously by those triggers.
 */
export async function waitForAppReady(
  id: string,
  baselineRestartedAt: number | string | null | undefined,
  opts: { timeoutMs?: number; healthCheck?: boolean } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const healthCheck = opts.healthCheck ?? true;
  const start = Date.now();

  let attemptId: number | string | null = null;
  let sawNewAttempt = baselineRestartedAt === undefined;

  while (Date.now() - start < timeoutMs) {
    let app: AppSnapshot;
    try {
      app = await api.get<AppSnapshot>(`/api/apps/${id}`);
    } catch {
      await sleep(1500);
      continue;
    }

    if (!sawNewAttempt) {
      const restartedAt = app.restartedAt ?? null;
      if (restartedAt !== null && restartedAt !== baselineRestartedAt) {
        sawNewAttempt = true;
        attemptId = restartedAt;
      } else {
        // The platform hasn't picked up this attempt yet — deployStatus/status
        // here still describe whatever was true *before* it was triggered.
        // Reporting "running" at this point would be exactly the false
        // positive this function exists to prevent.
        await sleep(1000);
        continue;
      }
    } else if (app.restartedAt != null && app.restartedAt !== attemptId) {
      // A newer attempt interleaved (e.g. someone else restarted it again)
      // — track that one instead; it's the one that will actually land.
      attemptId = app.restartedAt;
    }

    if (app.deployStatus === "restarting" || app.deployStatus === "building" || app.deployStatus === "deploying") {
      await sleep(1000);
      continue;
    }
    if (app.status === "failed" || app.status === "crashed") {
      return { ok: false, status: app.status, attemptId, domain: app.domain, waitedMs: Date.now() - start };
    }
    if (app.status === "running") {
      if (healthCheck && app.domain) {
        const healthy = await debounceHealthCheck(app.domain);
        if (!healthy) {
          // Platform says running, but the URL isn't consistently healthy yet
          // (mid-handover) — keep polling rather than declaring success early.
          await sleep(1500);
          continue;
        }
      }
      return { ok: true, status: "running", attemptId, domain: app.domain, waitedMs: Date.now() - start };
    }

    await sleep(1000);
  }

  return { ok: false, status: "timeout", attemptId, waitedMs: Date.now() - start };
}
