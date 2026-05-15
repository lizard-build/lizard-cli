export declare const NAME_REGEX: RegExp;
export declare const NAME_VALIDATION_HINT = "1\u201340 chars, lowercase a\u2013z, digits, hyphens; can't start or end with a hyphen";
export declare function validateName(name: string): string | null;
