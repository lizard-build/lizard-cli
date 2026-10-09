import { Command } from "commander";
import { type Subscription } from "./billing.js";
export type AccountState = "unknown" | "not_owner" | "enterprise" | "credits" | "past_due" | "trialing" | "active" | "trial_available" | "subscription_required" | "checkout_unavailable";
/** What the account still needs, from `GET /api/billing/subscription` (null when it could not be read). */
export declare function accountState(sub: Subscription | null): AccountState;
/** What an agent should do about the plan. Spells out the don'ts, since an agent takes a link as a hint to open it. */
export declare function accountInstruction(state: AccountState, sub: Subscription | null, now?: number): string;
/** Commands an agent can run next. Sandboxes first; both they and deploys live in a project. */
export declare function nextSteps(linked: boolean): Array<{
    command: string;
    why: string;
}>;
/** The same steps for a person, as aligned lines for the closing note. */
export declare function nextStepsNote(linked: boolean): string;
/**
 * The token piped into `--token-stdin`. A token in `--token` shows up in the
 * process list and the shell history; one on stdin does not. A terminal on
 * stdin would sit waiting for an end-of-file nobody knows to type, so refuse.
 */
export declare function readTokenFromStdin(stdin?: NodeJS.ReadableStream & {
    isTTY?: boolean;
}): Promise<string>;
export declare function registerLogin(program: Command): void;
