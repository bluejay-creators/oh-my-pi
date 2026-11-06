import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { type Component, Container, isFocusable, type OverlayOptions, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type {
	Extension,
	ExtensionAskDialogQuestion,
	ExtensionUIContext,
	NativePromptEvent,
} from "../../../src/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	let focused: Component | null = editor;
	editor.focused = true;
	const getFocused = () => focused;
	const setFocus = vi.fn((component: Component | null) => {
		if (focused && isFocusable(focused)) focused.focused = false;
		focused = component;
		if (focused && isFocusable(focused)) focused.focused = true;
	});
	const addAutocompleteProvider = vi.fn();
	const fakeHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
	};
	const showOverlay = vi.fn(() => fakeHandle);
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			getFocused,
			setFocus,
			showOverlay,
			terminal: { rows: 40, columns: 120 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		ctx,
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		getFocused,
		setFocus,
		showOverlay,
		fakeHandle,
		controller,
		inputController: (readText: () => Promise<string>) =>
			new InputController(ctx, { readImage: async () => null, readText }),
		handleInput(data: string): void {
			if (!focused?.handleInput) throw new Error("Expected a focused input component");
			focused.handleInput(data);
		},
		getPrompt(): HookEditorComponent {
			if (!(focused instanceof HookEditorComponent)) throw new Error("Expected the custom answer editor");
			return focused;
		},
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

async function makeObservedHarness(onEvent?: (event: NativePromptEvent) => Promise<void>) {
	const harness = makeHarness();
	const ui = await harness.init();
	const events: NativePromptEvent[] = [];
	const handlers: Extension["handlers"] = new Map();
	const record = async (...args: unknown[]): Promise<void> => {
		const event = args[0] as NativePromptEvent;
		events.push(event);
		await onEvent?.(event);
	};
	handlers.set("native_prompt_requested", [record]);
	handlers.set("native_prompt_resolved", [record]);
	const extension: Extension = {
		path: "/test/native-prompt-observer.ts",
		resolvedPath: "/test/native-prompt-observer.ts",
		handlers,
		tools: new Map(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const sessionManager = SessionManager.inMemory();
	const runner = new ExtensionRunner(
		[extension],
		new ExtensionRuntime(),
		sessionManager.getCwd(),
		sessionManager,
		{} as ModelRegistry,
	);
	Object.defineProperty(harness.ctx.session, "extensionRunner", { value: runner });
	return { ...harness, events, runner, ui: runner.observeUIContext(ui), sessionId: sessionManager.getSessionId() };
}

describe("ExtensionUiController native prompt lifecycle", () => {
	it("observes a direct managed confirmation once without exposing its payload or answer", async () => {
		const harness = await makeObservedHarness();
		const before = Date.now();
		const pending = harness.controller.showHookConfirm("private title", "private question");
		expect(harness.events).toHaveLength(1);
		const requested = harness.events[0];
		if (requested?.type !== "native_prompt_requested") throw new Error("Expected a pending prompt");
		expect(requested.request).toEqual({
			requestId: expect.any(String),
			requestedAt: expect.any(Number),
			sessionId: harness.sessionId,
			kind: "confirm",
		});
		expect(requested.request.requestedAt).toBeGreaterThanOrEqual(before);
		harness.handleInput("\r");
		expect(await pending).toBe(true);
		expect(harness.events).toHaveLength(2);
		expect(harness.events[1]).toEqual({
			type: "native_prompt_resolved",
			requestId: requested.request.requestId,
			sessionId: harness.sessionId,
			resolvedAt: expect.any(Number),
			outcome: "completed",
		});
		expect(JSON.stringify(harness.events)).not.toContain("private");
	});

	it("keeps wrapped extension selectors and their raw TUI await in one root", async () => {
		const harness = await makeObservedHarness();
		const pending = harness.ui.select("private selector", ["private answer"]);
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]).toMatchObject({ type: "native_prompt_requested", request: { kind: "select" } });
		harness.handleInput("\r");
		expect(await pending).toBe("private answer");
		expect(harness.events.map(event => event.type)).toEqual(["native_prompt_requested", "native_prompt_resolved"]);
		expect(JSON.stringify(harness.events)).not.toContain("private");
	});

	it("settles an independently queued input on abort without settling the active selector", async () => {
		const harness = await makeObservedHarness();
		const active = new AbortController();
		const queued = new AbortController();
		const first = harness.controller.showHookSelector("active", ["one"], { signal: active.signal });
		const second = harness.controller.showHookInput("queued", undefined, { signal: queued.signal });
		const [firstRequest, secondRequest] = harness.events;
		if (firstRequest?.type !== "native_prompt_requested" || secondRequest?.type !== "native_prompt_requested") {
			throw new Error("Expected concurrent pending prompts");
		}
		expect(firstRequest.request.kind).toBe("select");
		expect(secondRequest.request.kind).toBe("input");
		expect(firstRequest.request.requestId).not.toBe(secondRequest.request.requestId);
		queued.abort();
		expect(await second).toBeUndefined();
		expect(harness.events).toHaveLength(3);
		expect(harness.events[2]).toMatchObject({
			type: "native_prompt_resolved",
			requestId: secondRequest.request.requestId,
			outcome: "cancelled",
		});
		active.abort();
		expect(await first).toBeUndefined();
		expect(harness.events[3]).toMatchObject({
			type: "native_prompt_resolved",
			requestId: firstRequest.request.requestId,
			outcome: "cancelled",
		});
	});

	it("observes raw editor and ask awaits while preserving signal cancellation", async () => {
		const harness = await makeObservedHarness();
		for (const kind of ["editor", "ask"] as const) {
			const abort = new AbortController();
			const pending = kind === "editor"
				? harness.controller.showHookEditor("private editor", "private prefill", { signal: abort.signal })
				: harness.controller.showAskDialog(
						[{ id: "private id", question: "private question", options: [{ label: "private option" }] }],
						{ signal: abort.signal },
					);
			expect(harness.events.at(-1)).toMatchObject({ type: "native_prompt_requested", request: { kind } });
			abort.abort();
			expect(await pending).toBeUndefined();
			expect(harness.events.at(-1)).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		}
		expect(harness.events).toHaveLength(4);
		expect(JSON.stringify(harness.events)).not.toContain("private");
	});

	it("observes one approval root and preserves denial on signal abort", async () => {
		const harness = await makeObservedHarness();
		const abort = new AbortController();
		const pending = harness.controller.showCollabAwareApproval(
			{ compact: "private compact prompt", full: "private full prompt" },
			{ signal: abort.signal },
		);
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]).toMatchObject({
			type: "native_prompt_requested",
			request: { kind: "tool-approval" },
		});
		abort.abort();
		expect(await pending).toBe(false);
		expect(harness.events).toHaveLength(2);
		expect(harness.events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		expect(JSON.stringify(harness.events)).not.toContain("private");
	});

	it("does not wait for a subscribed observer before presenting or settling UI", async () => {
		const observed = Promise.withResolvers<void>();
		const harness = await makeObservedHarness(() => observed.promise);
		try {
			const pending = harness.controller.showHookConfirm("Confirm", "Continue?");
			expect(harness.events).toHaveLength(1);
			harness.handleInput("\r");
			expect(await pending).toBe(true);
			expect(harness.events).toHaveLength(2);
		} finally {
			observed.resolve();
		}
	});

	it("observes custom completion and factory failure without treating all component presence as pending", async () => {
		const harness = await makeObservedHarness();
		const result = { answer: "private result" };
		const pending = harness.ui.custom<typeof result>((_tui, _theme, _keys, done) => {
			done(result);
			return new Container();
		});
		expect(await pending).toBe(result);
		expect(harness.events).toHaveLength(2);
		expect(harness.events[0]).toMatchObject({ type: "native_prompt_requested", request: { kind: "custom" } });
		expect(harness.events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "completed" });
		const failure = new Error("private failure");
		await expect(harness.controller.showHookCustom(() => {
			throw failure;
		})).rejects.toBe(failure);
		expect(harness.events).toHaveLength(4);
		expect(harness.events[3]).toMatchObject({ type: "native_prompt_resolved", outcome: "error" });
		expect(JSON.stringify(harness.events)).not.toContain("private");
	});
});

describe("ExtensionUiController Ask dialog input", () => {
	const questions: ExtensionAskDialogQuestion[] = [
		{ id: "answer", question: "Choose an answer?", options: [{ label: "Default" }] },
	];

	it("waits for clipboard text before advancing the custom answer exactly once", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog([
			{ id: "first", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
			{ id: "second", question: "Next answer?", options: [{ label: "Beta" }, { label: "Gamma" }] },
		]);
		harness.handleInput(" ");
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();

		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\r");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);

		clipboard.resolve("clipboard answer");
		expect(await paste).toBe(true);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [
				{ id: "first", selectedOptions: ["Alpha"], customInput: "clipboard answer" },
				{ id: "second", selectedOptions: ["Gamma"], customInput: undefined },
			],
		});
		expect(harness.editor.getText()).toBe("");
		expect(harness.getFocused()).toBe(harness.editor);
	});

	it("does not expose the Ask dialog before a custom answer is applied", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showAskDialog([
			{ id: "answer", question: "Choose several?", options: [{ label: "Alpha" }], multi: true },
		]);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		harness.handleInput("custom answer");

		harness.handleInput("\r");

		expect(harness.getFocused()).toBeInstanceOf(HookEditorComponent);
		await Promise.resolve();
		expect(harness.getFocused()).toBeInstanceOf(AskDialogComponent);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "custom answer" }],
		});
	});

	it("discards a cancelled prompt's late paste after a new custom editor opens", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const cancelledPrompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		harness.handleInput("\x1b");
		await Promise.resolve();
		await Promise.resolve();

		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		expect(replacement).not.toBe(cancelledPrompt);
		harness.handleInput("replacement answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "replacement answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("discards an aborted Ask's late paste without touching the next Ask or hidden draft", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const abort = new AbortController();
		const pending = harness.controller.showAskDialog(questions, { signal: abort.signal });
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		abort.abort();
		expect(await pending).toBeUndefined();
		expect(harness.getFocused()).toBe(harness.editor);

		const next = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const replacement = harness.getPrompt();
		harness.handleInput("next answer");
		clipboard.resolve("stale clipboard text");
		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(replacement);
		harness.handleInput("\r");

		expect(await next).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "next answer" }],
		});
		expect(harness.editor.getText()).toBe("");
	});

	it("keeps a failed clipboard read editable and discards its queued empty submit", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = harness.inputController(() => clipboard.promise);
		const pending = harness.controller.showAskDialog(questions);
		harness.handleInput("\x1b[B");
		harness.handleInput("\r");
		const prompt = harness.getPrompt();
		const paste = input.handleImagePaste();
		harness.handleInput("\r");
		await Promise.resolve();
		clipboard.reject(new Error("Clipboard unavailable"));

		expect(await paste).toBe(false);
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("typed after failure");
		await Promise.resolve();
		expect(harness.getFocused()).toBe(prompt);
		harness.handleInput("\r");
		expect(await pending).toMatchObject({
			kind: "submit",
			results: [{ id: "answer", selectedOptions: [], customInput: "typed after failure" }],
		});
		expect(harness.editor.getText()).toBe("");
	});
});

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("exposes the draft editor cursor while it proxies input, and drops it once cleared (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// The ask dialog holds TUI focus, but rendering it must mirror focus onto
		// the draft editor so its insertion cursor is visible.
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(true);

		// Once the draft clears, the ask controls take over and the editor cursor
		// must not linger.
		harness.editor.setText("");
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(false);
	});

	it("lets the clear action empty the draft and lift the ask guard (#6738)", () => {
		const harness = makeHarness();
		// Route Ctrl+C to the guard: keep app.clear on Ctrl+C but move the ask
		// cancel key off it, so Ctrl+C reaches draft editing instead of cancelling.
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		harness.editor.setActionKeys("app.clear", ["ctrl+c"]);
		let cleared = 0;
		// Mirror interactive wiring: app.clear (Ctrl+C) clears the draft.
		harness.editor.onClear = () => {
			cleared++;
			harness.editor.setText("");
		};
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+C is reserved by the base editor and never clears; the guard must
		// dispatch the configured clear action so the "finish or clear" hint works.
		ask?.handleInput?.("\x03");
		expect(cleared).toBe(1);
		expect(harness.editor.getText()).toBe("");

		// With the draft gone the guard releases: the next key reaches the ask
		// controls and submits the highlighted option.
		ask?.handleInput?.("\n");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("remounts the draft editor when the ask surface is restored after a nested prompt (#6738)", async () => {
		const harness = makeHarness();
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		// Draft submitted: the guard lifts and ask controls take input; open the
		// note prompt, which swaps the container to the nested editor.
		harness.editor.setText("");
		ask?.handleInput?.("n");
		const promptEditor = harness.editorContainer.children[0];
		expect(promptEditor).not.toBe(ask);

		// A failed async submission restores the draft while the nested prompt is
		// open, re-blocking the guard.
		harness.editor.setText("half typed prompt");

		// Cancelling the nested prompt settles its awaited state before restoring
		// the ask surface and remounting the guarded draft editor.
		promptEditor?.handleInput?.("\x1b");
		await Promise.resolve();
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		ask?.handleInput?.("!");
		expect(harness.editor.getText()).toBe("half typed prompt!");
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

describe("ExtensionUiController custom overlay", () => {
	// showHookCustom mounts the overlay in the `.then` of a Promise.try chain;
	// draining the microtask queue a few times settles it without real timers.
	const flushMicrotasks = async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	};

	it("forwards overlayOptions to showOverlay and invokes onHandle", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const onHandle = vi.fn();
		const overlayOptions: OverlayOptions = {
			anchor: "bottom-center",
			width: "85%",
			maxHeight: "55%",
			margin: { bottom: 1, left: 2, right: 2 },
		};

		ui.custom<void>(() => new Container(), { overlay: true, overlayOptions, onHandle });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
		expect(onHandle).toHaveBeenCalledTimes(1);
		expect(onHandle).toHaveBeenCalledWith(harness.fakeHandle);
	});

	it("resolves overlayOptions factories before showing the overlay", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const overlayOptions: OverlayOptions = { anchor: "top-right", width: 40 };
		const resolveOverlayOptions = vi.fn(() => overlayOptions);

		ui.custom<void>(() => new Container(), {
			overlay: true,
			overlayOptions: resolveOverlayOptions,
		});

		await flushMicrotasks();
		expect(resolveOverlayOptions).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
	});

	it("rejects and restores the editor when a custom factory fails", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const failure = new Error("custom factory failed");

		await expect(ui.custom(() => Promise.reject(failure))).rejects.toBe(failure);

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.setFocus).toHaveBeenLastCalledWith(harness.editor);
	});

	it("aborts a pending custom factory and disposes its late component", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.editor.setText("draft before factory");
		const controller = new AbortController();
		const factory = Promise.withResolvers<Container>();
		const component = new Container() as Container & { dispose: Mock<() => void> };
		component.dispose = vi.fn();

		const pending = ui.custom(() => factory.promise, { signal: controller.signal });
		harness.editor.setText("draft typed while factory is pending");
		controller.abort();

		await expect(pending).rejects.toBe(controller.signal.reason);
		factory.resolve(component);
		await flushMicrotasks();

		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("draft typed while factory is pending");
	});
});
