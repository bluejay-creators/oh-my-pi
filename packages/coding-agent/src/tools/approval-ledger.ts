import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, watch } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { serialize } from "node:v8";
import { all as allSettings } from "../config/registry";
import type { Settings } from "../config/settings";
import { evaluateNativeGrant, type VerifiedNativeGrant } from "./approval-ledger-policy";

/** Only actual kernel permission/config/consent owners register these facts. Display metadata is not authority. */
export interface NativeApprovalFacts {
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly settings: Settings;
	readonly getArguments: () => unknown;
	readonly getCwd: () => string;
	readonly getCommand?: () => string | undefined;
	readonly isCurrent?: () => boolean;
	readonly execution?: NativeExecutionScope;
}

export interface NativeApprovalRequest {
	readonly schema: "firstmate.native-approval-request.v1";
	readonly sessionId: string;
	readonly approvalId: string;
	readonly kind: "tool" | "settings" | "consent";
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly cwd: string;
	readonly command?: string;
	readonly argumentsSha256: string;
	readonly promptSha256: string;
	readonly environmentSha256: string;
	readonly repository?: { readonly root: string; readonly head: string };
}

interface BridgeConfig {
	readonly filename: string;
	readonly digest: string;
	readonly mode: "shadow" | "enforce";
	readonly store: string;
	readonly legacyImportEnabled: boolean;
	readonly python: string;
	readonly program: string;
	readonly programSha256: string;
}

const factsByOwner = new WeakMap<object, NativeApprovalFacts>();
const ledgerResolutions = new WeakMap<object, NativeApprovalLease>();
const execution = new AsyncLocalStorage<NativeExecutionScope>();
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1_048_576;
const CONFIG_ENV = "OMP_APPROVAL_LEDGER_CONFIG";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter(key => record[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	const result = JSON.stringify(value);
	if (result === undefined) throw new Error("Unsupported native consent binding");
	return result;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOwned(filename: string, secret: boolean): Promise<Buffer> {
	if (!path.isAbsolute(filename) || process.getuid === undefined)
		throw new Error("Absolute POSIX consent path required");
	const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.uid !== process.getuid() ||
			(info.mode & (secret ? 0o077 : 0o022)) !== 0 ||
			info.size > MAX_BYTES
		) {
			throw new Error("Unsafe native consent file ownership, mode, or size");
		}
		return await file.readFile();
	} finally {
		await file.close();
	}
}

// Final admission cannot await: resolution handlers have already run, and the
// current context must remain checked through the synchronous mutation boundary.
function readOwnedSync(filename: string, secret: boolean): Buffer {
	if (!path.isAbsolute(filename) || process.getuid === undefined)
		throw new Error("Absolute POSIX consent path required");
	const file = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(file);
		if (
			!info.isFile() ||
			info.uid !== process.getuid() ||
			(info.mode & (secret ? 0o077 : 0o022)) !== 0 ||
			info.size > MAX_BYTES
		) {
			throw new Error("Unsafe native consent file ownership, mode, or size");
		}
		return readFileSync(file);
	} finally {
		closeSync(file);
	}
}

async function readConfig(): Promise<BridgeConfig> {
	const filename = process.env[CONFIG_ENV];
	if (!filename) throw new Error("Native consent bridge is not configured");
	const bytes = await readOwned(filename, true);
	const config: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!object(config) ||
		config.schema !== "firstmate.approval-ledger-config.v1" ||
		(config.mode !== "shadow" && config.mode !== "enforce") ||
		typeof config.store !== "string" ||
		!path.isAbsolute(config.store) ||
		!object(config.nativeBridge)
	)
		throw new Error("Invalid native consent configuration");
	const bridge = config.nativeBridge;
	if (
		typeof bridge.python !== "string" ||
		!path.isAbsolute(bridge.python) ||
		typeof bridge.program !== "string" ||
		!path.isAbsolute(bridge.program) ||
		typeof bridge.sha256 !== "string" ||
		!SHA256.test(bridge.sha256)
	)
		throw new Error("Pinned native consent helper required");
	if (hash(await readOwned(bridge.program, false)) !== bridge.sha256)
		throw new Error("Native consent helper bytes changed");
	return {
		filename,
		digest: hash(bytes),
		mode: config.mode,
		store: config.store,
		legacyImportEnabled: typeof config.legacyImporter === "string" && config.legacyImporter.length > 0,
		python: bridge.python,
		program: bridge.program,
		programSha256: bridge.sha256,
	};
}

export function nativeLedgerConfigured(): boolean {
	return Boolean(process.env[CONFIG_ENV]);
}

export function bindNativeApproval(owner: object, facts: NativeApprovalFacts): void {
	if (nativeLedgerConfigured())
		factsByOwner.set(owner, facts.execution ? facts : { ...facts, execution: execution.getStore() });
}

/** Recheck the bound execution context synchronously before applying a ledger-supplied choice. */
export function nativeLedgerChoiceIsCurrent(owner: object): boolean {
	return ledgerResolutions.get(owner)?.contextCurrent() ?? true;
}

async function invoke(
	config: BridgeConfig,
	operation: string,
	flag: string,
	value: unknown,
	extra: string[] = [],
): Promise<Record<string, unknown>> {
	if (
		hash(await readOwned(config.filename, true)) !== config.digest ||
		hash(await readOwned(config.program, false)) !== config.programSha256
	)
		throw new Error("Native consent configuration or helper changed");
	const child = Bun.spawn(
		[config.python, config.program, "--config", config.filename, operation, flag, "-", ...extra],
		{
			stdin: Buffer.from(JSON.stringify(value)),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code === 75) return { decision: "prompt", reason: "ledger-busy" };
	if (code !== 0) throw new Error(`Native consent helper ${operation} failed (${code}): ${stderr.trim()}`);
	const result: unknown = JSON.parse(stdout);
	if (!object(result)) throw new Error("Invalid native consent helper response");
	return result;
}

async function repository(cwd: string): Promise<NativeApprovalRequest["repository"]> {
	const child = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel", "HEAD"], {
		stdout: "pipe",
		stderr: "ignore",
		timeout: 5_000,
	});
	const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0) return undefined;
	const [root, head, extra] = output.trimEnd().split("\n");
	if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{40,64}$/.test(head ?? "") || extra !== undefined)
		return undefined;
	return Object.freeze({ root, head });
}

function environment(settings: Settings, config: BridgeConfig): string {
	// Raw values stay in process. Persist only an opaque hash, including effective
	// settings and the exact bridge configuration; a setting/profile change invalidates admission.
	return hash(
		serialize({
			env: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
			settings: allSettings().map(setting => [setting.id, setting.get(settings)]),
			bridge: config.digest,
		}),
	);
}

function verifiedGrant(value: unknown): VerifiedNativeGrant | undefined {
	if (
		!object(value) ||
		!object(value.subject) ||
		value.subject.type !== "NativeSession" ||
		typeof value.subject.id !== "string" ||
		!value.subject.id ||
		typeof value.scope !== "string" ||
		!SHA256.test(value.scope) ||
		value.delegable !== false ||
		value.tenant !== "work" ||
		value.uses !== 1 ||
		!Number.isSafeInteger(value.expiresAt) ||
		(value.mode !== "shadow" && value.mode !== "enforce")
	)
		return undefined;
	return value as unknown as VerifiedNativeGrant;
}

/** Tracks observed native tool returns/throws, not success or external side effects. */
export class NativeExecutionScope {
	#approved:
		| Map<
				string,
				{
					config: BridgeConfig;
					request: NativeApprovalRequest;
					report: (message: string) => void;
					isCurrent?: () => boolean;
				}
		  >
		| undefined;
	observe(
		config: BridgeConfig,
		request: NativeApprovalRequest,
		report: (message: string) => void,
		isCurrent?: () => boolean,
	): void {
		(this.#approved ??= new Map()).set(hash(canonical(request)), { config, request, report, isCurrent });
	}
	run<T>(callback: () => Promise<T>): Promise<T> {
		if (this.#approved) {
			for (const admission of this.#approved.values()) {
				if (admission.isCurrent?.() === false)
					throw new Error("Native consent context changed or became unavailable before tool execution");
			}
		}
		return execution.run(this, callback);
	}
	async result(outcome: "returned" | "threw"): Promise<void> {
		if (!this.#approved) return;
		for (const { config, request, report } of this.#approved.values()) {
			try {
				const recorded = await invoke(config, "execution", "--receipt", {
					native: request,
					outcome,
					source: "native-tool-wrapper",
				});
				if (recorded.resultObserved !== true) throw new Error("Tool result record was not committed");
			} catch (error) {
				// Metadata failure must not turn a completed tool into an apparent
				// execution failure that invites a second execution.
				report(
					`Native tool result remains unrecorded: ${error instanceof Error ? error.message : "unknown error"}`,
				);
			}
		}
	}
}

export function createNativeExecutionScope(): NativeExecutionScope | undefined {
	return nativeLedgerConfigured() ? new NativeExecutionScope() : undefined;
}

export interface NativeLeaseOptions {
	readonly owner: object;
	readonly id: string;
	readonly sessionId: string;
	readonly settings: Settings;
	readonly kind: NativeApprovalRequest["kind"];
	readonly prompt: string;
	readonly onceChoice: string;
	readonly denyChoice: string;
	readonly choices: readonly string[];
	readonly isCurrent: () => boolean;
	readonly reportUnavailable: (message: string) => void;
}

/** No title matching, pane targeting, key injection, broad session grants, or inferred script authority. */
export async function prepareNativeApproval(options: NativeLeaseOptions): Promise<NativeApprovalLease | undefined> {
	if (!nativeLedgerConfigured()) return undefined;
	if (!options.isCurrent()) return undefined;
	const facts = factsByOwner.get(options.owner);
	if (
		!facts ||
		facts.sessionId !== options.sessionId ||
		facts.settings !== options.settings ||
		!options.choices.includes(options.onceChoice) ||
		!options.choices.includes(options.denyChoice)
	)
		return undefined;
	const config = await readConfig();
	const cwd = await realpath(facts.getCwd());
	const command = facts.getCommand?.();
	const repo = await repository(cwd);
	if (!repo) return undefined;
	const request: NativeApprovalRequest = Object.freeze({
		schema: "firstmate.native-approval-request.v1",
		sessionId: facts.sessionId,
		approvalId: options.id,
		kind: options.kind,
		toolName: facts.toolName,
		...(facts.toolCallId ? { toolCallId: facts.toolCallId } : {}),
		cwd,
		...(command !== undefined ? { command } : {}),
		argumentsSha256: hash(serialize(facts.getArguments())),
		promptSha256: hash(options.prompt),
		environmentSha256: environment(facts.settings, config),
		repository: repo,
	});
	const observed = await invoke(config, "observe", "--request", request, ["--outcome", "pending"]);
	if (observed.phase !== "pending") return undefined;
	return new NativeApprovalLease(config, facts, request, options);
}

export class NativeApprovalLease {
	readonly request: NativeApprovalRequest;
	#hash: string;
	#active = true;
	#remoteChoice = false;
	#config: BridgeConfig;
	#facts: NativeApprovalFacts;
	#options: NativeLeaseOptions;

	get mode(): "shadow" | "enforce" {
		return this.#config.mode;
	}

	constructor(
		config: BridgeConfig,
		facts: NativeApprovalFacts,
		request: NativeApprovalRequest,
		options: NativeLeaseOptions,
	) {
		this.#config = config;
		this.#facts = facts;
		this.request = request;
		this.#options = options;
		this.#hash = hash(canonical(request));
	}

	contextCurrent(): boolean {
		try {
			return (
				this.#facts.isCurrent?.() !== false &&
				realpathSync(this.#facts.getCwd()) === this.request.cwd &&
				hash(readOwnedSync(this.#config.filename, true)) === this.#config.digest &&
				hash(readOwnedSync(this.#config.program, false)) === this.#config.programSha256 &&
				hash(serialize(this.#facts.getArguments())) === this.request.argumentsSha256 &&
				environment(this.#facts.settings, this.#config) === this.request.environmentSha256
			);
		} catch {
			return false;
		}
	}

	async #current(): Promise<boolean> {
		return (
			this.#active &&
			this.#options.isCurrent() &&
			this.#facts.isCurrent?.() !== false &&
			(await realpath(this.#facts.getCwd())) === this.request.cwd &&
			hash(serialize(this.#facts.getArguments())) === this.request.argumentsSha256 &&
			environment(this.#facts.settings, this.#config) === this.request.environmentSha256 &&
			hash(await readOwned(this.#config.filename, true)) === this.#config.digest
		);
	}

	async #evaluate(candidate: Record<string, unknown>) {
		const evaluation = await evaluateNativeGrant({
			sessionId: this.request.sessionId,
			requestHash: this.#hash,
			toolName: this.request.toolName,
			mode: this.#config.mode,
			nativePending: this.#active,
			resourceCurrent: candidate.decision === "would-release" && (await this.#current()),
			baselinePermitted: true,
			legacyImportEnabled: this.#config.legacyImportEnabled,
			evidenceKind: typeof candidate.evidenceKind === "string" ? candidate.evidenceKind : "none",
			grant: candidate.decision === "would-release" ? verifiedGrant(candidate.grant) : undefined,
		});
		const trace = await invoke(this.#config, "trace", "--record", { native: this.request, evaluation });
		if (trace.recorded !== true) return undefined;
		return evaluation;
	}

	/** The returned label is one of this exact owner's offered once/deny choices, never a session grant. */
	async show(show: (signal: AbortSignal) => Promise<string | undefined>): Promise<string | undefined> {
		const abort = new AbortController();
		let resolveRemote!: (value: { choice: string; remote: true }) => void;
		const remote = new Promise<{ choice: string; remote: true }>(resolve => {
			resolveRemote = resolve;
		});
		let action: string | undefined;
		let running = false;
		let dirty = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let stamp = "";
		let pending: Promise<void> | undefined;
		const failures = new Set<string>();
		const report = (error: unknown) => {
			const message = error instanceof Error ? error.message : "unknown error";
			if (!failures.has(message)) {
				failures.add(message);
				this.#options.reportUnavailable(`Native consent unavailable: ${message}`);
			}
		};
		const runCheck = async () => {
			try {
				const candidate = await invoke(this.#config, "check", "--request", this.request);
				if (!this.#active) return;
				if (typeof candidate.action === "string" && SHA256.test(candidate.action)) action = candidate.action;
				if (candidate.reason === "ledger-busy") {
					retry ??= setTimeout(() => {
						retry = undefined;
						void check();
					}, 250);
					return;
				}
				const evaluation = await this.#evaluate(candidate);
				if (evaluation === undefined) {
					retry ??= setTimeout(() => {
						retry = undefined;
						void check();
					}, 250);
					return;
				}
				if (!this.#active || this.#config.mode !== "enforce") return;
				if (candidate.decision === "deny") {
					resolveRemote({ choice: this.#options.denyChoice, remote: true });
					return;
				}
				if (evaluation?.decision !== "allow" || !(await this.#current())) return;
				const consumed = await invoke(this.#config, "consume", "--request", this.request);
				if (consumed.decision === "allow-once" && consumed.action === action && (await this.#current())) {
					resolveRemote({ choice: this.#options.onceChoice, remote: true });
				} else if (consumed.reason === "ledger-busy") {
					retry ??= setTimeout(() => {
						retry = undefined;
						void check();
					}, 250);
				}
			} catch (error) {
				// No unverifiable answer becomes admission. The ordinary original widget remains.
				report(error);
			} finally {
				running = false;
				if (dirty && this.#active) {
					dirty = false;
					void check();
				}
			}
		};
		const check = () => {
			if (!this.#active) return pending;
			if (running) {
				dirty = true;
				return pending;
			}
			running = true;
			pending = runCheck();
			return pending;
		};
		const names = () => [`request-${this.#hash}.json`, ...(action ? [`${action}.json`] : [])];
		const refresh = async () => {
			const next = (
				await Promise.all(
					names().map(async name => {
						try {
							const info = await lstat(path.join(this.#config.store, name));
							return `${name}:${info.ino}:${info.mtimeMs}:${info.size}`;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${name}:absent`;
							throw error;
						}
					}),
				)
			).join("|");
			if (this.#active && next !== stamp) {
				stamp = next;
				await check();
			}
		};
		let watcher: ReturnType<typeof watch> | undefined;
		try {
			watcher = watch(this.#config.store, (_event, filename) => {
				if (filename === null || names().includes(filename.toString())) void refresh().catch(report);
			});
			watcher.on("error", error => {
				report(error);
				watcher?.close();
			});
		} catch (error) {
			report(error);
		}
		const poll = setInterval(() => {
			void refresh().catch(report);
		}, 1_000);
		const local = show(abort.signal).then(choice => ({ choice, remote: false as const }));
		void refresh().catch(report);
		try {
			const result = await Promise.race([local, remote]);
			if (result.remote) {
				this.#remoteChoice = true;
				abort.abort();
				await local;
			}
			return result.choice;
		} finally {
			this.#active = false;
			abort.abort();
			watcher?.close();
			clearInterval(poll);
			clearTimeout(retry);
			await pending;
		}
	}

	async close(outcome: "approved" | "denied" | "cancelled" | "timeout" | "unavailable"): Promise<string> {
		const result = await invoke(this.#config, "observe", "--request", this.request, ["--outcome", outcome]);
		if (typeof result.phase !== "string") throw new Error("Native consent outcome was not recorded");
		if (this.#remoteChoice || (result.phase === "denied" && outcome === "approved"))
			ledgerResolutions.set(this.#options.owner, this);
		if (result.phase === "approved")
			this.#facts.execution?.observe(
				this.#config,
				this.request,
				this.#options.reportUnavailable,
				this.#remoteChoice ? () => this.contextCurrent() : undefined,
			);
		return result.phase;
	}
}
