import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { api } from "../lib/api.js";
import { findProjectConfig, saveProjectConfig, } from "../lib/config.js";
import { success, info, isJSONMode, printJSON, isTTY, } from "../lib/format.js";
/** Detect framework from files in cwd */
function detectFramework() {
    const cwd = process.cwd();
    const has = (f) => fs.existsSync(path.join(cwd, f));
    if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts"))
        return { name: "Next.js", port: 3000, buildCmd: "npm run build", startCmd: "npm start" };
    if (has("nuxt.config.ts") || has("nuxt.config.js"))
        return { name: "Nuxt", port: 3000, buildCmd: "npm run build", startCmd: "npm start" };
    if (has("remix.config.js") || has("remix.config.ts"))
        return { name: "Remix", port: 3000, buildCmd: "npm run build", startCmd: "npm start" };
    if (has("astro.config.mjs") || has("astro.config.ts"))
        return { name: "Astro", port: 4321, buildCmd: "npm run build", startCmd: "npm start" };
    if (has("vite.config.ts") || has("vite.config.js"))
        return { name: "Vite", port: 3000, buildCmd: "npm run build", startCmd: "npm run preview" };
    if (has("Dockerfile"))
        return { name: "Docker", port: 8080, buildCmd: "", startCmd: "" };
    if (has("go.mod"))
        return { name: "Go", port: 8080, buildCmd: "go build -o app .", startCmd: "./app" };
    if (has("requirements.txt") || has("pyproject.toml"))
        return { name: "Python", port: 8000, buildCmd: "pip install -r requirements.txt", startCmd: "python app.py" };
    if (has("package.json"))
        return { name: "Node.js", port: 3000, buildCmd: "npm run build", startCmd: "npm start" };
    return null;
}
function writeLizardToml(framework) {
    const port = framework?.port ?? 3000;
    const build = framework?.buildCmd ?? "";
    const start = framework?.startCmd ?? "";
    let toml = `# lizard.toml\n\n`;
    if (build)
        toml += `[build]\ncommand = "${build}"\n\n`;
    toml += `[deploy]\nport = ${port}\n`;
    if (start)
        toml += `start_command = "${start}"\n`;
    toml += `\n[resources]\ncpu = 1\nmemory = 512\n`;
    const tomlPath = path.join(process.cwd(), "lizard.toml");
    if (!fs.existsSync(tomlPath)) {
        fs.writeFileSync(tomlPath, toml);
    }
}
export function registerInit(program) {
    program
        .command("init")
        .description("Create a new project and link current directory")
        .option("--name <name>", "Project name")
        .action(async (opts) => {
        // Check if already initialized
        const existing = findProjectConfig();
        if (existing) {
            throw new Error("Already initialized. Run `lizard link` to change project.");
        }
        // Detect framework
        const framework = detectFramework();
        if (framework && !isJSONMode()) {
            info(`Detected framework: ${chalk.cyan(framework.name)}`);
        }
        // Get project name
        let projectName = opts.name;
        if (!projectName) {
            if (!isTTY()) {
                throw new Error("--name is required in non-interactive mode");
            }
            const result = await p.text({
                message: "Project name",
                defaultValue: path.basename(process.cwd()),
                placeholder: path.basename(process.cwd()),
            });
            if (p.isCancel(result))
                process.exit(5);
            projectName = result;
        }
        // Create project via API
        const project = await api.post("/api/projects", {
            name: projectName,
        });
        // Save local config
        saveProjectConfig({
            projectId: project.id,
            projectName: project.name,
        });
        // Write lizard.toml
        writeLizardToml(framework);
        if (isJSONMode()) {
            printJSON({
                projectId: project.id,
                name: project.name,
                framework: framework?.name,
            });
        }
        else {
            success(`Project "${chalk.bold(project.name)}" created`);
            info(chalk.dim("  Linked to current directory"));
            info(chalk.dim("  Config saved to .lizard/config.json"));
            if (framework) {
                info(chalk.dim(`  lizard.toml created for ${framework.name}`));
            }
        }
    });
}
//# sourceMappingURL=init.js.map