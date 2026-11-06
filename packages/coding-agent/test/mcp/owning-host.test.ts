import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsEvents from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import type { OwningHostManifest } from "../../src/mcp/owning-host";
import type { MCPStdioServerConfig } from "../../src/mcp/types";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures");
const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const PROTECTED_URIS = ["mcp://protected://document", "protected://items/7", "skill://protected/remote/SKILL.md"];
type Reply = {
	id?: number;
	issued?: number;
	ready?: boolean;
	pid?: number;
	ppid?: number;
	result?: unknown;
	error?: string;
};
type Event = {
	root?: string;
	message?: Reply;
	control?: number;
	revoked?: string;
	event?: string;
	stream?: string;
	data?: string;
	code?: number;
	pid?: number;
};
type Command = {
	op: string;
	server?: string;
	child?: boolean;
	uri?: string;
	args?: Record<string, unknown>;
	message?: Record<string, unknown>;
};

class ProcessProbe {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	events: Event[] = [];
	errors = "";
	#id = 0;
	#pumps: Promise<void>[];
	#listeners = new Set<(event: Event) => void>();
	constructor(command: string[], cwd: string, env: Record<string, string>, directRoot?: string) {
		const child = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.child = child;
		const decoder = new TextDecoder();
		this.#pumps = [
			(async () => {
				for await (const bytes of readLines(child.stdout)) {
					const value = JSON.parse(decoder.decode(bytes)) as Event & Reply;
					const event = directRoot ? { root: directRoot, message: value } : value;
					this.events.push(event);
					for (const listener of this.#listeners) listener(event);
				}
			})(),
			(async () => {
				for await (const bytes of readLines(child.stderr)) this.errors += `${decoder.decode(bytes)}\n`;
			})(),
		];
	}
	write(value: unknown) {
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}
	async wait(predicate: (event: Event) => boolean): Promise<Event> {
		const existing = this.events.find(predicate);
		if (existing) return existing;
		const { promise, resolve } = Promise.withResolvers<Event>();
		const listener = (event: Event) => {
			if (predicate(event)) resolve(event);
		};
		this.#listeners.add(listener);
		// A real subprocess needs a failure deadline, not fake time or a guessed settling delay.
		try {
			return await withTimeout(promise, 15_000, new Error("Timed out waiting for a subprocess event"));
		} catch {
			throw new Error(`Missing process event: ${JSON.stringify(this.events)}\n${this.errors}`);
		} finally {
			this.#listeners.delete(listener);
		}
	}
	request(root: string, command: Command, direct = false): Promise<Reply> {
		const id = ++this.#id;
		const input = `${JSON.stringify({ ...command, id })}\n`;
		if (direct) this.child.stdin.write(input);
		else this.write({ root, input });
		return this.wait(event => event.root === root && event.message?.id === id).then(event => event.message!);
	}
	async revoke(root: string) {
		const id = ++this.#id;
		this.write({ id, revoke: root });
		await this.wait(event => event.control === id && event.revoked === root);
	}
	async finish() {
		await this.child.exited;
		await Promise.all(this.#pumps);
	}
	async close() {
		if (this.child.exitCode === null) {
			this.child.stdin.end();
			// Bound cleanup of a failed external process; this is not synchronization for assertions.
			const timer = setTimeout(() => this.child.kill(), 3_000);
			try {
				await this.finish();
			} finally {
				clearTimeout(timer);
			}
		} else await this.finish();
	}
}

describe("native protected MCP owning host", () => {
	let directory: string;
	let cwd: string;
	let env: Record<string, string>;
	let probes: ProcessProbe[];
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owning-host-"));
		cwd = path.join(directory, "project");
		await fs.mkdir(cwd);
		env = {
			PATH: path.dirname(process.execPath),
			HOME: directory,
			USERPROFILE: directory,
			TMPDIR: directory,
			TMP: directory,
			TEMP: directory,
			XDG_CONFIG_HOME: path.join(directory, "config"),
			XDG_DATA_HOME: path.join(directory, "data"),
			XDG_CACHE_HOME: path.join(directory, "cache"),
			PI_CODING_AGENT_DIR: path.join(directory, "agent"),
			NO_COLOR: "1",
			TERM: "dumb",
		};
		if (process.env.OMP_NATIVE_LIBRARY_PATH) env.OMP_NATIVE_LIBRARY_PATH = process.env.OMP_NATIVE_LIBRARY_PATH;
		probes = [];
	});
	afterEach(async () => {
		await Promise.all(probes.map(probe => probe.close()));
		await removeWithRetries(directory);
	});

	function server(namespace: string, inheritInSubagents?: boolean, initializationGate?: string): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: process.execPath,
			args: [
				path.join(FIXTURES, "owning-host-server.ts"),
				directory,
				namespace,
				...(initializationGate ? [initializationGate] : []),
			],
			inheritInSubagents,
		};
	}
	async function launch(raw = false, initializationGate?: string) {
		const probe = new ProcessProbe([process.execPath, path.join(FIXTURES, "owning-host-driver.ts")], cwd, env);
		probes.push(probe);
		const manifest: OwningHostManifest = {
			servers: { protected: server("protected", false, initializationGate), shared: server("shared") },
			roots: { "root-alpha": { args: raw ? ["--raw"] : [], cwd }, "root-beta": { args: raw ? ["--raw"] : [], cwd } },
		};
		probe.write(manifest);
		await Promise.all(
			["root-alpha", "root-beta"].map(root =>
				probe.wait(event => event.root === root && event.message?.ready === true),
			),
		);
		return probe;
	}
	async function requests(namespace: string): Promise<{ method: string; params?: Record<string, unknown> }[]> {
		const names = (await fs.readdir(directory)).filter(
			name => name.startsWith(`${namespace}-`) && name.endsWith(".jsonl"),
		);
		return (
			await Promise.all(
				names.map(async name => {
					const text = await Bun.file(path.join(directory, name)).text();
					return text
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
				}),
			)
		).flat();
	}
	async function entered(gate: string) {
		const { promise, resolve } = Promise.withResolvers<void>();
		const watcher = fsEvents.watch(directory, (_event, filename) => {
			if (filename === `${gate}.entered`) resolve();
		});
		try {
			if (!(await Bun.file(path.join(directory, `${gate}.entered`)).exists())) {
				await withTimeout(promise, 15_000, new Error(`Server never entered ${gate}`));
			}
		} finally {
			watcher.close();
		}
	}

	it("admits two independent roots, keeps authority out of catalogs, and denies copied references while ordinary MCP and child policy still work", async () => {
		await Bun.write(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { ordinary: server("ordinary") } }));
		const host = await launch();
		const ready = host.events.filter(event => event.message?.ready).map(event => event.message!);
		expect(new Set(ready.map(value => value.pid)).size).toBe(2);
		expect(ready[0].ppid).toBe(host.child.pid);
		expect(ready[1].ppid).toBe(host.child.pid);
		for (const root of ["root-alpha", "root-beta"]) {
			const catalog = await host.request(root, { op: "catalog" });
			expect(catalog.error).toBeUndefined();
			expect(catalog.result).toEqual({
				protected: { type: "owner", server: "protected", inheritInSubagents: false, instructions: true },
				shared: { type: "owner", server: "shared", inheritInSubagents: true, instructions: true },
			});
			const childCatalog = await host.request(root, { op: "catalog", child: true });
			expect(childCatalog.result).toEqual({
				shared: { type: "owner", server: "shared", inheritInSubagents: true, instructions: true },
			});
			const connected = await host.request(root, { op: "connect" });
			expect(connected.error).toBeUndefined();
			expect(connected.result).toMatchObject({
				servers: expect.arrayContaining(["protected", "shared", "ordinary"]),
				childTools: expect.arrayContaining(["shared", "ordinary"]),
			});
			expect(connected.result).toHaveProperty("childTools", expect.not.arrayContaining(["protected"]));
			const authRetry = await host.request(root, { op: "authRetry", server: "protected" });
			expect(authRetry.error).toBeUndefined();
			expect(authRetry.result).toEqual({ handlerCalls: 0, connected: false });
			const sum = await host.request(root, { op: "tool", server: "protected", args: { a: 19, b: 23 } });
			expect(JSON.stringify(sum.result)).toContain("sum=42");
			const evalSum = await host.request(root, { op: "evalTool", server: "protected", args: { a: 17, b: 25 } });
			expect(evalSum.error).toBeUndefined();
			expect(evalSum.result).toHaveProperty("details.structuredContent.sum", 42);
			for (const op of ["read", "evalRead"]) {
				for (const uri of PROTECTED_URIS) {
					const read = await host.request(root, { op, uri });
					expect(read.error).toBeUndefined();
					expect(JSON.stringify(read.result)).toContain(`synthetic resource ${uri.replace(/^mcp:\/\//, "")}`);
					const denied = await host.request(root, { op, uri, child: true });
					expect(denied.error).toBeString();
				}
			}
			expect(
				(await host.request(root, { op: "tool", server: "protected", child: true, args: { a: 1, b: 2 } })).error,
			).toBeString();
			expect(
				(await host.request(root, { op: "evalTool", server: "protected", child: true, args: { a: 1, b: 2 } }))
					.error,
			).toBeString();
			expect(
				JSON.stringify(
					(await host.request(root, { op: "tool", server: "ordinary", child: true, args: { a: 4, b: 5 } })).result,
				),
			).toContain("sum=9");
			expect(
				(await host.request(root, { op: "managerlessRead", uri: "mcp://protected://document" })).error,
			).toBeString();
		}
		const initialized = (await requests("protected")).filter(request => request.method === "initialize").length;
		const closed = await host.request("root-alpha", { op: "closeServer", server: "protected" });
		expect(closed.result).toEqual(expect.arrayContaining(["shared", "ordinary"]));
		expect(closed.result).not.toContain("protected");
		const reopened = await host.request("root-alpha", { op: "connect", server: "protected" });
		expect(reopened.error).toBeUndefined();
		expect(
			JSON.stringify(
				(await host.request("root-alpha", { op: "tool", server: "protected", args: { a: 20, b: 22 } })).result,
			),
		).toContain("sum=42");
		expect((await requests("protected")).filter(request => request.method === "initialize")).toHaveLength(
			initialized + 1,
		);
		const before = await requests("protected");
		await Bun.write(
			path.join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					ordinary: server("ordinary"),
					protected: { type: "owner", server: "protected", inheritInSubagents: false },
				},
			}),
		);
		const outsider = new ProcessProbe(
			[process.execPath, path.join(FIXTURES, "owning-host-root.ts")],
			cwd,
			{
				...env,
				OMP_MCP_OWNER: "root-alpha",
				OMP_MCP_OWNER_ROOT: "root-alpha",
				OMP_MCP_OWNER_TOKEN: "copied-token",
				OMP_ROOT: "root-alpha",
			},
			"outsider",
		);
		probes.push(outsider);
		await outsider.wait(event => event.message?.ready === true);
		await outsider.request("outsider", { op: "connect" }, true);
		expect((await outsider.request("outsider", { op: "directOwner" }, true)).error).toBeString();
		expect(
			(await outsider.request("outsider", { op: "evalTool", server: "protected", args: { a: 1, b: 2 } }, true))
				.error,
		).toBeString();
		expect(
			(await outsider.request("outsider", { op: "tool", server: "protected", args: { a: 1, b: 2 } }, true)).error,
		).toBeString();
		for (const op of ["read", "evalRead"]) {
			for (const uri of PROTECTED_URIS)
				expect((await outsider.request("outsider", { op, uri }, true)).error).toBeString();
		}
		expect(
			(
				await outsider.request(
					"outsider",
					{
						op: "raw",
						message: { ompMcpOwner: 1, id: 1, op: "catalog", root: "root-alpha", token: "copied-token" },
					},
					true,
				)
			).error,
		).toContain("No native owner IPC channel");
		expect(
			JSON.stringify(
				(await outsider.request("outsider", { op: "tool", server: "ordinary", args: { a: 2, b: 8 } }, true)).result,
			),
		).toContain("sum=10");
		expect(await requests("protected")).toEqual(before);
	}, 90_000);

	it("rejects replayed and decreasing IDs before a second protected dispatch", async () => {
		const host = await launch(true);
		const send = (root: string, message: Record<string, unknown>) =>
			host.request(root, { op: "raw", message: { ompMcpOwner: 1, ...message } });
		expect((await send("root-alpha", { id: 1, op: "catalog" })).result).toHaveProperty(
			"result.protected.type",
			"owner",
		);
		const call = {
			id: 2,
			op: "request",
			server: "protected",
			method: "tools/call",
			params: { name: "sum", arguments: { a: 6, b: 7 } },
		};
		expect(JSON.stringify((await send("root-alpha", call)).result)).toContain("sum=13");
		expect((await send("root-alpha", call)).result).toHaveProperty("error", expect.any(String));
		expect((await send("root-alpha", { id: 3, op: "catalog" })).error).toContain("revoked");
		expect((await send("root-beta", { id: 3, op: "catalog" })).result).toHaveProperty("result.shared.type", "owner");
		expect((await send("root-beta", { id: 2, op: "catalog" })).result).toHaveProperty("error", expect.any(String));
		expect((await requests("protected")).filter(request => request.method === "tools/call")).toHaveLength(1);
	}, 30_000);

	it("revokes concurrent in-flight responses permanently without revoking the other independent root", async () => {
		const host = await launch();
		await Promise.all(["root-alpha", "root-beta"].map(root => host.request(root, { op: "connect" })));
		expect(
			(await host.request("root-alpha", { op: "read", uri: "mcp://protected://document" })).error,
		).toBeUndefined();
		const primed = await host.request("root-alpha", { op: "snapshot" });
		expect(primed.result).toHaveProperty(
			"resources.resources",
			expect.arrayContaining([expect.objectContaining({ uri: "protected://document" })]),
		);
		expect(primed.result).toHaveProperty("instructions.protected", expect.any(String));
		await Promise.all(
			["resources-read", "tools-list", "resources-list"].map(gate =>
				Bun.write(path.join(directory, `${gate}.arm`), "armed"),
			),
		);
		const first = host.request("root-alpha", {
			op: "tool",
			server: "protected",
			args: { a: 10, b: 1, gate: "first" },
		});
		const second = host.request("root-alpha", {
			op: "tool",
			server: "protected",
			args: { a: 10, b: 2, gate: "second" },
		});
		const resource = host.request("root-alpha", { op: "read", uri: "protected://items/held" });
		await Promise.all(["first", "second", "resources-read-protected"].map(gate => entered(gate)));
		const toolRefresh = host.request("root-alpha", { op: "refreshTools", server: "protected" });
		const resourceRefresh = host.request("root-alpha", { op: "refreshResources", server: "protected" });
		await Promise.all(["tools-list-protected", "resources-list-protected"].map(gate => entered(gate)));
		await host.revoke("root-alpha");
		await Promise.all(
			["first", "second", "resources-read", "tools-list", "resources-list"].map(gate =>
				Bun.write(path.join(directory, `${gate}.release`), "release"),
			),
		);
		for (const response of await Promise.all([first, second])) {
			if (response.error === undefined) expect(response.result).toHaveProperty("isError", true);
			else expect(response.error).toBeString();
			expect(JSON.stringify(response.result ?? null)).not.toContain("sum=11");
			expect(JSON.stringify(response.result ?? null)).not.toContain("sum=12");
		}
		expect((await resource).error).toBeString();
		expect((await toolRefresh).result).not.toContain("protected");
		expect((await resourceRefresh).result).toBeUndefined();
		const deniedBaseline = await requests("protected");
		await host.request("root-alpha", { op: "refresh", server: "protected" });
		await host.request("root-alpha", { op: "reconnect", server: "protected" });
		const authRetry = await host.request("root-alpha", { op: "authRetry", server: "protected" });
		expect(authRetry.error).toBeUndefined();
		expect(authRetry.result).toEqual({ handlerCalls: 0, connected: false });
		expect(
			(await host.request("root-alpha", { op: "tool", server: "protected", args: { a: 1, b: 2 } })).error,
		).toBeString();
		for (const op of ["read", "evalRead"]) {
			for (const uri of PROTECTED_URIS) expect((await host.request("root-alpha", { op, uri })).error).toBeString();
		}
		expect(
			(await host.request("root-alpha", { op: "evalTool", server: "protected", args: { a: 1, b: 2 } })).error,
		).toBeString();
		expect(await requests("protected")).toEqual(deniedBaseline);
		const snapshot = await host.request("root-alpha", { op: "snapshot" });
		expect(snapshot.result).toEqual({ servers: [], tools: [], instructions: {}, catalog: {} });
		expect(
			JSON.stringify(
				(await host.request("root-beta", { op: "tool", server: "protected", args: { a: 30, b: 12 } })).result,
			),
		).toContain("sum=42");
		await host.request("root-beta", { op: "disconnect" });
		expect((await host.request("root-beta", { op: "snapshot" })).result).toEqual({
			servers: [],
			tools: [],
			instructions: {},
			catalog: {},
		});
		expect(
			(await host.request("root-beta", { op: "tool", server: "protected", args: { a: 1, b: 2 } })).error,
		).toBeString();
	}, 45_000);

	it("revokes requests queued behind lazy initialization before either reaches the protected server", async () => {
		const host = await launch(true, "initialize");
		const first = host.request("root-alpha", {
			op: "raw",
			message: {
				ompMcpOwner: 1,
				id: 1,
				op: "request",
				server: "protected",
				method: "tools/call",
				params: { name: "sum", arguments: { a: 1, b: 2 } },
			},
		});
		const second = host.request("root-alpha", {
			op: "raw",
			message: {
				ompMcpOwner: 1,
				id: 2,
				op: "request",
				server: "protected",
				method: "tools/call",
				params: { name: "sum", arguments: { a: 3, b: 4 } },
			},
		});
		const resource = host.request("root-alpha", {
			op: "raw",
			message: {
				ompMcpOwner: 1,
				id: 3,
				op: "request",
				server: "protected",
				method: "resources/read",
				params: { uri: "protected://document" },
			},
		});
		const toolRefresh = host.request("root-alpha", {
			op: "raw",
			message: { ompMcpOwner: 1, id: 4, op: "request", server: "protected", method: "tools/list" },
		});
		const resourceRefresh = host.request("root-alpha", {
			op: "raw",
			message: { ompMcpOwner: 1, id: 5, op: "request", server: "protected", method: "resources/list" },
		});
		await Promise.all([
			entered("initialize"),
			host.wait(event => event.root === "root-alpha" && event.message?.issued === 5),
		]);
		await host.revoke("root-alpha");
		await Bun.write(path.join(directory, "initialize.release"), "release");
		for (const response of await Promise.all([first, second, resource, toolRefresh, resourceRefresh]))
			expect(response.result).toHaveProperty("error", expect.any(String));
		expect(
			(await requests("protected")).filter(request =>
				["tools/call", "tools/list", "resources/read", "resources/list"].includes(request.method),
			),
		).toEqual([]);
		expect(
			(await host.request("root-alpha", { op: "raw", message: { ompMcpOwner: 1, id: 6, op: "catalog" } })).error,
		).toContain("revoked");
	}, 30_000);

	it("native CLI read completion releases owner IPC and exits both roots and host without controller EOF", async () => {
		const host = new ProcessProbe([process.execPath, CLI, "mcp-owning-host"], cwd, env);
		probes.push(host);
		host.write({
			servers: { protected: server("protected", false) },
			roots: {
				"root-alpha": { args: ["read", "mcp://protected://document"], cwd },
				"root-beta": { args: ["read", "protected://items/42"], cwd },
			},
		});
		for (const root of ["root-alpha", "root-beta"])
			await host.wait(event => event.event === "exit" && event.root === root);
		for (const [root, uri] of [
			["root-alpha", "protected://document"],
			["root-beta", "protected://items/42"],
		]) {
			expect(host.events.find(event => event.event === "exit" && event.root === root)?.code).toBe(0);
			const output = host.events
				.filter(event => event.event === "output" && event.root === root && event.stream === "stdout")
				.map(event => event.data ?? "")
				.join("");
			expect(output).toContain(`synthetic resource ${uri}`);
		}
		const starts = host.events.filter(event => event.event === "started");
		expect(new Set(starts.map(event => event.pid)).size).toBe(2);
		expect(
			(await requests("protected"))
				.filter(request => request.method === "resources/read")
				.map(request => request.params?.uri)
				.sort(),
		).toEqual(["protected://document", "protected://items/42"]);
		await withTimeout(
			host.finish(),
			15_000,
			new Error("Native owning host did not exit after both root commands completed"),
		);
		expect(host.child.exitCode).toBe(0);
	}, 45_000);

	it("native host stdin EOF terminates both blocked roots without releasing protected resource responses", async () => {
		await Bun.write(path.join(directory, "resources-read.arm"), "armed");
		const host = new ProcessProbe([process.execPath, CLI, "mcp-owning-host"], cwd, env);
		probes.push(host);
		host.write({
			servers: { alpha: server("alpha", false), beta: server("beta", false) },
			roots: {
				"root-alpha": { args: ["read", "mcp://alpha://document"], cwd },
				"root-beta": { args: ["read", "mcp://beta://document"], cwd },
			},
		});
		await Promise.all([entered("resources-read-alpha"), entered("resources-read-beta")]);
		host.child.stdin.end();
		await host.finish();
		for (const root of ["root-alpha", "root-beta"]) {
			expect(host.events.find(event => event.event === "exit" && event.root === root)?.code).not.toBe(0);
			const output = host.events
				.filter(event => event.event === "output" && event.root === root)
				.map(event => event.data ?? "")
				.join("");
			expect(output).not.toContain("synthetic resource");
		}
		expect(host.child.exitCode).toBe(0);
		for (const namespace of ["alpha", "beta"])
			expect((await requests(namespace)).filter(request => request.method === "resources/read")).toHaveLength(1);
	}, 45_000);
});
