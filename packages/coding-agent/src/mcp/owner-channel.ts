import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { MCPOwnerServerConfig, MCPRequestOptions, MCPServerConfig, MCPTransport } from "./types";

/**
 * The inherited IPC channel is the capability. No endpoint, credential, token,
 * family name or serializable grant can open another channel to the host.
 * This does not defend against an OS debugger or a hostile admitted process.
 */
type OwnerOperation = "catalog" | "request" | "notify" | "close";
interface PendingReply {
	resolve(value: unknown): void;
	reject(error: Error): void;
}
type IpcSend = (this: NodeJS.Process, message: unknown) => boolean;
const pending = new Map<number, PendingReply>();
const transports = new Set<OwnerTransport>();
let sequence = 0;
let revoked = false;
let installed = false;
let catalog: Promise<Record<string, MCPOwnerServerConfig>> | undefined;

function admitted(): boolean {
	return !revoked && typeof process.send === "function" && process.connected === true;
}

function revoke(): void {
	if (revoked) return;
	revoked = true;
	for (const waiter of pending.values()) waiter.reject(new Error("MCP owning-host admission revoked"));
	pending.clear();
	for (const transport of transports) transport.invalidate();
	transports.clear();
}

function receive(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const frame = value as Record<string, unknown>;
	if (frame.ompMcpOwner !== 1) return;
	if (frame.op === "revoke") {
		revoke();
		return;
	}
	if (revoked) return;
	if (frame.op === "notification" && typeof frame.server === "string" && typeof frame.method === "string") {
		for (const transport of transports) {
			if (transport.server === frame.server && transport.connected) {
				transport.onNotification?.(frame.method, frame.params);
			}
		}
		return;
	}
	if (typeof frame.id !== "number") return;
	const waiter = pending.get(frame.id);
	if (!waiter) return;
	pending.delete(frame.id);
	if (!admitted()) waiter.reject(new Error("MCP owning-host admission revoked"));
	else if (typeof frame.error === "string") waiter.reject(new Error(frame.error));
	else waiter.resolve(frame.result);
}

function install(): void {
	if (installed) return;
	installed = true;
	process.on("disconnect", revoke);
	process.on("message", receive);
}

/** Release the root capability when its actual native command lifetime ends. */
export function closeOwnerChannel(): void {
	if (!installed) return;
	revoke();
	installed = false;
	process.off("message", receive);
	process.off("disconnect", revoke);
	if (process.connected && typeof process.disconnect === "function") process.disconnect();
}

async function send(
	op: OwnerOperation,
	server?: string,
	method?: string,
	params?: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<unknown> {
	if (!admitted()) throw new Error("MCP server requires its owning-host launch channel");
	install();
	const id = ++sequence;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	pending.set(id, { resolve, reject });
	try {
		const sender = process.send as IpcSend;
		sender.call(process, { ompMcpOwner: 1, id, op, server, method, params });
	} catch {
		revoke();
	}
	try {
		return timeoutMs === 0
			? await promise
			: await withTimeout(promise, timeoutMs, new Error("MCP owning-host request timed out"));
	} finally {
		pending.delete(id);
	}
}

/** Protected entries are delivered only by the actual launch owner, not disk discovery. */
export async function getOwnerConfigs(forSubagent = false): Promise<Record<string, MCPServerConfig>> {
	if (!admitted()) return {};
	if (!catalog) {
		catalog = (async () => {
			const value = await send("catalog", undefined, undefined, undefined, 2_000);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Invalid owning-host catalog");
			const result: Record<string, MCPOwnerServerConfig> = Object.create(null);
			for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
				if (!item || typeof item !== "object" || Array.isArray(item))
					throw new Error("Invalid owning-host server reference");
				const entry = item as Record<string, unknown>;
				if (entry.type !== "owner" || entry.server !== name)
					throw new Error("Invalid owning-host server reference");
				// Copy only inert presentation/inheritance fields; never accept raw transport authority.
				result[name] = {
					type: "owner",
					server: name,
					inheritInSubagents: entry.inheritInSubagents !== false,
					instructions: entry.instructions !== false,
					...(typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout >= 0
						? { timeout: entry.timeout }
						: {}),
				};
			}
			return result;
		})().catch(() => {
			// An unrelated IPC parent is not an MCP issuer. Ordinary servers still
			// discover normally; an owner reference remains impossible to open.
			revoke();
			return {};
		});
	}
	const entries = await catalog;
	if (!admitted()) return {};
	return Object.fromEntries(
		Object.entries(entries).filter(([, config]) => !forSubagent || config.inheritInSubagents !== false),
	);
}

class OwnerTransport implements MCPTransport {
	#closed = false;
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(
		readonly server: string,
		readonly timeoutMs: number,
	) {}

	get connected(): boolean {
		return !this.#closed && admitted();
	}
	isAdmitted(): boolean {
		return admitted();
	}

	invalidate(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.onClose?.();
	}

	async request<T>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		options?.signal?.throwIfAborted();
		if (!this.connected) throw new Error("MCP owning-host transport is closed");
		const result = await untilAborted(options?.signal, send("request", this.server, method, params, this.timeoutMs));
		if (!this.connected) throw new Error("MCP owning-host admission revoked");
		return result as T;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.connected) throw new Error("MCP owning-host transport is closed");
		await send("notify", this.server, method, params, this.timeoutMs);
		if (!this.connected) throw new Error("MCP owning-host admission revoked");
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		transports.delete(this);
		if (admitted()) await send("close", this.server);
	}
}

export async function createOwnerTransport(config: MCPOwnerServerConfig): Promise<MCPTransport> {
	const configs = await getOwnerConfigs();
	if (!admitted() || !Object.hasOwn(configs, config.server)) {
		throw new Error("MCP server requires its owning-host launch channel");
	}
	const transport = new OwnerTransport(config.server, configs[config.server].timeout ?? 30_000);
	transports.add(transport);
	return transport;
}
