import { once } from "node:events";
import * as readline from "node:readline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { CustomToolAdapter } from "../../src/extensibility/custom-tools/wrapper";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { connectToServer } from "../../src/mcp/client";
import { loadAllMCPConfigs } from "../../src/mcp/config";
import { MCPManager } from "../../src/mcp/manager";
import { getOwnerConfigs } from "../../src/mcp/owner-channel";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

const raw = process.argv.includes("--raw");
const manager = new MCPManager(process.cwd());
MCPManager.setInstance(manager);
const pending = new Map<number, (value: unknown) => void>();
let rawRevoked = false;
if (raw)
	process.on("message", (value: unknown) => {
		const message = value as { ompMcpOwner?: number; id?: number; op?: string };
		if (message.ompMcpOwner === 1 && message.id !== undefined) pending.get(message.id)?.(value);
		if (message.ompMcpOwner === 1 && message.op === "revoke") {
			rawRevoked = true;
			for (const resolve of pending.values()) resolve({ error: "Owner channel revoked" });
			pending.clear();
		}
	});
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
	const command = JSON.parse(line) as {
		id: number;
		op: string;
		server?: string;
		uri?: string;
		child?: boolean;
		args?: Record<string, unknown>;
		message?: Record<string, unknown>;
	};
	void run(command).then(
		result => emit({ id: command.id, result }),
		error => emit({ id: command.id, error: String(error) }),
	);
});
input.on("close", () => {
	void manager.disconnectAll().finally(() => process.exit(0));
});
emit({ ready: true, pid: process.pid, ppid: process.ppid });

function emit(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(command: {
	id: number;
	op: string;
	server?: string;
	uri?: string;
	child?: boolean;
	args?: Record<string, unknown>;
	message?: Record<string, unknown>;
}): Promise<unknown> {
	switch (command.op) {
		case "catalog":
			return getOwnerConfigs(command.child);
		case "discover":
			return (await loadAllMCPConfigs(process.cwd(), { forSubagent: command.child })).configs;
		case "directOwner": {
			const connection = await connectToServer("protected", { type: "owner", server: "protected" });
			try {
				return await connection.transport.request("tools/list");
			} finally {
				await connection.transport.close();
			}
		}
		case "disconnect": {
			const disconnected = once(process, "disconnect");
			process.disconnect!();
			await disconnected;
			return { disconnected: true };
		}
		case "connect": {
			const { configs, sources } = await loadAllMCPConfigs(process.cwd());
			const selected = command.server ? { [command.server]: configs[command.server] } : configs;
			await manager.connectServers(selected, sources);
			await manager.waitForPendingConnections();
			return {
				servers: manager.getConnectedServers(),
				tools: manager.getTools().map(tool => ({ name: tool.name, server: tool.mcpServerName })),
				childTools: manager.getTools(true).map(tool => tool.mcpServerName),
			};
		}
		case "snapshot":
			return {
				servers: manager.getConnectedServers(),
				tools: manager.getTools().map(tool => tool.mcpServerName),
				resources: manager.getServerResources("protected"),
				instructions: Object.fromEntries(manager.getServerInstructions()),
				catalog: await getOwnerConfigs(),
			};
		case "tool": {
			const tool = manager.getTools(command.child).find(tool => tool.mcpServerName === command.server);
			if (!tool) throw new Error("No admitted tool for server");
			return tool.execute(`fixture-${command.id}`, command.args ?? {}, undefined, {} as CustomToolContext);
		}
		case "evalTool": {
			const tool = manager.getTools(command.child).find(tool => tool.mcpServerName === command.server);
			if (!tool) throw new Error("No admitted tool for Eval bridge");
			const adapted = new CustomToolAdapter(tool, () => ({}) as CustomToolContext);
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableMCP: true,
				mcpManager: manager,
				skills: [],
				taskDepth: command.child ? 1 : 0,
				getToolForEvalBridge: name => (name === adapted.name ? adapted : undefined),
			};
			return callSessionTool(adapted.name, command.args ?? {}, { session });
		}
		case "managerlessRead": {
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableMCP: true,
				skills: [],
			};
			return new ReadTool(session).execute(`managerless-${command.id}`, { path: command.uri! });
		}
		case "read":
		case "evalRead": {
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableMCP: true,
				mcpManager: manager,
				skills: [],
				taskDepth: command.child ? 1 : 0,
			};
			const read = new ReadTool(session);
			const bridgeRead: AgentTool = {
				name: read.name,
				label: read.label,
				description: read.description,
				parameters: read.parameters,
				execute: (toolCallId, args, signal, onUpdate, context) =>
					read.execute(toolCallId, read.parameters.assert(args), signal, onUpdate, context),
			};
			session.getToolForEvalBridge = name => (name === bridgeRead.name ? bridgeRead : undefined);
			return command.op === "read"
				? read.execute(`read-${command.id}`, { path: command.uri! })
				: callSessionTool("read", { path: command.uri! }, { session });
		}
		case "refresh":
			await manager.refreshAllTools();
			await manager.refreshServerResources(command.server!);
			return manager.getTools().map(tool => tool.mcpServerName);
		case "refreshTools":
			await manager.refreshAllTools();
			return manager.getTools().map(tool => tool.mcpServerName);
		case "refreshResources":
			await manager.refreshServerResources(command.server!);
			return manager.getServerResources(command.server!);
		case "closeServer":
			await manager.disconnectServer(command.server!);
			return manager.getConnectedServers();
		case "reconnect":
			return Boolean(await manager.reconnectServer(command.server!, { manual: true }));
		case "authRetry": {
			let handlerCalls = 0;
			manager.setAuthHandler(async () => {
				handlerCalls++;
				throw new Error("Owner retry must not invoke root authentication");
			});
			try {
				const result = await manager.reconnectServer(command.server!, {
					manual: true,
					authChallenge: { wwwAuthenticate: ['Bearer realm="synthetic"'] },
				});
				return { handlerCalls, connected: Boolean(result) };
			} finally {
				manager.setAuthHandler(undefined);
			}
		}
		case "raw": {
			if (!process.send) throw new Error("No native owner IPC channel");
			if (rawRevoked) throw new Error("Owner channel revoked");
			const message = command.message!;
			const id = message.id as number;
			const response = Promise.withResolvers<unknown>();
			pending.set(id, response.resolve);
			process.send(message);
			emit({ issued: id });
			try {
				return await response.promise;
			} finally {
				pending.delete(id);
			}
		}
		default:
			throw new Error(`Unknown fixture operation ${command.op}`);
	}
}
