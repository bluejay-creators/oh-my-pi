import * as path from "node:path";
import * as url from "node:url";
import type { Subprocess } from "bun";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { connectToServer } from "./client";
import { MCP_PROTOCOL_VERSION, type MCPServerConfig, type MCPServerConnection } from "./types";

/** Authority is supplied directly, never discovered from ordinary config or credential storage. */
export interface OwningHostManifest {
	servers: Record<string, Exclude<MCPServerConfig, { type: "owner" }>>;
	roots: Record<string, { args: string[]; cwd?: string }>;
}

export interface OwningHostHandle {
	roots: ReadonlyMap<string, Subprocess<"pipe", "pipe", "pipe">>;
	revoke(root: string): Promise<void>;
	close(): Promise<void>;
	exited: Promise<void>;
}

interface ConnectionSlot {
	active: boolean;
	abort: AbortController;
	connection: Promise<MCPServerConnection>;
}

interface RootState {
	cwd: string;
	active: boolean;
	lastId: number;
	process?: Subprocess<"pipe", "pipe", "pipe">;
	connections: Map<string, ConnectionSlot>;
	revoking?: Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected owning-host field");
}

function text(value: unknown, empty = false): value is string {
	return typeof value === "string" && (empty || value.trim().length > 0) && !value.includes("\0");
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => text(item, true));
}

function stringMap(value: unknown): value is Record<string, string> {
	return record(value) && Object.entries(value).every(([key, item]) => text(key) && text(item, true));
}

/** Strict validation happens for the entire manifest before either root is spawned. */
export function validateOwningHostManifest(value: unknown): asserts value is OwningHostManifest {
	if (!record(value)) throw new Error("Owning-host manifest must be an object");
	keys(value, ["servers", "roots"]);
	if (!record(value.servers) || !record(value.roots) || Object.keys(value.roots).length !== 2) {
		throw new Error("Owning host requires a server map and exactly two named roots");
	}
	const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
	for (const [name, root] of Object.entries(value.roots)) {
		if (!namePattern.test(name) || !record(root)) throw new Error("Invalid owning-host root");
		keys(root, ["args", "cwd"]);
		if (!stringArray(root.args) || (root.cwd !== undefined && !text(root.cwd))) {
			throw new Error("Invalid owning-host root arguments or working directory");
		}
	}
	for (const [name, config] of Object.entries(value.servers)) {
		if (!namePattern.test(name) || !record(config)) throw new Error("Invalid protected server");
		const common = ["type", "enabled", "inheritInSubagents", "timeout", "instructions", "requestIdFormat"];
		for (const field of ["enabled", "inheritInSubagents", "instructions"]) {
			if (config[field] !== undefined && typeof config[field] !== "boolean") {
				throw new Error("Invalid protected server policy");
			}
		}
		if (
			config.timeout !== undefined &&
			(typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout < 0)
		) {
			throw new Error("Invalid protected server timeout");
		}
		if (
			config.requestIdFormat !== undefined &&
			config.requestIdFormat !== "number" &&
			config.requestIdFormat !== "string"
		) {
			throw new Error("Invalid protected server request id format");
		}
		if (config.type !== undefined && config.type !== "stdio" && config.type !== "http" && config.type !== "sse") {
			throw new Error("Owning host accepts raw stdio, HTTP, or SSE servers only");
		}
		switch (config.type ?? "stdio") {
			case "stdio":
				keys(config, [...common, "command", "args", "env", "envPolicy", "envLiteralKeys", "cwd"]);
				if (
					!text(config.command) ||
					(config.args !== undefined && !stringArray(config.args)) ||
					(config.env !== undefined && !stringMap(config.env)) ||
					(config.cwd !== undefined && !text(config.cwd)) ||
					(config.envPolicy !== undefined && config.envPolicy !== "literal") ||
					(config.envLiteralKeys !== undefined && !stringArray(config.envLiteralKeys))
				) {
					throw new Error("Invalid protected stdio configuration");
				}
				break;
			case "http":
			case "sse": {
				keys(config, [...common, "url", "headers", "headerPolicy"]);
				if (
					!text(config.url) ||
					(config.headers !== undefined && !stringMap(config.headers)) ||
					(config.headerPolicy !== undefined && config.headerPolicy !== "origin-locked")
				) {
					throw new Error("Invalid protected remote configuration");
				}
				let url: URL;
				try {
					url = new URL(config.url);
				} catch {
					throw new Error("Invalid protected server URL");
				}
				if (url.protocol !== "http:" && url.protocol !== "https:")
					throw new Error("Invalid protected server URL protocol");
				break;
			}
			default:
				throw new Error("Owning host accepts raw stdio, HTTP, or SSE servers only");
		}
	}
}

/** Roots get runtime basics, not a copy of the host's credential-bearing environment. */
function rootEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TMPDIR",
		"TMP",
		"TEMP",
		"TERM",
		"COLORTERM",
		"LANG",
		"LC_ALL",
		"SystemRoot",
		"OMP_NATIVE_LIBRARY_PATH",
	]) {
		const value = process.env[key];
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

/** Launch two independent native CLI processes with distinct, identity-bound IPC channels. */
export async function launchOwningHost(
	manifest: OwningHostManifest,
	rootCommand?: string[],
): Promise<OwningHostHandle> {
	validateOwningHostManifest(manifest);
	const snapshot = structuredClone(manifest);
	const command = rootCommand ?? resolveCliEntryCmd();
	if (!stringArray(command) || command.length === 0 || !text(command[0])) throw new Error("Invalid root command");
	const roots = new Map<string, Subprocess<"pipe", "pipe", "pipe">>();
	const states = new Map<string, RootState>();
	let closed = false;
	let closing: Promise<void> | undefined;

	function send(state: RootState, message: unknown): void {
		if (!state.active || closed) return;
		try {
			state.process?.send(message);
		} catch {
			void revokeState(state);
		}
	}

	function closeSlot(slot: ConnectionSlot): Promise<void> {
		slot.active = false;
		slot.abort.abort(new Error("Owner connection revoked"));
		return slot.connection.then(
			connection => connection.transport.close(),
			() => {},
		);
	}

	function revokeState(state: RootState): Promise<void> {
		if (state.revoking) return state.revoking;
		state.active = false;
		// Notification invalidates the consumer catalog and rejects every pending operation.
		try {
			state.process?.send({ ompMcpOwner: 1, op: "revoke" });
		} catch {
			/* Channel already gone. */
		}
		const pending = [...state.connections.values()].map(closeSlot);
		state.connections.clear();
		state.revoking = Promise.allSettled(pending).then(() => {});
		return state.revoking;
	}

	function assertActive(state: RootState, slot?: ConnectionSlot): void {
		if (closed || !state.active || (slot && !slot.active)) throw new Error("Owner authority revoked");
	}

	function getConnection(state: RootState, name: string): ConnectionSlot {
		assertActive(state);
		const config = snapshot.servers[name];
		if (!Object.hasOwn(snapshot.servers, name) || !config || config.enabled === false)
			throw new Error("Server not admitted");
		const existing = state.connections.get(name);
		if (existing) return existing;
		const abort = new AbortController();
		const slot: ConnectionSlot = {
			active: true,
			abort,
			connection: connectToServer(name, config, {
				signal: abort.signal,
				async onRequest(method) {
					assertActive(state, slot);
					switch (method) {
						case "ping":
							return {};
						case "roots/list":
							return { roots: [{ uri: url.pathToFileURL(state.cwd).href, name: path.basename(state.cwd) }] };
						default:
							throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
					}
				},
				onNotification(method, params) {
					if (slot.active) send(state, { ompMcpOwner: 1, op: "notification", server: name, method, params });
				},
			}),
		};
		state.connections.set(name, slot);
		void slot.connection
			.then(
				async connection => {
					if (closed || !state.active || !slot.active) {
						await connection.transport.close();
						return;
					}
					connection.transport.onClose = () => {
						if (slot.active) void revokeState(state);
					};
					connection.transport.onError = () => {
						if (slot.active) void revokeState(state);
					};
					if (!connection.transport.connected) await revokeState(state);
				},
				() => {
					if (slot.active) void revokeState(state);
				},
			)
			.catch(() => {
				if (slot.active) void revokeState(state);
			});
		return slot;
	}

	async function receive(state: RootState, message: unknown): Promise<void> {
		if (!state.active || closed) return;
		if (!record(message) || message.ompMcpOwner !== 1) return;
		const id = message.id;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= state.lastId) {
			await revokeState(state);
			return;
		}
		state.lastId = id;
		try {
			keys(message, ["ompMcpOwner", "id", "op", "server", "method", "params"]);
			assertActive(state);
			let result: unknown;
			if (message.op === "catalog") {
				if (message.server !== undefined || message.method !== undefined || message.params !== undefined)
					throw new Error("Invalid catalog");
				const catalog: Record<string, unknown> = Object.create(null);
				for (const [name, config] of Object.entries(snapshot.servers)) {
					if (config.enabled === false) continue;
					// Deliberate allowlist: raw transport configuration never crosses this channel.
					catalog[name] = {
						type: "owner",
						server: name,
						...(config.inheritInSubagents !== undefined ? { inheritInSubagents: config.inheritInSubagents } : {}),
						...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
						...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
						...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
					};
				}
				result = catalog;
			} else {
				if (
					!text(message.server) ||
					!Object.hasOwn(snapshot.servers, message.server) ||
					snapshot.servers[message.server].enabled === false
				)
					throw new Error("Server not admitted");
				if (message.op === "close") {
					if (message.method !== undefined || message.params !== undefined) throw new Error("Invalid close");
					const slot = state.connections.get(message.server);
					if (slot) {
						state.connections.delete(message.server);
						await closeSlot(slot);
					}
				} else {
					if (
						(message.op !== "request" && message.op !== "notify") ||
						!text(message.method) ||
						(message.params !== undefined && !record(message.params))
					)
						throw new Error("Invalid owner operation");
					const slot = getConnection(state, message.server);
					const connection = await slot.connection;
					assertActive(state, slot);
					if (message.op === "request") {
						result =
							message.method === "initialize"
								? {
										protocolVersion: connection.protocolVersion ?? MCP_PROTOCOL_VERSION,
										capabilities: connection.capabilities,
										serverInfo: connection.serverInfo,
										...(connection.instructions !== undefined
											? { instructions: connection.instructions }
											: {}),
									}
								: await connection.transport.request(message.method, message.params, {
										signal: slot.abort.signal,
									});
					} else if (message.method !== "notifications/initialized") {
						await connection.transport.notify(message.method, message.params);
					}
					assertActive(state, slot);
				}
			}
			assertActive(state);
			send(state, { ompMcpOwner: 1, id, result });
		} catch {
			// Transport errors can contain credentials/URLs; never forward their raw text.
			send(state, { ompMcpOwner: 1, id, error: "Owner operation denied or failed" });
		}
	}

	const close = (): Promise<void> => {
		if (closing) return closing;
		closed = true;
		const pending = [...states.values()].map(revokeState);
		for (const root of roots.values()) {
			try {
				root.stdin.end();
			} catch {
				/* Root already exited. */
			}
			try {
				root.kill("SIGKILL");
			} catch {
				/* Root already exited. */
			}
		}
		closing = Promise.allSettled([...pending, ...[...roots.values()].map(root => root.exited)]).then(() => {});
		return closing;
	};

	try {
		for (const [name, root] of Object.entries(snapshot.roots)) {
			const state: RootState = {
				cwd: path.resolve(root.cwd ?? process.cwd()),
				active: true,
				lastId: 0,
				connections: new Map(),
			};
			states.set(name, state);
			const child = Bun.spawn({
				cmd: [...command, ...root.args],
				cwd: state.cwd,
				env: rootEnvironment(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				serialization: "json",
				ipc(message: unknown, process) {
					state.process ??= process;
					void receive(state, message).catch(() => {
						void revokeState(state);
					});
				},
				onDisconnect() {
					void revokeState(state);
				},
				onExit() {
					void revokeState(state);
				},
			});
			state.process = child;
			roots.set(name, child);
		}
	} catch (error) {
		await close();
		throw error;
	}
	return {
		roots,
		revoke(name) {
			const state = states.get(name);
			if (!state) return Promise.reject(new Error("Unknown owning-host root"));
			return revokeState(state);
		},
		close,
		exited: Promise.all([...roots.values()].map(root => root.exited)).then(async () => {
			await Promise.all([...states.values()].map(revokeState));
		}),
	};
}
