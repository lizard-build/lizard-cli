import { Command } from "commander";
import { type Subscription } from "./billing.js";
export type AccountState = "unknown" | "not_owner" | "enterprise" | "credits" | "past_due" | "trialing" | "active" | "trial_available" | "subscription_required" | "checkout_unavailable";
/** What the account still needs, from `GET /api/billing/subscription` (null when it could not be read). */
export declare function accountState(sub: Subscription | null): AccountState;
/** What an agent should do about the plan. Spells out the don'ts, since an agent takes a link as a hint to open it. */
export declare function accountInstruction(state: AccountState, sub: Subscription | null, now?: number): string;
/** Commands an agent can run next. */
export declare function nextSteps(linked: boolean): Array<{
    command: string;
    why: string;
}>;
export declare function registerLogin(program: Command): void;
