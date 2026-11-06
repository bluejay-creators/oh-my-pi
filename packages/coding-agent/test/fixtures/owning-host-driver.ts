import * as readline from "node:readline";
import { readLines } from "@oh-my-pi/pi-utils";
import { launchOwningHost, type OwningHostManifest } from "../../src/mcp/owning-host";

const input = readline.createInterface({ input: process.stdin });
const iterator = input[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) throw new Error("Missing manifest");
const manifest = JSON.parse(first.value) as OwningHostManifest;
const host = await launchOwningHost(manifest, [
	process.execPath,
	new URL("./owning-host-root.ts", import.meta.url).pathname,
]);
const decoder = new TextDecoder();
const pumps: Promise<void>[] = [];
for (const [root, child] of host.roots) {
	pumps.push(
		(async () => {
			for await (const line of readLines(child.stdout))
				process.stdout.write(`${JSON.stringify({ root, message: JSON.parse(decoder.decode(line)) })}\n`);
		})(),
	);
	pumps.push(
		(async () => {
			for await (const line of readLines(child.stderr)) process.stderr.write(`${root}: ${decoder.decode(line)}\n`);
		})(),
	);
}
try {
	for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
		const control = JSON.parse(line) as {
			id?: number;
			root?: string;
			input?: string;
			revoke?: string;
			close?: boolean;
		};
		if (control.close) break;
		if (control.revoke) {
			await host.revoke(control.revoke);
			process.stdout.write(`${JSON.stringify({ control: control.id, revoked: control.revoke })}\n`);
		} else if (control.root && control.input) {
			host.roots.get(control.root)!.stdin.write(control.input);
		}
	}
} finally {
	await host.close();
	await Promise.all(pumps);
}
