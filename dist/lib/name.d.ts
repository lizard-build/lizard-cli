export declare const NAME_REGEX: RegExp;
export declare const NAME_VALIDATION_HINT = "1\u201340 chars, lowercase a\u2013z, digits, hyphens; can't start or end with a hyphen";
export declare function validateName(name: string): string | null;
/** Mirrors `slugifyName` in lizard-client/src/lib/api.ts. */
export declare function slugifyName(name: string): string;
/** Mirrors `addonRefName` in lizard-client — what users type inside ${{...}}. */
export declare function addonRefName(addon: {
    name?: string | null;
    type?: string;
    addonType?: string;
}): string;
