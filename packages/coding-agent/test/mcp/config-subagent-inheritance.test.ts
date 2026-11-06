import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { addMCPServer, getMCPServer, updateMCPServer } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils/dirs";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };
import { restoreEnvValue } from "../helpers/settings-test-state";

let root = "";
let cwd = "";
let originalAgentDir = "";
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-child-policy-"));
	cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	originalAgentDir = getAgentDir();
	originalEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
	};
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	__resetDirsFromEnvForTests();
	setAgentDir(path.join(root, "agent"));
	vi.spyOn(os, "homedir").mockReturnValue(root);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	for (const [key, value] of Object.entries(originalEnv)) restoreEnvValue(key, value);
	__resetDirsFromEnvForTests();
	clearFsCache();
	await removeWithRetries(root);
});

for (const [provider, relativePath] of [
	["native", ".omp/mcp.json"],
	["standalone", ".mcp.json"],
	["plugin", "plugin/mcp.json"],
	["user", "../agent/mcp.json"],
] as const) {
	test(provider + " config retains parent access, filters child discovery, and rejects malformed inheritance policy", async () => {
		await Bun.write(
			path.join(cwd, relativePath),
			JSON.stringify({
				mcpServers: {
					hidden: { command: "fixture", args: ["hidden"], inheritInSubagents: false },
					retained: { command: "fixture", args: ["retained"], inheritInSubagents: true },
					defaulted: { command: "fixture", args: ["defaulted"] },
					invalid: { command: "fixture", args: ["invalid"], inheritInSubagents: "false" },
					nullable: { command: "fixture", args: ["nullable"], inheritInSubagents: null },
				},
			}),
		);
		const options: LoadMCPConfigsOptions = {
			extensionRoots: {
				explicit: provider === "plugin" ? [path.join(cwd, "plugin")] : [],
				mode: "explicit-only",
				configured: [],
				configuredLevel: "project",
			},
		};
		const parent = await loadAllMCPConfigs(cwd, options);
		expect(Object.keys(parent.configs).sort()).toEqual(["defaulted", "hidden", "retained"]);
		const child = await loadAllMCPConfigs(cwd, { ...options, forSubagent: true });
		expect(Object.keys(child.configs).sort()).toEqual(["defaulted", "retained"]);
	});
}

test("native writes preserve child exclusion through auth updates and reject malformed changes", async () => {
	const file = path.join(cwd, ".omp", "mcp.json");
	await addMCPServer(file, "private", { type: "http", url: "https://example.com/mcp", inheritInSubagents: false });
	const saved = (await getMCPServer(file, "private"))!;
	await updateMCPServer(file, "private", { ...saved, auth: { type: "oauth", credentialId: "fixture" } });
	clearFsCache();
	expect(Object.keys((await loadAllMCPConfigs(cwd)).configs)).toEqual(["private"]);
	expect(Object.keys((await loadAllMCPConfigs(cwd, { forSubagent: true })).configs)).toEqual([]);
	await expect(
		updateMCPServer(file, "private", { ...saved, inheritInSubagents: "false" } as unknown as MCPServerConfig),
	).rejects.toThrow();
	expect((await getMCPServer(file, "private"))?.inheritInSubagents).toBe(false);
});

test("an excluded project entry keeps its name instead of falling through to a same-name user server", async () => {
	await Bun.write(path.join(root, "agent", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "user-fixture" } } }));
	await Bun.write(path.join(cwd, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "project-fixture", inheritInSubagents: false } } }));
	const parent = await loadAllMCPConfigs(cwd);
	expect(parent.configs.shared).toMatchObject({ command: "project-fixture", inheritInSubagents: false });
	const child = await loadAllMCPConfigs(cwd, { forSubagent: true });
	expect(Object.keys(child.configs)).toEqual([]);
});

for (const server of [
	{ type: "stdio", command: "fixture" },
	{ type: "http", url: "https://example.com/mcp" },
	{ type: "sse", url: "https://example.com/sse" },
]) {
	test(server.type + " schema accepts child opt-out and rejects non-boolean policy", () => {
		expect(
			validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, inheritInSubagents: false } } }).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(mcpSchema, { mcpServers: { fixture: { ...server, inheritInSubagents: "false" } } }).success,
		).toBe(false);
	});
}
