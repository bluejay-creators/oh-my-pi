import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	ExtensionUIContext,
	NativePromptEvent,
	NativePromptHandle,
	NativePromptKind,
	NativePromptOutcome,
	NativePromptRequest,
} from "./extensions/types";

const promptScope = new AsyncLocalStorage<{
	observer: NativePromptObserver;
	request: NativePromptRequest;
	pending: boolean;
}>();
const UI_PROMPTS: Partial<Record<keyof ExtensionUIContext, { kind: NativePromptKind; optionsIndex: number }>> = {
	select: { kind: "select", optionsIndex: 2 },
	confirm: { kind: "confirm", optionsIndex: 2 },
	input: { kind: "input", optionsIndex: 2 },
	askDialog: { kind: "ask", optionsIndex: 1 },
	approve: { kind: "tool-approval", optionsIndex: 1 },
	editor: { kind: "editor", optionsIndex: 2 },
	custom: { kind: "custom", optionsIndex: 1 },
};

export function createNativePromptRequest(
	sessionId: string,
	kind: NativePromptKind,
	metadata: Pick<NativePromptRequest, "toolCallId" | "toolName"> = {},
): NativePromptRequest {
	const scope = promptScope.getStore();
	const parent = scope?.pending ? scope.request : undefined;
	return Object.freeze({
		requestId: crypto.randomUUID(),
		requestedAt: Date.now(),
		sessionId,
		kind,
		...(parent ? { parentRequestId: parent.requestId } : {}),
		...metadata,
	});
}

/** Observes actual native UI await/callback lifetimes, never payloads or decision authority. */
export class NativePromptObserver {
	readonly #contexts = new WeakMap<ExtensionUIContext, ExtensionUIContext>();
	readonly #pending = new Map<string, NativePromptHandle>();

	constructor(
		private readonly sessionId: () => string,
		private readonly publish: (event: NativePromptEvent) => void,
	) {}

	#emit(event: NativePromptEvent): void {
		try {
			this.publish(Object.freeze(event));
		} catch {
			// Observation must not change an existing UI call or leak its error/payload.
			logger.warn("Native prompt observer failed", { event: event.type });
		}
	}

	getPending(): readonly NativePromptRequest[] {
		return Object.freeze(Array.from(this.#pending.values(), handle => handle.request));
	}

	end(outcome: NativePromptOutcome = "cancelled"): void {
		// Publishing resolution can start another actual UI call. End only the
		// native lifetimes owned at this real teardown, not newly created ones.
		const pending = Array.from(this.#pending.values());
		for (const handle of pending) handle.resolve(outcome);
	}

	begin(
		kind: NativePromptKind,
		options?: { request?: NativePromptRequest; signal?: AbortSignal },
	): NativePromptHandle {
		const request = options?.request ?? createNativePromptRequest(this.sessionId(), kind);
		const scope = { observer: this, request, pending: true };
		const handle: NativePromptHandle = Object.freeze({
			request,
			resolve: (outcome: NativePromptOutcome = "completed") => {
				if (!scope.pending) return;
				scope.pending = false;
				this.#pending.delete(request.requestId);
				this.#emit({
					type: "native_prompt_resolved",
					requestId: request.requestId,
					sessionId: request.sessionId,
					resolvedAt: Date.now(),
					outcome: options?.signal?.aborted ? "cancelled" : outcome,
				});
			},
			run: <T>(action: () => T): T => promptScope.run(scope, action),
		});
		this.#pending.set(request.requestId, handle);
		promptScope.run(scope, () => this.#emit({ type: "native_prompt_requested", request }));
		return handle;
	}

	async observe<T>(
		kind: NativePromptKind,
		action: () => Promise<T>,
		options?: { request?: NativePromptRequest; signal?: AbortSignal },
	): Promise<T> {
		// An approval may call approve/select, and confirm/custom may call lower UI
		// primitives. One actual managed await gets one root, never title-based joins.
		const active = promptScope.getStore();
		if ((active?.observer === this && active.pending) || options?.signal?.aborted) return action();
		const handle = this.begin(kind, options);
		return handle.run(async () => {
			let outcome: NativePromptOutcome = "completed";
			try {
				return await action();
			} catch (error) {
				outcome = options?.signal?.aborted ? "cancelled" : "error";
				throw error;
			} finally {
				handle.resolve(outcome);
			}
		});
	}

	wrapUI(ui: ExtensionUIContext): ExtensionUIContext {
		const cached = this.#contexts.get(ui);
		if (cached) return cached;
		const methods = new Map<PropertyKey, unknown>();
		let unsupportedMethods: Map<PropertyKey, unknown> | undefined;
		const observed = new Proxy(ui, {
			get: (target, property) => {
				const value: unknown = Reflect.get(target, property, target);
				// Optional methods and capability getters remain live, not copied at setup.
				if (typeof value !== "function") return value;
				const definition = Object.hasOwn(UI_PROMPTS, property)
					? UI_PROMPTS[property as keyof ExtensionUIContext]
					: undefined;
				const available =
					definition !== undefined &&
					target.supportsDialogs !== false &&
					(property !== "custom" || target.supportsCustom !== false);
				const cache = definition && !available ? (unsupportedMethods ??= new Map()) : methods;
				const cachedMethod = cache.get(property);
				if (cachedMethod) return cachedMethod;
				const method = value as (...args: unknown[]) => Promise<unknown>;
				const prompt = available ? definition : undefined;
				const bound = prompt
					? (...args: unknown[]) => {
							const options: unknown = args[prompt.optionsIndex];
							const signal =
								options !== null &&
								typeof options === "object" &&
								"signal" in options &&
								options.signal instanceof AbortSignal
									? options.signal
									: undefined;
							return this.observe(prompt.kind, () => method.apply(target, args), { signal });
						}
					: method.bind(target);
				cache.set(property, bound);
				return bound;
			},
		});
		this.#contexts.set(ui, observed);
		this.#contexts.set(observed, observed);
		return observed;
	}
}
