export interface AppSnapshot {
    status?: string;
    deployStatus?: string | null;
    restartedAt?: number | string | null;
    domain?: string;
    containerPort?: number;
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
export declare function waitForAppReady(id: string, baselineRestartedAt: number | string | null | undefined, opts?: {
    timeoutMs?: number;
    healthCheck?: boolean;
}): Promise<WaitResult>;
