import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	NativePromptEvent,
	NativePromptOutcome,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as modelPickerModule from "@oh-my-pi/pi-tui/overlays/model-picker";
import * as gitTuiModule from "@oh-my-pi/pi-coding-agent/cli/git-tui";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** The overlay members of `ui` the single-instance guard reads and drives. */
interface OverlayUi {
	overlayStack: TUI["overlayStack"];
	setFocus: (component: Component | null) => void;
	showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
}

/** A `ui` whose overlays live on `overlayStack` as TUI's do: shown on top, removed on hide. */
function overlayUi(): {
	ui: OverlayUi;
	shown: Component[];
	setFocus: OverlayUi["setFocus"];
	overlayStack: TUI["overlayStack"];
} {
	const overlayStack: TUI["overlayStack"] = [];
	const shown: Component[] = [];
	const setFocus = vi.fn<(component: Component | null) => void>();
	const showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options, preFocus: null, hidden: false, released: false };
		overlayStack.push(entry);
		shown.push(component);
		return {
			hide: () => {
				const at = overlayStack.indexOf(entry);
				if (at >= 0) overlayStack.splice(at, 1);
			},
			setHidden: hidden => {
				entry.hidden = hidden;
			},
			isHidden: () => entry.hidden,
		};
	};
	return { shown, setFocus, overlayStack, ui: { overlayStack, setFocus, showOverlay } };
}

/** A context whose session-model picker reads an empty, current catalog. */
function pickerContext(ui: OverlayUi) {
	return createInteractiveModeContext({
		session: {
			model: undefined,
			scopedModels: [],
			getContextUsage: () => undefined,
			getRoleModelCycle: () => undefined,
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => [],
				getAll: () => [],
				refreshIfStale: async () => false,
			},
		},
		ui,
		keybindings: { getKeys: () => [], getDisplayString: () => "" },
	});
}

function observeNativePrompts(ctx: InteractiveModeContext) {
	const events: NativePromptEvent[] = [];
	const record = async (...args: unknown[]): Promise<void> => {
		events.push(args[0] as NativePromptEvent);
	};
	const handlers: Extension["handlers"] = new Map();
	handlers.set("native_prompt_requested", [record]);
	handlers.set("native_prompt_resolved", [record]);
	const extension: Extension = {
		path: "/test/menu-native-prompts.ts",
		resolvedPath: "/test/menu-native-prompts.ts",
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
	const runner = new ExtensionRunner(
		[extension],
		new ExtensionRuntime(),
		ctx.sessionManager.getCwd(),
		ctx.sessionManager,
		ctx.session.modelRegistry,
	);
	Object.defineProperty(ctx.session, "extensionRunner", { value: runner });
	return { events, runner };
}

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("observes explicit agents-hub subforms without observing the passive dashboard lifetime", async () => {
		const { ui } = overlayUi();
		const ctx = createInteractiveModeContext({ ui });
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		let callbacks: Parameters<typeof AgentsHubComponent.create>[2];
		spyOn(AgentsHubComponent, "create").mockImplementation(async (_ui, _deps, supplied) => {
			callbacks = supplied;
			return {
				dispose: () => supplied?.onPromptChange?.(undefined),
			} as AgentsHubComponent;
		});
		await controller.showAgentsDashboard();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		if (!callbacks) throw new Error("Expected agents hub callbacks");
		callbacks.onPromptChange?.("select");
		callbacks.onPromptChange?.("select");
		expect(events).toHaveLength(1);
		expect(runner.getPendingNativePrompts()[0]?.kind).toBe("select");
		callbacks.onPromptChange?.("input");
		expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "completed" });
		expect(runner.getPendingNativePrompts()[0]?.kind).toBe("input");
		callbacks.onPromptChange?.(undefined);
		expect(runner.getPendingNativePrompts()).toEqual([]);
		callbacks.onPromptChange?.("confirm");
		expect(runner.getPendingNativePrompts()[0]?.kind).toBe("confirm");
		callbacks.onCancel();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events).toHaveLength(6);
		expect(events[5]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
	});

	it("observes only explicit Git input modes and settles remaining input on overlay end or error", async () => {
		for (const exit of ["closed", "error"] as const) {
			const ctx = createInteractiveModeContext();
			const { events, runner } = observeNativePrompts(ctx);
			const controller = new SelectorController(ctx);
			const overlay = Promise.withResolvers<void>();
			let inputMode: ((active: boolean) => void) | undefined;
			spyOn(gitTuiModule, "showGitOverlay").mockImplementation(async (_ui, options) => {
				inputMode = options?.onInputModeChange;
				await overlay.promise;
			});
			const showing = controller.showGitTui();
			expect(runner.getPendingNativePrompts()).toEqual([]);
			if (!inputMode) throw new Error("Expected explicit Git input callback");
			inputMode(true);
			inputMode(true);
			expect(runner.getPendingNativePrompts()).toHaveLength(1);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: "native_prompt_requested", request: { kind: "input" } });
			inputMode(false);
			expect(runner.getPendingNativePrompts()).toEqual([]);
			expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "completed" });
			inputMode(true);
			if (exit === "error") overlay.reject(new Error("private Git failure"));
			else overlay.resolve();
			await showing;
			expect(runner.getPendingNativePrompts()).toEqual([]);
			expect(events[3]).toMatchObject({
				type: "native_prompt_resolved",
				outcome: exit === "error" ? "error" : "cancelled",
			});
			expect(JSON.stringify(events)).not.toContain("private");
		}
	});

	it("settles model selection before applying it and starts a fresh prompt only when failure returns to input", async () => {
		const { ui, overlayStack } = overlayUi();
		const ctx = pickerContext(ui);
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		const selectedModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!selectedModel) throw new Error("Expected a bundled model");
		const apply = Promise.withResolvers<void>();
		ctx.session.resolveTemporaryModelThinkingLevel = () => ThinkingLevel.Off;
		ctx.session.setModelTemporary = async () => apply.promise;
		let callbacks: modelPickerModule.ModelPickerCallbacks | undefined;
		spyOn(modelPickerModule, "ModelPickerComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelPickerModule.ModelPickerCallbacks;
			return new Container();
		} as never);
		controller.showModelSelector({ temporaryOnly: true });
		if (!callbacks) throw new Error("Expected picker callbacks");
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		const selection = callbacks.onPick(selectedModel, "anthropic/claude-sonnet-4-5", { overContext: false });
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(overlayStack).toHaveLength(1);
		expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "completed" });
		apply.reject(new Error("private model failure"));
		await selection;
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		expect(events[2]).toMatchObject({ type: "native_prompt_requested", request: { kind: "select" } });
		callbacks.onCancel();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events[3]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		expect(JSON.stringify(events)).not.toContain("private");
	});

	it("observes settings only when opened, retains one identity on refocus, and closes on its actual cancel", async () => {
		const themes = Promise.withResolvers<string[]>();
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes.promise);
		const { ui, shown } = overlayUi();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui,
		});
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		controller.showSettingsSelector();
		expect(events).toEqual([]);
		expect(runner.getPendingNativePrompts()).toEqual([]);
		themes.resolve(["dark"]);
		await themes.promise;
		const request = events[0];
		if (request?.type !== "native_prompt_requested") throw new Error("Expected settings to open");
		expect(request.request.kind).toBe("custom");
		expect(runner.getPendingNativePrompts()).toEqual([request.request]);
		controller.showSettingsSelector();
		expect(shown).toHaveLength(1);
		expect(events).toHaveLength(1);
		shown[0]?.handleInput?.("\x1b");
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events[1]).toMatchObject({
			type: "native_prompt_resolved",
			requestId: request.request.requestId,
			outcome: "cancelled",
		});
	});

	it("observes callback selector completion, cancellation, and construction errors without changing callbacks", () => {
		const ctx = createInteractiveModeContext();
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		const previous = [...ctx.editorContainer.children];
		let finish: ((outcome?: NativePromptOutcome) => void) | undefined;
		const component = new Text("private selection");
		controller.showSelector(done => {
			finish = done;
			return { component, focus: component };
		});
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		expect(ctx.editorContainer.children).toEqual([component]);
		if (!finish) throw new Error("Expected a completion callback");
		finish();
		finish();
		expect(ctx.editorContainer.children).toEqual(previous);
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "completed" });
		controller.showSelector(done => {
			finish = done;
			return { component, focus: component };
		});
		finish("cancelled");
		expect(events[3]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		const failure = new Error("private construction error");
		expect(() =>
			controller.showSelector(() => {
				throw failure;
			}),
		).toThrow(failure);
		expect(events[5]).toMatchObject({ type: "native_prompt_resolved", outcome: "error" });
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(JSON.stringify(events)).not.toContain("private");
	});

	it("keeps temporarily nested slot selectors pending until their own completion callbacks", () => {
		const ctx = createInteractiveModeContext();
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		const first = new Text("first");
		const second = new Text("second");
		let finishFirst: (() => void) | undefined;
		let finishSecond: (() => void) | undefined;
		controller.showSelector(done => {
			finishFirst = done;
			return { component: first, focus: first };
		});
		controller.showSelector(done => {
			finishSecond = done;
			return { component: second, focus: second };
		});
		expect(runner.getPendingNativePrompts()).toHaveLength(2);
		if (!finishFirst || !finishSecond) throw new Error("Expected both callbacks");
		finishSecond();
		expect(ctx.editorContainer.children).toEqual([first]);
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		finishFirst();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events).toHaveLength(4);
	});

	it("ends a nested selector when an older selector's actual completion replaces its slot", () => {
		const ctx = createInteractiveModeContext();
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		const component = new Container();
		let finishFirst: (() => void) | undefined;
		controller.showSelector(done => {
			finishFirst = done;
			return { component, focus: component };
		});
		controller.showSelector(() => ({ component: new Container(), focus: component }));
		expect(runner.getPendingNativePrompts()).toHaveLength(2);
		if (!finishFirst) throw new Error("Expected first completion");
		finishFirst();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(
			events.slice(2).map(event => (event.type === "native_prompt_resolved" ? event.outcome : event.type)),
		).toEqual(["cancelled", "completed"]);
	});

	it("settles a displaced selector at actual raw-dialog presentation, not at arbitrary component presence", async () => {
		const ctx = createInteractiveModeContext();
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		controller.showSelector(() => {
			const component = new Container();
			return { component, focus: component };
		});
		const extensions = new ExtensionUiController(ctx, () => controller.endSelectorPrompts());
		const abort = new AbortController();
		const pending = extensions.showHookInput("private input", undefined, { signal: abort.signal });
		expect(events[2]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		expect(runner.getPendingNativePrompts()[0]?.kind).toBe("input");
		abort.abort();
		expect(await pending).toBeUndefined();
		expect(runner.getPendingNativePrompts()).toEqual([]);
	});

	it("ends pending callback observation at mode teardown without invoking the UI's completion callback", () => {
		const ctx = createInteractiveModeContext();
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		const component = new Container();
		let finish: (() => void) | undefined;
		controller.showSelector(done => {
			finish = done;
			return { component, focus: component };
		});
		controller.endNativePrompts();
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(ctx.editorContainer.children).toEqual([component]);
		expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
		if (!finish) throw new Error("Expected original UI callback");
		finish();
		expect(events).toHaveLength(2);
		controller.startNativePromptObservation();
		controller.showSelector(() => ({ component, focus: component }));
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		controller.endNativePrompts();
	});

	it("observes model-picker cancellation without opening another root on refocus", () => {
		const { ui, shown } = overlayUi();
		const ctx = pickerContext(ui);
		const { events, runner } = observeNativePrompts(ctx);
		const controller = new SelectorController(ctx);
		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(events).toHaveLength(1);
		expect(runner.getPendingNativePrompts()).toHaveLength(1);
		shown[0]?.handleInput?.("\x1b");
		expect(runner.getPendingNativePrompts()).toEqual([]);
		expect(events[1]).toMatchObject({ type: "native_prompt_resolved", outcome: "cancelled" });
	});

	// Regression: a second /settings (typed while theme discovery was pending, or
	// from Tern's native composer while the menu was open) stacked another
	// fullscreen settings menu on top of the first.
	it("focuses the open menu instead of stacking a second one", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus,
			},
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(overlays).toHaveLength(1);
		controller.showSettingsSelector();
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));

		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
	});

	it("raises an open model picker another overlay covers instead of focusing it hidden", () => {
		const { ui, overlayStack } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));
		controller.showModelSelector({ temporaryOnly: true });
		const picker = overlayStack[0]?.component;
		ui.showOverlay({ render: () => [], invalidate: () => {} });

		controller.showModelSelector({ temporaryOnly: true });
		expect(overlayStack).toHaveLength(2);
		expect(overlayStack.at(-1)?.component).toBe(picker);
	});

	it("opens one agents dashboard while it loads, and opens again after a failed load", async () => {
		const { ui, shown } = overlayUi();
		const controller = new SelectorController(createInteractiveModeContext({ ui }));
		const failed = Promise.withResolvers<AgentsHubComponent>();
		const create = spyOn(AgentsHubComponent, "create").mockReturnValue(failed.promise);

		const first = controller.showAgentsDashboard();
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(1);
		failed.reject(new Error("discovery failed"));
		await expect(first).rejects.toThrow("discovery failed");

		create.mockResolvedValue(Object.create(AgentsHubComponent.prototype));
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(2);
		expect(shown).toHaveLength(1);
	});

	// Regression: a second /usage (or status-line cost click) while the dashboard
	// was open stacked another fullscreen dashboard on top of the first.
	it("opens one usage dashboard per close, focusing it on repeat requests", () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: {
					model: undefined,
					getUsageReportingModelSelectors: () => [],
					fetchUsageReports: async () => null,
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				ui,
			}),
		);
		const reports = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];

		controller.showUsageDashboard(reports);
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(2);
	});
});
