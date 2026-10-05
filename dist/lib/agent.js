// Which coding agent, if any, is running this CLI.
//
// Sent to the platform as X-Lizard-Agent so product analytics can tell a
// deploy an agent shipped from one a person typed. Read from environment
// variables the agents set for the commands they run; nothing is sent when
// none of them is present.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
function slug(raw) {
    const v = raw.trim().toLowerCase().replace(/\s+/g, "-");
    return SLUG_RE.test(v) ? v : null;
}
export function detectAgent(env = process.env) {
    // Explicit, for harnesses this list does not know.
    if (env.LIZARD_AGENT)
        return slug(env.LIZARD_AGENT);
    if (env.AI_AGENT)
        return slug(env.AI_AGENT);
    if (env.CLAUDECODE === "1")
        return "claude-code";
    if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED)
        return "codex";
    if (env.GEMINI_CLI === "1")
        return "gemini-cli";
    if (env.CURSOR_AGENT === "1")
        return "cursor";
    // Cursor's integrated terminal, which a person may be typing in too.
    if (env.CURSOR_TRACE_ID)
        return "cursor-terminal";
    if (env.REPL_ID)
        return "replit";
    if (env.GITHUB_ACTIONS === "true")
        return "github-actions";
    if (env.CI)
        return "ci";
    return null;
}
//# sourceMappingURL=agent.js.map