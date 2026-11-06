import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

// Gates are shared files between real processes: the test waits for an entered signal,
// never for elapsed time. Polling here only yields while the parent controls release.
const [directory, namespace, initializationGate] = process.argv.slice(2);
if (!directory || !namespace) throw new Error("Expected owned directory and resource namespace");
const log = path.join(directory, `${namespace}-${process.pid}.jsonl`);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
	void respond(JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> });
});
lines.on("close", () => process.exit(0));

async function respond(message: { id?: number | string; method: string; params?: Record<string, unknown> }) {
	await fs.appendFile(log, `${JSON.stringify(message)}\n`);
	if (message.id === undefined) return;
	const responseGate = message.method.replaceAll("/", "-");
	if (await Bun.file(path.join(directory, `${responseGate}.arm`)).exists()) {
		await Bun.write(path.join(directory, `${responseGate}-${namespace}.entered`), String(process.pid));
		while (!(await Bun.file(path.join(directory, `${responseGate}.release`)).exists())) await Bun.sleep(5);
	}
	let result: unknown;
	switch (message.method) {
		case "initialize":
			if (initializationGate) {
				await Bun.write(path.join(directory, `${initializationGate}.entered`), String(process.pid));
				while (!(await Bun.file(path.join(directory, `${initializationGate}.release`)).exists()))
					await Bun.sleep(5);
			}
			result = {
				protocolVersion: "2025-03-26",
				serverInfo: { name: namespace, version: "1" },
				capabilities: { tools: {}, resources: {} },
				instructions: "Use synthetic integer arithmetic only.",
			};
			break;
		case "tools/list":
			result = {
				tools: [
					{
						name: "sum",
						description: "Add synthetic integers",
						inputSchema: {
							type: "object",
							properties: { a: { type: "number" }, b: { type: "number" }, gate: { type: "string" } },
							required: ["a", "b"],
						},
					},
				],
			};
			break;
		case "tools/call": {
			const args = message.params?.arguments as { a: number; b: number; gate?: string };
			if (args.gate) {
				await Bun.write(path.join(directory, `${args.gate}.entered`), String(process.pid));
				while (!(await Bun.file(path.join(directory, `${args.gate}.release`)).exists())) await Bun.sleep(5);
			}
			const sum = args.a + args.b;
			result = { content: [{ type: "text", text: `sum=${sum}` }], structuredContent: { sum } };
			break;
		}
		case "resources/list":
			result = {
				resources: [
					{ uri: `${namespace}://document`, name: "document" },
					{ uri: `skill://${namespace}/remote/SKILL.md`, name: "remote skill" },
				],
			};
			break;
		case "resources/templates/list":
			result = { resourceTemplates: [{ uriTemplate: `${namespace}://items/{id}`, name: "item" }] };
			break;
		case "resources/read":
			result = { contents: [{ uri: message.params?.uri, text: `synthetic resource ${message.params?.uri}` }] };
			break;
		default:
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`,
			);
			return;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
