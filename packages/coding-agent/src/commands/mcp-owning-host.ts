import { readLines } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { launchOwningHost, type OwningHostHandle, validateOwningHostManifest } from "../mcp/owning-host";

function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function forwardOutput(
	root: string,
	stream: "stdout" | "stderr",
	source: ReadableStream<Uint8Array>,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of source) {
		const data = decoder.decode(chunk, { stream: true });
		if (data) emit({ event: "output", root, stream, data });
	}
	const data = decoder.decode();
	if (data) emit({ event: "output", root, stream, data });
}

async function control(host: OwningHostHandle, value: unknown): Promise<boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid host control");
	const message = value as Record<string, unknown>;
	const fields = Object.keys(message);
	if (message.close === true && fields.length === 1) {
		// The wrapper awaits shutdown in finally; stop consuming input immediately.
		void host.close();
		return false;
	}
	if (typeof message.revoke === "string" && fields.length === 1) {
		await host.revoke(message.revoke);
		emit({ event: "revoked", root: message.revoke });
		return true;
	}
	if (typeof message.root !== "string" || fields.length !== 2) throw new Error("Invalid host control");
	const root = host.roots.get(message.root);
	if (!root) throw new Error("Unknown host root");
	if (typeof message.input === "string") {
		root.stdin.write(message.input);
		await root.stdin.flush();
	} else if (message.end === true) {
		// Ending root input is terminal for its owner authority, even before the CLI exits.
		await host.revoke(message.root);
		root.stdin.end();
		emit({ event: "revoked", root: message.root });
	} else {
		throw new Error("Invalid root input control");
	}
	return true;
}

export default class MCPOwningHost extends Command {
	static description =
		"Own protected MCP transports and launch exactly two independent native roots (JSONL stdin/stdout)";

	async run(): Promise<void> {
		await this.parse(MCPOwningHost);
		const inputAbort = new AbortController();
		const lines = readLines(Bun.stdin.stream(), inputAbort.signal);
		let host: OwningHostHandle | undefined;
		const output: Promise<void>[] = [];
		const controls = new Set<Promise<void>>();
		const stop = (): void => {
			inputAbort.abort();
			void host?.close();
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		try {
			const first = await lines.next();
			if (first.done) {
				if (inputAbort.signal.aborted) return;
				throw new Error("Expected owning-host manifest on first stdin line");
			}
			let manifest: unknown;
			try {
				manifest = JSON.parse(new TextDecoder().decode(first.value));
			} catch {
				throw new Error("Invalid owning-host manifest JSON");
			}
			validateOwningHostManifest(manifest);
			if (inputAbort.signal.aborted) return;
			host = await launchOwningHost(manifest);
			for (const [name, root] of host.roots) {
				emit({ event: "started", root: name, pid: root.pid });
				output.push(forwardOutput(name, "stdout", root.stdout), forwardOutput(name, "stderr", root.stderr));
				output.push(
					root.exited.then(code => {
						emit({ event: "exit", root: name, code });
					}),
				);
			}
			void host.exited.then(() => inputAbort.abort());
			for await (const line of lines) {
				if (inputAbort.signal.aborted) break;
				let message: unknown;
				try {
					message = JSON.parse(new TextDecoder().decode(line));
				} catch {
					throw new Error("Invalid owning-host control JSON");
				}
				// Keep reading parent input while a root's stdin is backpressured:
				// EOF/revoke must not wait behind a queued write or connection close.
				const pending = control(host, message).then(
					keepReading => {
						if (!keepReading) inputAbort.abort();
					},
					() => {
						emit({ event: "error", error: "Owning host rejected input or could not continue" });
						process.exitCode = 1;
						stop();
					},
				);
				controls.add(pending);
				void pending.finally(() => controls.delete(pending));
			}
		} catch {
			// Never echo manifest/control values or transport errors (they may contain authority).
			emit({ event: "error", error: "Owning host rejected input or could not continue" });
			process.exitCode = 1;
		} finally {
			inputAbort.abort();
			await host?.close();
			await lines.return(undefined);
			await Promise.allSettled(output);
			await Promise.allSettled(controls);
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
	}
}
