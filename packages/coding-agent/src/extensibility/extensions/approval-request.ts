import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { NativePromptRequest, ToolApprovalDeciderResult, ToolApprovalInput, ToolApprovalRequest } from "./types";

type ApprovalContext = Omit<ToolApprovalRequest, "requestId" | "requestedAt" | "fingerprint" | "arguments"> & {
	arguments: unknown;
};

/** Reject values JSON would silently omit/coerce, accessors and non-JSON objects. */
function snapshotInput(value: unknown, ancestors = new Set<object>()): ToolApprovalInput {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
	if (typeof value !== "object" || value === null || ancestors.has(value)) {
		throw new TypeError("Approval arguments must be lossless JSON");
	}
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (!array && prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Approval arguments must be plain JSON objects");
	}
	ancestors.add(value);
	try {
		const snapshot: Record<string, ToolApprovalInput> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			if (array && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
				throw new TypeError("Approval arguments must have enumerable data properties");
			}
			snapshot[key] = snapshotInput(descriptor.value, ancestors);
		}
		if (!array) return Object.freeze(snapshot);
		if (Object.keys(snapshot).length !== value.length) throw new TypeError("Sparse approval arguments");
		const items: ToolApprovalInput[] = [];
		for (let index = 0; index < value.length; index++) {
			if (!Object.hasOwn(snapshot, index)) throw new TypeError("Non-JSON array properties");
			items.push(snapshot[index]);
		}
		return Object.freeze(items);
	} finally {
		ancestors.delete(value);
	}
}

function fingerprint(requestId: string, requestedAt: number, context: ApprovalContext): string {
	return new Bun.CryptoHasher("sha256").update(stableStringifyJson({ requestId, requestedAt, ...context })).digest("hex");
}

/** Internal lifecycle: no registry, reusable token, or externally callable resolver. */
export class PendingToolApproval {
	readonly request: ToolApprovalRequest | undefined;
	#pending = true;

	constructor(
		private readonly current: () => ApprovalContext,
		private readonly signal: AbortSignal | undefined,
		identity: Pick<NativePromptRequest, "requestId" | "requestedAt">,
	) {
		try {
			const context = current();
			if (!context.sessionId || !context.cwd || signal?.aborted) return;
			const snapshot = { ...context, arguments: snapshotInput(context.arguments) };
			const { requestId, requestedAt } = identity;
			this.request = Object.freeze({
				...snapshot, requestId, requestedAt, fingerprint: fingerprint(requestId, requestedAt, snapshot),
			});
		} catch {
			// Unsupported execution arguments retain the ordinary human approval path.
		}
	}

	matches(): boolean {
		if (!this.request || this.signal?.aborted) return false;
		try {
			const context = this.current();
			return this.request.fingerprint === fingerprint(this.request.requestId, this.request.requestedAt, {
				...context,
				arguments: snapshotInput(context.arguments),
			});
		} catch {
			return false;
		}
	}

	consume(result: ToolApprovalDeciderResult | undefined): boolean {
		const pending = this.#pending;
		this.close();
		return pending && result?.decision === "approve-once" && this.request !== undefined &&
			result.requestId === this.request.requestId && result.fingerprint === this.request.fingerprint && this.matches();
	}

	close(): void {
		this.#pending = false;
	}
}
