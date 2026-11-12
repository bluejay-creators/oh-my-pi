import { afterEach, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const KEYS = ["OMP_APPROVAL_RECEIPT", "OMP_APPROVAL_REQUEST_ID", "OMP_APPROVAL_FINGERPRINT"] as const;
const PRINT = KEYS.map(key => `printf '${key}=%s\\n' "$${key}"`).join("; ");

function makeSession(asyncEnabled = false): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "receipt-session",
		settings: Settings.isolated({
			"async.enabled": asyncEnabled,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

const text = (result: { content: { type: string; text?: string }[] }) =>
	result.content.find(c => c.type === "text")?.text ?? "";

afterEach(() => {
	for (const key of KEYS) delete Bun.env[key];
});

describe("bash approval launch receipts", () => {
	const receipt = {
		OMP_APPROVAL_RECEIPT: "a".repeat(64),
		OMP_APPROVAL_REQUEST_ID: "request-1",
		OMP_APPROVAL_FINGERPRINT: "f".repeat(64),
	};

	it("places the receipt in the approved foreground launch and blanks it on the next", async () => {
		const tool = new BashTool(makeSession());
		const first = await tool.execute("approved", { command: PRINT }, undefined, undefined, {
			approvalLaunchEnv: Object.freeze({ ...receipt }),
		} as unknown as AgentToolContext);
		for (const key of KEYS) expect(text(first)).toContain(`${key}=${receipt[key]}`);
		const second = await tool.execute("next", { command: PRINT });
		for (const key of KEYS) expect(text(second)).toContain(`${key}=\n`);
	});

	it("never passes a receipt inherited by OMP's own environment", () => {
		// The shell starts from the process's real environ, so inheritance needs a child process.
		const script = `
			import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
			import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
			const session = { cwd: "/tmp", hasUI: false, skills: [], getSessionFile: () => null,
				settings: Settings.isolated({ "bashInterceptor.enabled": false }), getClientBridge: () => undefined };
			const result = await new BashTool(session).execute("plain", { command: ${JSON.stringify(PRINT)} });
			console.log(result.content.find(c => c.type === "text")?.text ?? "");
		`;
		const inherited = Object.fromEntries(KEYS.map(key => [key, `inherited-${key}`]));
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...process.env, ...inherited },
		});
		const output = child.stdout.toString();
		expect(child.exitCode).toBe(0);
		for (const key of KEYS) expect(output).toContain(`${key}=\n`);
		expect(output).not.toContain("inherited-");
	});

	it("refuses a receipt on an async launch", async () => {
		const tool = new BashTool(makeSession(true));
		await expect(
			tool.execute("async", { command: "true", async: true }, undefined, undefined, {
				approvalLaunchEnv: Object.freeze({ ...receipt }),
			} as unknown as AgentToolContext),
		).rejects.toThrow("valid only for one foreground launch");
	});
});
