// Shared name validator. Mirrors server/src/services/var-transform.ts.
// LIZARD-55: 1–40 chars, [a-z0-9-], must start and end with [a-z0-9].
export const NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const NAME_VALIDATION_HINT = "1–40 chars, lowercase a–z, digits, hyphens; can't start or end with a hyphen";
export function validateName(name) {
    if (!name)
        return "name is required";
    if (name.length > 40)
        return "name must be 40 characters or fewer";
    if (!NAME_REGEX.test(name))
        return `invalid name (${NAME_VALIDATION_HINT})`;
    return null;
}
//# sourceMappingURL=name.js.map