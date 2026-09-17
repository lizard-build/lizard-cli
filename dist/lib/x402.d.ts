import type { PaymentRequired } from '@x402/core/types';
export interface X402Quote {
    creditCents: number;
    feeCents: number;
    totalCents: number;
    network: string;
    asset: string;
    payTo: string;
}
export interface X402Result extends X402Quote {
    requestId: string;
    attemptId: string;
    status: string;
    transaction?: string | null;
    paymentIntentId?: string | null;
}
export declare function dollarsToCents(value: string): number;
export declare function paymentOrigin(): string;
export declare function validateQuote(q: X402Quote, creditCents: number, maxTotalCents?: number): void;
export declare function getX402Quote(creditCents: number): Promise<X402Quote>;
export declare function validateChallenge(value: PaymentRequired, q: X402Quote, origin: string): void;
export declare function payX402(creditCents: number, maxTotalCents: number, expected: X402Quote, requestId?: string): Promise<X402Result>;
export declare function getX402Status(attemptId: string): Promise<X402Result>;
