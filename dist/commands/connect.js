import { execSync } from "node:child_process";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { resolveProjectId } from "../lib/config.js";
import { info, isJSONMode, printJSON, isTTY } from "../lib/format.js";
const CLIENT_COMMANDS = {
    postgres: "psql",
    mysql: "mysql",
    mongodb: "mongosh",
    redis: "redis-cli",
};
export function registerConnect(program) {
    program
        .command("connect")
        .argument("[service]", "Service type or ID (postgres, redis, etc.)")
        .description("Connect to a managed service")
        .option("--url", "Print connection string without connecting")
        .action(async (service, opts) => {
        const projectId = resolveProjectId(program.opts().project);
        // Get addons
        const addons = await api.get(`/api/projects/${projectId}/addons`);
        if (addons.length === 0) {
            throw new Error("No managed services in this project. Use `lizard add`.");
        }
        let addon;
        if (service) {
            // Match by type or ID
            addon =
                addons.find((a) => a.addonType === service) ||
                    addons.find((a) => a.id === service) ||
                    addons.find((a) => a.name === service);
        }
        else if (addons.length === 1) {
            addon = addons[0];
        }
        else {
            if (!isTTY()) {
                throw new Error("Multiple services found. Specify one: " +
                    addons.map((a) => a.addonType || a.name).join(", "));
            }
            const selected = await p.select({
                message: "Select service to connect to",
                options: addons.map((a) => ({
                    value: a.id,
                    label: a.name || a.addonType,
                    hint: a.addonType,
                })),
            });
            if (p.isCancel(selected))
                process.exit(5);
            addon = addons.find((a) => a.id === selected);
        }
        if (!addon) {
            throw new Error(`Service "${service}" not found`);
        }
        if (addon.status !== "running") {
            throw new Error(`Service is ${addon.status}, not running`);
        }
        // Build connection string from secrets
        const secrets = await api.get(`/api/projects/${projectId}/secrets`);
        const connString = findConnectionString(addon.addonType, secrets);
        if (opts.url || isJSONMode()) {
            if (isJSONMode()) {
                printJSON({ type: addon.addonType, connectionString: connString });
            }
            else {
                console.log(connString || "Connection string not found in secrets");
            }
            return;
        }
        if (!connString) {
            throw new Error("Connection string not found in project secrets. Check `lizard secret list --show`.");
        }
        // Connect using native client
        const clientCmd = CLIENT_COMMANDS[addon.addonType];
        if (!clientCmd) {
            info(`Connection string: ${connString}`);
            return;
        }
        info(chalk.dim(`Connecting via ${clientCmd}...\n`));
        try {
            if (addon.addonType === "postgres") {
                execSync(`${clientCmd} "${connString}"`, { stdio: "inherit" });
            }
            else if (addon.addonType === "redis") {
                // redis-cli -u redis://...
                execSync(`${clientCmd} -u "${connString}"`, { stdio: "inherit" });
            }
            else if (addon.addonType === "mysql") {
                execSync(`${clientCmd} "${connString}"`, { stdio: "inherit" });
            }
            else if (addon.addonType === "mongodb") {
                execSync(`${clientCmd} "${connString}"`, { stdio: "inherit" });
            }
        }
        catch (err) {
            process.exit(err.status || 1);
        }
    });
}
function findConnectionString(type, secrets) {
    const envKeys = {
        postgres: ["DATABASE_URL", "POSTGRES_URL", "PG_URL"],
        mysql: ["MYSQL_URL", "DATABASE_URL"],
        mongodb: ["MONGODB_URL", "MONGO_URL"],
        redis: ["REDIS_URL"],
    };
    const keys = envKeys[type] || [];
    for (const key of keys) {
        const s = secrets.find((s) => s.key === key);
        if (s)
            return s.value;
    }
    return null;
}
//# sourceMappingURL=connect.js.map