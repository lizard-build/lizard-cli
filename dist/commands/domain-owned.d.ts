import { Command } from "commander";
/**
 * Domains bought on Lizard (lizard.build/domains): `lizard domain owned` lists them,
 * `lizard domain dns <domain>` reads and edits their DNS records, and `lizard domain
 * <hostname>` on one of them (or a subdomain) sets the DNS itself instead of printing
 * records to add. These endpoints take a login or an unscoped API key, never a scoped one.
 */
export interface OwnedDomain {
    id: string;
    domain: string;
    status: string;
    appId: string | null;
    expiresAt: number | null;
}
type DnsType = "A" | "AAAA" | "CNAME" | "ALIAS" | "MX" | "TXT" | "URL301";
/** The bought domain `hostname` is, or is a subdomain of; null when none (or the
 *  token cannot see bought domains, e.g. an API key). */
export declare function findOwnedDomain(hostname: string): Promise<OwnedDomain | null>;
/** Points `hostname` (the bought domain, or a subdomain of it) at a service: DNS and attach in one call. */
export declare function connectOwned(order: OwnedDomain, hostname: string, service: {
    id: string;
    name: string;
}): Promise<void>;
/** "@", "api", or "api.example.com" -> the name relative to the domain. */
export declare function relativeName(name: string, domain: string): string;
export declare function parseType(raw: string): DnsType;
export declare function registerOwnedDomainCommands(dom: Command): void;
export {};
