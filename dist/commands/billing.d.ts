import { Command } from "commander";
/** Old prepaid credits (`plan: "payg"`) keep working until this date. */
export declare const CREDITS_END = "November 1, 2026";
export declare function billingUrl(): string;
export interface Subscription {
    plan: "none" | "pro" | "payg" | "enterprise" | string;
    status: "none" | "trialing" | "active" | "past_due" | "canceled" | string;
    isOwner?: boolean;
    priceCents: number;
    taxIncluded: boolean;
    includedCents: number;
    trial: {
        eligible: boolean;
        days: number | null;
        creditCents: number | null;
        promoCode: string | null;
        endsAt: number | null;
        usedCents: number | null;
        remainingCents: number | null;
    };
    period: {
        kind: "trial" | "paid";
        start: number;
        end: number;
        includedCents: number;
        usedCents: number;
        overageCents: number;
        billedOverageCents: number;
        unbilledOverageCents: number;
        nextOverageChargeAtCents: number | null;
    } | null;
    nextCharge: {
        at: number | null;
        amountCents: number;
    } | null;
    cancelAt: number | null;
    pastDue: boolean;
    openInvoiceUrl: string | null;
    paymentMethod: {
        brand: string;
        last4: string;
        expMonth: number;
        expYear: number;
    } | null;
    limits: {
        tier: string;
        replicasPerApp: number;
    } | null;
    checkoutAvailable: boolean;
}
/** New servers add the trial fields; older ones send only the first four. */
export interface PromoResult {
    status: string;
    code?: string;
    creditCents: number;
    expiresAt: number | null;
    balanceCents: number;
    trialDays?: number | null;
    trialCreditCents?: number | null;
    appliesTo?: "next_checkout" | "current_trial";
}
/** $19, $4.10: whole dollars without cents. */
export declare function usd(cents: number): string;
export declare function daysLeft(endMs: number, now?: number): string;
/** Lines that describe a plan, for people. Pure, so the tests can read it. */
export declare function describeSubscription(sub: Subscription, now?: number): string[];
/** One line for a redeemed promo code. Works with servers before and after Pro. */
export declare function describePromo(out: PromoResult): string;
export declare function registerBilling(program: Command): void;
