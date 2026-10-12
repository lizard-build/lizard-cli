/** Top-level commands whose work the `sandbox` skill covers; everything else is in `core` (deploys). */
const SANDBOX_COMMANDS = new Set(["sandbox", "volume", "agents"]);
/** Which embedded skill an agent should read for a top-level command. */
export function skillFor(topLevel) {
    return SANDBOX_COMMANDS.has(topLevel) ? "sandbox" : "core";
}
//# sourceMappingURL=skill-route.js.map