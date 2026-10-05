import { Command } from "commander";
export declare function registerMetrics(program: Command): void;
/** This month's Pro credits for the workspace owner's account; null for other plans. */
interface ProCredits {
    status: string;
    kind: "trial" | "paid";
    periodStart: number;
    periodEnd: number;
    includedCents: number;
    usedCents: number;
    overageCents: number;
}
/** "$4.10 of $19 in monthly credits used, overage $0" — the account-wide line for Pro. */
export declare function proCreditsLine(pro: ProCredits): string;
export {};
