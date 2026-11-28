import {
	type BashToolDetails,
	formatBackgroundNotice,
	formatWallTimeNotice,
	formatExitCodeNotice,
	WALL_TIME_NOTICE_MIN_MS,
} from "./details/bash";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GIT_PUSH_CONFIG_PATTERN, isGitPushBranchConfigSafe, parseGitPushConfig } from "./bash-git-push-config";
import { isReadOnlyGitApprovalArgv } from "./bash-git-readonly";
import { resolveTrustedApprovalExecutable } from "./bash-executable-trust";
import { unwrapOrdinaryApprovalEnv } from "./bash-env-wrapper";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { PipeStreams, repairHeredocContinuations, type ShellCommands, shellBuiltins } from "@oh-my-pi/pi-natives";
import { $which, isEnoent, logger, prompt, spillUrl } from "@oh-my-pi/pi-utils";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isPosixShell } from "@oh-my-pi/pi-utils/procmgr";
import {
	compileNotifyPattern,
	formatAsyncJobLabel,
	type NotifyPattern,
	OutputNotifier,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import { shellChangeSnapshots } from "../commit/selective/journal";
import { type BoardEntry, registerOnBoard } from "../daemon/client";
import { applyDirenvPreflight, type BashResult, executeBash, sessionShellEnv } from "../exec/bash-executor";
import { BASH_SESSION_ENV } from "../exec/session-processes";
import { shellMounts, shellProcessCommand } from "../exec/shell-process";
import { createToolCommandHandler, toolCommandNames } from "../exec/tool-command-host";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import {
	InternalUrlFilesystem,
	type InternalUrlFilesystemOptions,
	type UrlWriteReport,
	UrlFsError,
} from "../internal-urls/url-filesystem";
import { PipeTextSources, TextTap } from "../job-widgets";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type {
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "./streaming-output";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { appendImageLinks } from "../utils/image-temp";
import type { ToolSession } from ".";
import { owningSessionId } from "./session-id";
import { truncateForPrompt } from "./approval";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import type { ShellTrace } from "@oh-my-pi/pi-wire";
import { applyPatchShellInput } from "./bash-apply-patch";
import { hostCommandUrls, urlBacking } from "./bash-host-urls";
import { checkBashInterception } from "./bash-interceptor";
import { rewriteGitWorktreeAdd } from "./bash-worktree-rewrite";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { resolveEvalBackends } from "./eval-backends";
import { invalidateGithubCacheForBashCommand, invalidateGithubCacheForBashResult } from "./gh-cache-invalidation";
import { serviceLogs, startService, type ServiceReady } from "../launch/services";
import { O2CTL_COMMAND, runO2ctlCommand } from "../launch/o2ctl-command";
import { findHintVisible } from "./jfind";
import { formatArtifactErrorNotice } from "./output-meta-format";
import { formatOutputNotice } from "./output-meta-format";
import { outputMeta, resolveInlineByteCapBudget } from "./output-meta";
import { resolveShellDirectory, resolveToCwd } from "./path-utils";
import {
	BASH_APPROVAL_SHELL_CONTROL_CHARS,
	type ApprovalShellSegment,
	type QuotedHeredocBody,
	extractApprovalShellSegments,
	extractLegacyApprovalShellSegments,
	extractSimpleApprovalShellSegments,
	extractAndChainSegments,
	extractLeadingCdTarget,
	isShellEnvironmentAssignment,
	lexShellCommand,
	tokenizeShellSegments,
	withoutLeadingEnvironmentAssignments,
} from "./shell-tokenize";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";
import type { ToolCommandDispatch } from "./tool-commands";

import {
	cfgAstEditEnabled,
	cfgAstGrepEnabled,
	cfgAsyncEnabled,
	cfgGlobEnabled,
	cfgGrepEnabled,
	cfgLaunchEnabled,
	cfgToolsMaxTimeout,
} from "./settings";
import {
	type BashApprovalPatternRule,
	type BashPatternApproval,
	cfgBashAllowedEnvVars,
	cfgBashAllowCompoundCommands,
	cfgBashAutoBackgroundEnabled,
	cfgBashAutoBackgroundThresholdMs,
	cfgBashDirenv,
	cfgBashDirenvLoadTimeoutMs,
	cfgBashGitGuard,
	cfgBashInterceptorEnabled,
	cfgBashInterceptorPatterns,
	cfgBashPatterns,
} from "../exec/settings";
import { cfgDisplayShellVisualization } from "../modes/settings";
import { cfgSkillful } from "../session/settings";
import { cfgWorktreeClone, ovnfsCommand } from "../task/settings";
import { sessionShellSpeech } from "../tts/shell-speech";
import { nativeShapingOff, shapeToolText, shapingExperiment } from "../spotlight";
import { SPOTLIGHT_FULL_OUTPUT_MAX_BYTES } from "../spotlight/types";
import type { SpotlightDetails } from "./details/spotlight";

const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^- \t]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code.
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

const BASH_PATTERN_APPROVAL_VALUES = new Set(["allow", "deny", "prompt"]);

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows
 * (`cmd.exe /c` as the last-resort fallback when no bash exists on the host),
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) wherever a POSIX shell is available. The agent host's shell path is
 * used as a proxy for the client's, matching the near-universal ACP
 * deployment shape of an editor spawning omp as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight — the cost of a false negative is data loss or a compromised host,
 * while false positives remain actionable through user policy control.
 * New patterns should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	// Options may sit on either side of the recursive/force flag, so only that flag is pinned and
	// any other options are skipped: `rm -rf /`, `rm -rf -- /`, `rm --recursive --force /`,
	// `rm -rf -v /`, `rm -v -rf /`. An absolute target is still required.
	/\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i,
	// `--no-preserve-root` defeats coreutils' own refusal to recurse on `/`, so it is critical
	// wherever it appears — including forms this list would otherwise reach only via the target.
	/\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	// dd to a device. Write-only pseudo-device sinks (`of=/dev/null`, `/dev/stdout`, `/dev/fd/1`, …) are
	// excluded: they cannot destroy data, and `dd … of=/dev/null` is the standard read-throughput idiom.
	/\bdd\s+if=.+of=\/dev\/(?!(?:null|zero|stdout|stderr|tty|fd\/\d+)(?:[\s;&|)<>]|$))/i,
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

/** Absolute recursive removals remain critical, except literal temporary scratch. */
function isCriticalBashCommand(command: string): boolean {
	if (CRITICAL_BASH_PATTERNS.some((pattern, index) => index > 0 && pattern.test(command))) return true;
	for (const argv of tokenizeShellSegments(command)) {
		const executable = argv.findIndex(word => !isShellEnvironmentAssignment(word));
		const program = path.basename(argv[executable] ?? "");
		if (/^(?:awk|gawk|mawk|nawk)$/u.test(program) &&
			argv.slice(executable + 1).some(arg => /\bsystem\s*\(/u.test(arg))) return true;
		if (program !== "rm") continue;
		let recursive = false;
		let forced = false;
		for (let index = executable + 1; index < argv.length && argv[index] !== "--"; index++) {
			recursive ||= /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/u.test(argv[index]!);
			forced ||= /^(?:-[a-zA-Z]*[fF][a-zA-Z]*|--force)$/u.test(argv[index]!);
		}
		let options = true;
		for (const arg of argv.slice(executable + 1)) {
			if (options && arg === "--") options = false;
			else if (options && arg.startsWith("-")) continue;
			else if (arg.startsWith("/") && (recursive || (forced && arg === "/"))) {
				const target = arg.replace(/\/+$/u, "") || "/";
				const scratch = /^(?:(?:\/private)?\/tmp\/|(?:\/private)?\/var\/folders\/)[^/]+\/?/u.test(target) &&
					target.split("/").slice(1).every(part => part !== "." && part !== ".." && part !== "" && !/[*?[\]$`]/u.test(part));
				if (!scratch) return true;
			}
		}
	}
	return false;
}

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return BASH_PATTERN_APPROVAL_VALUES.has(normalized) ? (normalized as BashPatternApproval) : undefined;
}

export function normalizeBashAllowedEnvList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

export function getBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const match = normalizeBashApprovalPattern(record.match);
			const approval = normalizeBashPatternApproval(record.approval);
			const env = normalizeBashAllowedEnvList(record.env);
			if (match.length === 0 || !approval) return undefined;
			const rule: BashApprovalPatternRule = env.length > 0 ? { match, approval, env } : { match, approval };
			if (typeof record.captainException === "string") rule.captainException = record.captainException;
			return rule;
		})
		.filter((rule): rule is BashApprovalPatternRule => !!rule);
}

/** The review manifest grants this exact spelling, never its normalized aliases. */
function isCaptainBashException(rule: BashApprovalPatternRule): boolean {
	return typeof rule.captainException === "string" && rule.approval === "allow" && !rule.match.includes("*") &&
		rule.captainException === `captain-addition:${createHash("sha256").update(normalizeBashApprovalPattern(rule.match)).digest("hex")}`;
}

function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

// Names match exactly: a wildcard such as `CARGO_*` would also admit
// execution-redirecting variables (`CARGO_BUILD_RUSTC_WRAPPER`, `*_RUNNER`).
function stripAllowedLeadingEnvAssignments(command: string, allowedEnvNames: readonly string[]): string | undefined {
	if (allowedEnvNames.length === 0) return undefined;
	return withoutLeadingEnvironmentAssignments(command, varName => allowedEnvNames.includes(varName)) ?? undefined;
}

// `deny`/`prompt` rules are matched per segment so a dangerous command buried in
// a compound line (`cd x && rm -rf /`, `sleep 1 & rm -rf /`) is still caught,
// including when prefixed by leading `NAME=value` environment assignments.
// Reuse the shared shell tokenizer so segmentation stays in one place and honors
// every command boundary (`;`, `&&`, `||`, `|`, `&`, subshells, newlines).
function bashCommandSegments(command: string): string[] {
	const candidates: string[] = [];
	for (const words of tokenizeShellSegments(command)) {
		if (words.length === 0) continue;
		candidates.push(words.join(" "));
		let firstCmdIndex = 0;
		while (firstCmdIndex < words.length && isShellEnvironmentAssignment(words[firstCmdIndex])) {
			firstCmdIndex++;
		}
		if (firstCmdIndex > 0 && firstCmdIndex < words.length) {
			candidates.push(words.slice(firstCmdIndex).join(" "));
		}
	}
	return candidates;
}

// `deny`/`prompt` matching: the rule fires when its glob matches the whole
// command or any single segment of a compound command.
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	if (regex.test(normalizedCommand)) return true;
	return bashCommandSegments(command).some(segment => regex.test(segment));
}

// A rule "applies" to a command under approval-specific semantics: `allow` must
// vouch for the ENTIRE command and never rides a compound line (shell control
// syntax could smuggle an unsafe segment past a narrow allow), while `deny` and
// `prompt` fire on any matching segment so they mean what they appear to.
function bashApprovalRuleMatches(
	command: string,
	rule: BashApprovalPatternRule,
	allowedEnvVars: readonly string[],
	parsedSegment = false,
): boolean {
	if (rule.approval === "allow") {
		if (!parsedSegment && hasBashApprovalShellControl(command)) return false;
		const trimmedCommand = command.trimStart();
		const hasLeadingEnv =
			withoutLeadingEnvironmentAssignments(trimmedCommand) !== null || isShellEnvironmentAssignment(trimmedCommand);
		if (
			(!hasLeadingEnv || isShellEnvironmentAssignment(rule.match)) &&
			commandMatchesBashApprovalPattern(command, rule.match)
		) {
			return true;
		}
		if (!hasLeadingEnv) return false;
		const effectiveEnv = rule.env ? [...rule.env, ...allowedEnvVars] : allowedEnvVars;
		const stripped = stripAllowedLeadingEnvAssignments(trimmedCommand, effectiveEnv);
		return stripped !== undefined && commandMatchesBashApprovalPattern(stripped, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

function findNonCompoundBashRestrictionRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
): BashApprovalPatternRule | undefined {
	const segments = bashCommandSegments(command);
	let promptRule: BashApprovalPatternRule | undefined;
	for (const rule of rules) {
		if (
			rule.approval !== "allow" &&
			commandMatchesBashApprovalPattern(command, rule.match) &&
			!segments.some(segment => commandMatchesBashApprovalPattern(segment, rule.match))
		) {
			if (rule.approval === "deny") return rule;
			promptRule ??= rule;
		}
	}
	for (const segment of segments) {
		const segmentRule = rules.find(
			rule => rule.approval !== "allow" && commandMatchesBashApprovalPattern(segment, rule.match),
		);
		if (segmentRule?.approval === "deny") return segmentRule;
		if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
	}
	return promptRule;
}

export function findBashApprovalPatternRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[] = [],
): BashApprovalPatternRule | undefined {
	const decision = resolveBashPatternDecision(command, extractApprovalShellSegments(command), rules, allowedEnvVars);
	return decision.kind === "unmatched" ? undefined : decision.rule;
}

export type BashApprovalOverrideClass =
	"inert-data" | "feature-push" | "config-read" | "scratch-worktree-remove" | "captain-scoped-exception";

const NO_BASH_APPROVAL_OVERRIDES: readonly BashApprovalOverrideClass[] = [];

type BashPatternDecision = (
	| { kind: "deny"; rule: BashApprovalPatternRule }
	| { kind: "prompt"; rule: BashApprovalPatternRule }
	| { kind: "critical"; rule: BashApprovalPatternRule }
	| { kind: "allow"; rule?: BashApprovalPatternRule }
	| { kind: "unmatched" }
) & { overrideClasses?: readonly BashApprovalOverrideClass[] };

/** Actual authorization evidence, not a second heuristic inferred by replay tooling. */
export function getBashApprovalOverrideClasses(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[] = [],
	cwd?: string,
	searchPath: string | undefined = process.env.PATH,
): readonly BashApprovalOverrideClass[] {
	return resolveBashPatternDecision(command, extractApprovalShellSegments(command), rules, allowedEnvVars, cwd, true, searchPath).overrideClasses ??
		NO_BASH_APPROVAL_OVERRIDES;
}

/** One `bash.patterns` view: its rules plus the env names its `allow` rules may strip. */
interface BashPatternPolicy {
	rules: BashApprovalPatternRule[];
	allowedEnvVars: string[];
}

interface GitApprovalCommand {
	argv: string[];
	configArgv: string[];
	executable: string;
	searchPath: string | undefined;
	directory: string | undefined;
	configOverride: boolean;
	repositoryOverride: boolean;
	pathUncertain: boolean;
	unknown: boolean;
}

interface ApprovalDirectory {
	directory: string | undefined;
	sawSymlink: boolean;
	uncertain: boolean;
}

/**
 * Inspect raw prefixes before normalization can erase a symlink followed by `..`.
 * Keep uncertainty sticky across cd/-C: Bash logical cd and Git physical -C need
 * not agree, so neither a later parent nor an absolute target can repair proof.
 */
function advanceApprovalDirectory(state: ApprovalDirectory, target: string): ApprovalDirectory {
	let sawSymlink = state.sawSymlink;
	let uncertain = state.uncertain;
	if (!state.directory && !path.isAbsolute(target)) return { ...state, directory: undefined };
	const raw = path.isAbsolute(target) ? target : `${state.directory}/${target}`;
	const components = raw.split(path.sep);
	let prefix = "";
	try {
		for (const component of components) {
			if (!component) continue;
			prefix += `${path.sep}${component}`;
			if (fs.lstatSync(prefix).isSymbolicLink()) sawSymlink = true;
		}
		if (!fs.statSync(raw).isDirectory()) uncertain = true;
	} catch (error) {
		// A missing directory cannot execute Git, but must not manufacture a
		// stricter literal-policy verdict. Parent traversal without proof is
		// different: an unreadable prefix might conceal a symlink.
		if (components.includes("..") || (error as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true;
	}
	if (sawSymlink && components.includes("..")) uncertain = true;
	return { directory: path.resolve(raw), sawSymlink, uncertain };
}

// These executables can select, rewrite, or interpret another command. Until
// their option grammars and execution contexts are modeled, neither literal
// payloads nor unknown argv may inherit Git's semantic approval exceptions.
const BASH_APPROVAL_COMMAND_WRAPPERS: Record<string, true> = {
	command: true, env: true, exec: true, xargs: true, nice: true,
	timeout: true,
	nohup: true, time: true, sudo: true, sh: true, bash: true,
	zsh: true, ash: true, dash: true, ksh: true, eval: true,
};

const BASH_APPROVAL_CODE_INTERPRETERS = /^(?:awk|gawk|mawk|nawk|sed|gsed|perl|python(?:\d+(?:\.\d+)*)?|pypy(?:\d+)?|node|nodejs|bun|deno|ruby|lua|luajit|julia|osascript|find)$/u;

/** Interpreter programs are executable payloads, never inert quoted arguments. */
function requiresApprovalWrapperPrompt(argv: readonly string[], unknown: readonly number[] = []): boolean {
	let index = 0;
	while (isShellEnvironmentAssignment(argv[index] ?? "")) index++;
	if (unknown.includes(index)) return true;
	const executable = path.basename(argv[index++] ?? "");
	if (!Object.hasOwn(BASH_APPROVAL_COMMAND_WRAPPERS, executable)) return false;
	if (/^(?:sh|bash|zsh|ash|dash|ksh)$/u.test(executable)) {
		for (; index < argv.length; index++) {
			const arg = argv[index]!;
			if (unknown.includes(index)) return true;
			if (arg === "--command" || /^-[^-]*c/u.test(arg)) {
				const payload = argv[index + 1];
				if (payload === undefined || unknown.includes(index + 1)) return true;
				return approvalWrapperSourceNeedsPrompt(payload);
			}
			if (arg === "--") return index + 1 >= argv.length || unknown.includes(index + 1);
			if (!arg.startsWith("-") && !arg.startsWith("+")) return false;
			// Unmodeled interpreter options can change which argument is executable source.
			if (!/^(?:-[lrxv]+|--noprofile|--norc)$/u.test(arg)) return true;
		}
		return true; // stdin is executable source, not a known script operand.
	}
	if (executable === "eval") {
		if (unknown.some(position => position >= index)) return true;
		return approvalWrapperSourceNeedsPrompt(argv.slice(index).join(" "));
	}
	for (; index < argv.length; index++) {
		const arg = argv[index]!;
		if (unknown.includes(index)) return true;
		if (arg === "--") { index++; break; }
		if (executable === "env" && isShellEnvironmentAssignment(arg)) continue;
		if (!arg.startsWith("-")) break;
		if ((executable === "command" && arg === "-p") ||
			(executable === "env" && (arg === "-i" || arg === "--ignore-environment"))) continue;
		return true;
	}
	if (executable === "timeout") {
		if (unknown.includes(index) || !/^\d+(?:\.\d+)?[smhd]?$/u.test(argv[index++] ?? "")) return true;
	}
	if (index >= argv.length || unknown.includes(index)) return true;
	const payload = path.basename(argv[index]!);
	return payload === "git" || payload === "marut" || BASH_APPROVAL_CODE_INTERPRETERS.test(payload) ||
		/^(?:sh|bash|zsh|ash|dash|ksh)$/u.test(payload) ||
		requiresApprovalWrapperPrompt(argv.slice(index), unknown.filter(position => position >= index).map(position => position - index));
}

function approvalWrapperSourceNeedsPrompt(source: string): boolean {
	const segments = extractApprovalShellSegments(source);
	const simple = extractSimpleApprovalShellSegments(source);
	if (!simple || !segments || simple.length !== segments.length) return true;
	if (!segments?.length) return true;
	return segments.some(segment => {
		const argv = segment.argv ?? segment.literal?.argv;
		if (!argv) return true;
		if (!simple.some(candidate => candidate.text === segment.text &&
			candidate.argv.length === argv.length && candidate.argv.every((arg, index) => arg === argv[index]))) return true;
		let index = 0;
		while (isShellEnvironmentAssignment(argv[index] ?? "")) index++;
		const executable = path.basename(argv[index] ?? "");
		return segment.shellStateUnknown || segment.unknownArgv?.includes(index) ||
			executable === "git" || executable === "marut" ||
			requiresApprovalWrapperPrompt(argv, segment.unknownArgv);
	});
}

/** Skip Git's global options, not arbitrary options or path arguments after its subcommand. */
function normalizeGitApprovalArgv(
	argv: readonly string[],
	unknown: readonly number[],
	cwd: ApprovalDirectory,
	searchPath: string | undefined = process.env.PATH,
	trustedExecutable?: string,
): GitApprovalCommand | undefined {
	let start = 0;
	while (isShellEnvironmentAssignment(argv[start] ?? "")) start++;
	if (path.basename(argv[start] ?? "") !== "git") return undefined;
	const executable = trustedExecutable ?? resolveTrustedApprovalExecutable(argv[start]!, searchPath, cwd.directory);
	if (!executable) return undefined;
	let location = cwd;
	let configOverride = false;
	let repositoryOverride = false;
	const configArgv: string[] = [];
	const result = (args: string[]): GitApprovalCommand => {
		location = advanceApprovalDirectory(location, ".");
		let directory: string | undefined;
		if (!location.uncertain && location.directory) {
			try {
				directory = fs.realpathSync(location.directory);
			} catch {
				// No repository identity is available for an upstream lookup.
				// Preserve plain rules unless traversal itself was uncertain.
				directory = undefined;
			}
		}
		return { argv: ["git", ...args], configArgv: ["git", ...configArgv, ...args], executable, searchPath,
			directory, configOverride, repositoryOverride, pathUncertain: location.uncertain,
			unknown: unknown.length > 0 };
	};
	let i = start + 1;
	for (; i < argv.length; i++) {
		const arg = argv[i]!;
		if (/^(?:-[hv]|--help|--version|--exec-path|--html-path|--man-path|--info-path)$/u.test(arg) ||
			arg.startsWith("--list-cmds=")) {
			// Query/dispatch flags stop Git's global parsing. Do not reinterpret
			// an ignored suffix as another command or grant it an operation exception.
			if (i + 1 < argv.length) return undefined;
			return result(argv.slice(i));
		}
		if (arg === "-C") {
			const value = argv[++i];
			if (value === undefined) return undefined;
			location = unknown.includes(i)
				? { ...location, directory: undefined, uncertain: true }
				: advanceApprovalDirectory(location, value);
		} else if (arg === "-c" || arg === "--config-env" || arg.startsWith("--config-env=")) {
			configOverride = true;
			if (arg === "-c" || arg === "--config-env") {
				const value = argv[++i];
				if (value === undefined) return undefined;
				configArgv.push(arg, value);
			} else configArgv.push("--config-env", arg.slice(13));
		} else if (/^--(?:git-dir|work-tree|namespace|super-prefix|attr-source|shallow-file)$/u.test(arg)) {
			if (argv[++i] === undefined) return undefined;
			repositoryOverride = true;
		} else if (/^--(?:git-dir|work-tree|namespace|super-prefix|attr-source)=/u.test(arg)) {
			repositoryOverride = true;
		} else if (arg.startsWith("--exec-path=")) {
			configOverride = true;
			repositoryOverride = true;
			configArgv.push(arg);
		} else if (arg === "--bare") {
			repositoryOverride = true;
		} else if (/^(?:-[pP]|--no-pager|--paginate|--no-optional-locks|--no-advice|--no-lazy-fetch|--literal-pathspecs|--no-literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects)$/u.test(arg)) {
			continue;
		} else if (arg.startsWith("-")) return undefined;
		else break;
	}
	if (unknown.includes(i)) return undefined;
	return result(argv.slice(i));
}

// Approval is synchronous. Port the bounded, read-only Git query used by the
// feature-push policy; never execute any text from the command being assessed.
function approvalGitOutput(git: GitApprovalCommand, args: string[], rejectWarnings = false): string | undefined {
	if (!git.directory) return undefined;
	try {
		const result = Bun.spawnSync({
			cmd: [git.executable, "-C", git.directory, ...args],
			stdin: "ignore", stdout: "pipe", stderr: rejectWarnings ? "pipe" : "ignore", timeout: 1000,
			env: { ...Bun.env, PATH: git.searchPath, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
		});
		return result.exitCode === 0 && (!rejectWarnings || !result.stderr?.length) ? result.stdout.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

function approvalGitRefAbsent(git: GitApprovalCommand, ref: string): boolean {
	if (!git.directory) return false;
	try {
		const result = Bun.spawnSync({
			cmd: [git.executable, "-C", git.directory, "show-ref", "--verify", "--quiet", ref],
			stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 1000,
			env: { ...Bun.env, PATH: git.searchPath, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
		});
		// Missing is distinct from an unreadable ref or failed Git invocation.
		return result.exitCode === 1 && result.stderr.length === 0;
	} catch {
		return false;
	}
}

function isProtectedPushRef(ref: string): boolean {
	const branch = ref.replace(/^refs\/heads\//u, "");
	return /^(?:main|master|trunk|staging|kstage|prod|production)$/u.test(branch) || branch.startsWith("release/");
}

function isFeaturePushRef(ref: string): boolean {
	return ref.length > 0 && ref !== "HEAD" && !isProtectedPushRef(ref) &&
		!ref.startsWith("refs/tags/") && !ref.startsWith("refs/remotes/") &&
		(!ref.startsWith("refs/") || ref.startsWith("refs/heads/")) &&
		!/[\s:$`*?[\]~^\\]|@\{|\.{2}/u.test(ref) && !ref.startsWith("+") && !ref.startsWith("-");
}

type FeaturePushAssessment = "safe" | "plain-policy" | "prompt";

function assessFeaturePush(git: GitApprovalCommand): FeaturePushAssessment {
	if (git.argv.some(arg => /^(?:--tags|--follow-tags|--mirror|--all)$/u.test(arg))) return "prompt";
	if (git.configOverride || git.repositoryOverride || git.unknown || !git.directory) return "prompt";
	const currentRef = approvalGitOutput(git, [
		"rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", "HEAD",
	], true);
	if (currentRef === undefined || currentRef !== "HEAD" && !currentRef.startsWith("refs/heads/")) return "prompt";
	const currentBranch = currentRef === "HEAD" ? undefined : currentRef.slice(11);
	const configOutput = approvalGitOutput(git, ["config", "--null", "--get-regexp", GIT_PUSH_CONFIG_PATTERN], true);
	const config = configOutput === undefined ? undefined : parseGitPushConfig(configOutput);
	if (!config || !isGitPushBranchConfigSafe(config, currentBranch)) return "prompt";
	const positional: string[] = [];
	let options = true;
	let forced = false;
	let semantic = true;
	let unsupported = false;
	for (const arg of git.argv.slice(2)) {
		if (options && arg === "--") { options = false; continue; }
		if (options && arg.startsWith("-")) {
			if (/^--force-with-lease(?:=|$)/u.test(arg)) {
				forced = true;
				const lease = arg.split("=", 2)[1]?.split(":", 1)[0];
				if (lease && !isFeaturePushRef(lease)) semantic = false;
			} else if (/^(?:--force|--force-if-includes|-[uqvf]*f[uqvf]*)$/u.test(arg)) {
				forced = true;
				semantic = false;
			} else if (!/^(?:-[uqv]+|--set-upstream|--quiet|--verbose|--porcelain|--dry-run|--atomic)$/u.test(arg)) {
				unsupported = true;
				semantic = false;
			}
		} else positional.push(arg);
	}
	if (unsupported) return forced || positional.some(arg => arg.startsWith("+")) ? "prompt" : "plain-policy";
	const remote = positional.shift();
	if (remote !== undefined && remote !== "origin") return "prompt";
	const sourceBranch = (source: string): string | undefined => {
		if (source === "HEAD") return currentBranch;
		const name = source.replace(/^refs\/heads\//u, "");
		if (!name || source.startsWith("refs/") && !source.startsWith("refs/heads/")) return undefined;
		if (name === currentBranch) return name;
		return approvalGitOutput(git, [
			"-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", source,
		], true) === `refs/heads/${name}` ? name : undefined;
	};
	const safeSourceBranch = (branch: string | undefined): boolean => {
		const pushRemote = branch === undefined ? undefined : config.get(`branch.${branch}.pushremote`);
		return pushRemote === undefined || pushRemote === "origin";
	};
	const hasOriginUpstream = (branch: string | undefined, destination: string): boolean =>
		branch !== undefined && config.get(`branch.${branch}.remote`) === "origin" &&
		config.get(`branch.${branch}.merge`) === `refs/heads/${destination.replace(/^refs\/heads\//u, "")}`;
	const provesRefspec = (source: string, destination: string, branch: string | undefined): boolean => {
		if (!isFeaturePushRef(destination)) return false;
		const target = destination.replace(/^refs\/heads\//u, "");
		const name = source === "HEAD" ? "HEAD" : source.replace(/^refs\/heads\//u, "");
		if (source === "HEAD") {
			if (approvalGitOutput(git, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], true) === undefined) return false;
		} else if (branch === undefined) return false;
		if (!approvalGitRefAbsent(git, `refs/tags/${name}`)) return false;
		if (target !== name && !approvalGitRefAbsent(git, `refs/tags/${target}`)) return false;
		return approvalGitOutput(git, ["check-ref-format", `refs/heads/${target}`]) !== undefined;
	};
	if (positional.length === 0) {
		if (!currentBranch) return "prompt";
		const branchRemote = config.get(`branch.${currentBranch}.remote`);
		const effectiveRemote = remote ?? config.get(`branch.${currentBranch}.pushremote`) ??
			config.get("remote.pushdefault") ?? branchRemote ?? "origin";
		if (effectiveRemote !== "origin") return "prompt";
		const pushDefault = config.get("push.default") ?? "simple";
		const merge = config.get(`branch.${currentBranch}.merge`);
		let destination = currentBranch;
		if (pushDefault === "upstream") {
			if (branchRemote !== "origin" || !merge?.startsWith("refs/heads/")) return "prompt";
			destination = merge;
		} else if (pushDefault === "simple" && (branchRemote ?? "origin") === "origin" &&
			merge !== undefined && merge !== `refs/heads/${currentBranch}`) return "prompt";
		// Only Git's configured upstream is authoritative for implicit force.
		// An origin tracking ref can be stale or can name a remote-only tag.
		if (forced && !hasOriginUpstream(currentBranch, destination)) return "prompt";
		return semantic && provesRefspec(currentBranch, destination, currentBranch) ? "safe" : "plain-policy";
	}
	let feature = false;
	for (const refspec of positional) {
		if (refspec.startsWith(":")) return "plain-policy";
		const forceRef = refspec.startsWith("+");
		if (forceRef) semantic = false;
		const parts = (forceRef ? refspec.slice(1) : refspec).split(":");
		if (parts.length > 2) return "prompt";
		if (parts.some(part => part.startsWith("refs/tags/"))) return "prompt";
		const source = parts[0]!;
		const branch = sourceBranch(source);
		if (!safeSourceBranch(branch)) return "prompt";
		const implicit = parts.length === 1;
		const destination = parts[1] ?? (source === "HEAD" ? currentBranch : source);
		if (!destination || destination === "HEAD") return "prompt";
		// Explicit unqualified colon destinations do not consult branch.merge:
		// even a matching upstream name must not disguise a remote-only tag.
		if ((forced || forceRef) && !destination.startsWith("refs/heads/") &&
			(!implicit || !hasOriginUpstream(branch, destination))) return "prompt";
		if (!isFeaturePushRef(destination)) { semantic = false; continue; }
		feature = true;
		if (semantic && !provesRefspec(source, destination, branch)) return "prompt";
	}
	return feature && semantic ? "safe" : "plain-policy";
}

function isGitConfigRead(args: readonly string[]): boolean {
	let read = false;
	let show = false;
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (/^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)$/u.test(arg)) read = true;
		else if (/^--show-(?:origin|scope|names)$/u.test(arg)) show = true;
		else if (/^(?:--global|--local|--system|--worktree|--includes|--no-includes|--null|-z|--name-only)$/u.test(arg)) continue;
		else if (arg === "--file" || arg === "-f" || arg === "--blob" || arg === "--type") i++;
		else if (/^--(?:file|blob|type)=/u.test(arg)) continue;
		else if (arg.startsWith("-")) return false;
		else operands.push(arg);
	}
	if (operands[0] === "get" || operands[0] === "list") return true;
	return read ? operands.length <= 2 : operands.length === 1 || (show && operands.length === 0);
}

function isSafeWorktreeRemoval(git: GitApprovalCommand): boolean {
	if (git.configOverride || git.repositoryOverride || git.unknown || !git.directory || git.argv[2] !== "remove") return false;
	const targets = git.argv.slice(3).filter(arg => arg !== "--force" && arg !== "-f" && arg !== "--");
	if (targets.length !== 1 || targets[0]!.startsWith("-")) return false;
	let target: string;
	try {
		target = fs.realpathSync(path.resolve(git.directory, targets[0]!));
	} catch {
		return false;
	}
	if (!/^(?:\/private)?\/tmp\/[^/]+/u.test(target) && !target.includes("/.worktrees/")) return false;
	// Compare filesystem identity, not the /tmp alias or a caller's symlink spelling.
	const list = approvalGitOutput(git, ["worktree", "list", "--porcelain"]);
	const entry = list?.split("\n\n").find(block => {
		const registered = /^worktree (.+)$/mu.exec(block)?.[1];
		if (!registered) return false;
		try {
			return fs.realpathSync(registered) === target;
		} catch {
			return false;
		}
	});
	const head = entry && /^HEAD ([0-9a-f]+)$/mu.exec(entry)?.[1];
	const branch = entry && /^branch (.+)$/mu.exec(entry)?.[1];
	if (!head) return false;
	const args = ["rev-list", "--max-count=1", head, "--not", "--single-worktree"];
	if (branch) args.push(`--exclude=${branch}`);
	args.push("--all");
	return approvalGitOutput(git, args) === "";
}

interface LegacyBashRestriction {
	rule: BashApprovalPatternRule;
	/** Absent only for a restriction that matched across the whole source. */
	segment?: ApprovalShellSegment;
	criticalPattern?: RegExp;
	/** The predecessor assessment of an ordinary env payload, not its wrapper spelling. */
	innerEnvironment?: boolean;
}

interface LegacyBashAssessment {
	restrictions: LegacyBashRestriction[];
	matchedAllow: boolean;
	/** Exact predecessor units; null means it could not establish a literal unit boundary. */
	segments: { text: string; matchedAllow: boolean }[] | null;
}

const LEGACY_CRITICAL_RULE: BashApprovalPatternRule = { match: "Critical pattern detected", approval: "prompt" };

/** Keep e540's ordered restriction pass, including its literal-argv retokenization. */
function legacyBashAssessment(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
	compoundEnabled: boolean,
): LegacyBashAssessment {
	const segments = compoundEnabled ? extractLegacyApprovalShellSegments(command) : null;
	const restrictions: LegacyBashRestriction[] = [];
	let matchedAllow = false;
	let segmentAllows: LegacyBashAssessment["segments"] = segments ? [] : null;
	if (!segments) {
		if (!hasBashApprovalShellControl(command)) {
			const rule = rules.find(rule => bashApprovalRuleMatches(command, rule, allowedEnvVars));
			if (rule && rule.approval !== "allow") restrictions.push({ rule, segment: { text: command, literal: null } });
			matchedAllow = rule?.approval === "allow";
			segmentAllows = [{ text: command, matchedAllow }];
		} else {
			const spellings = bashCommandSegments(command);
			for (const rule of rules) {
				if (rule.approval !== "allow" && commandMatchesBashApprovalPattern(command, rule.match) &&
					!spellings.some(text => commandMatchesBashApprovalPattern(text, rule.match))) restrictions.push({ rule });
			}
			for (const text of spellings) {
				const rule = rules.find(rule => rule.approval !== "allow" && commandMatchesBashApprovalPattern(text, rule.match));
				if (rule) restrictions.push({ rule, segment: { text, literal: null } });
			}
		}
	} else {
		const opaque = segments.some(segment => segment.literal === null);
		for (const rule of rules) {
			if (rule.approval !== "allow" &&
				(rule.approval === "deny" || opaque || /[;&|]/u.test(rule.match)) &&
				commandMatchesBashApprovalPattern(command, rule.match) &&
				!segments.some(segment => commandMatchesBashApprovalPattern(segment.text, rule.match))) restrictions.push({ rule });
		}
		matchedAllow = true;
		for (const segment of segments) {
			const withoutEnv = withoutLeadingEnvironmentAssignments(segment.text);
			const rule = rules.find(rule => rule.approval === "allow"
				? segment.literal !== null && bashApprovalRuleMatches(segment.text, rule, allowedEnvVars, true)
				: commandMatchesBashApprovalPattern(segment.text, rule.match) ||
					(withoutEnv !== null && commandMatchesBashApprovalPattern(withoutEnv, rule.match)) ||
					(segment.literal !== null && commandSegmentMatchesBashApprovalPattern(segment.literal.argv.join(" "), rule.match)));
			if (rule && rule.approval !== "allow") restrictions.push({ rule, segment });
			if (rule?.approval !== "allow" || segment.literal === null) matchedAllow = false;
			segmentAllows!.push({ text: segment.text, matchedAllow: rule?.approval === "allow" && segment.literal !== null });
		}
	}
	// The complete predecessor decision includes critical overrides, even when
	// an ordered allow matched, and an exec floor for unmatched commands.
	for (const criticalPattern of CRITICAL_BASH_PATTERNS) {
		if (criticalPattern.test(command)) restrictions.push({ rule: LEGACY_CRITICAL_RULE, criticalPattern });
		for (const segment of segments ?? []) {
			if (criticalPattern.test(segment.literal?.argv.join(" ") ?? segment.text)) {
				restrictions.push({ rule: LEGACY_CRITICAL_RULE, segment, criticalPattern });
			}
		}
	}
	return { restrictions, matchedAllow, segments: segmentAllows };
}

function cleanBashApprovalEnvironment(
	argv: readonly string[],
	firstCommand: number,
	allowedEnvVars: readonly string[],
	rule?: BashApprovalPatternRule,
): boolean {
	return argv.slice(0, firstCommand).every(assignment => {
		const name = assignment.slice(0, assignment.indexOf("="));
		return !name.startsWith("GIT_") && !name.startsWith("MARUT_") &&
			(allowedEnvVars.includes(name) || rule?.env?.includes(name));
	});
}

function restrictionMatches(text: string, restriction: LegacyBashRestriction, retokenize = false): boolean {
	return restriction.criticalPattern ? restriction.criticalPattern.test(text) :
		retokenize ? commandSegmentMatchesBashApprovalPattern(text, restriction.rule.match) :
			commandMatchesBashApprovalPattern(text, restriction.rule.match);
}

function normalizedReadOnlyGit(
	argv: readonly string[], searchPath: string | undefined, executable: string,
): GitApprovalCommand | undefined {
	const git = normalizeGitApprovalArgv(argv, [], { directory: undefined, sawSymlink: false, uncertain: false }, searchPath, executable);
	return git && !git.unknown && !git.configOverride && !git.repositoryOverride && isReadOnlyGitApprovalArgv(git.argv)
		? git : undefined;
}

/**
 * Positive data positions only. An arbitrary executable or wrapper might evaluate
 * its arguments; interpreter programs cannot borrow this class even when quoted.
 */
function isInertBashRestrictionData(
	segment: ApprovalShellSegment, restriction: LegacyBashRestriction, searchPath: string | undefined,
): boolean {
	const argv = segment.argv;
	if (!argv?.length || segment.unknownArgv?.length || segment.shellStateUnknown) return false;
	let index = 0;
	while (isShellEnvironmentAssignment(argv[index] ?? "")) index++;
	if (index !== 0) return false;
	const trusted = resolveTrustedApprovalExecutable(argv[index]!, searchPath);
	if (!trusted || ((segment as ApprovalEnvSegment).envSourceArgv && !restriction.criticalPattern &&
		(commandMatchesBashApprovalPattern(segment.text, restriction.rule.match) ||
			/^(?:env|\/[^ ]*\/env)(?: |$)/u.test(restriction.rule.match)))) return false;
	const executable = path.basename(trusted);
	if (BASH_APPROVAL_CODE_INTERPRETERS.test(executable) ||
		Object.hasOwn(BASH_APPROVAL_COMMAND_WRAPPERS, executable)) return false;
	if (executable === "git") {
		const git = normalizedReadOnlyGit(argv, searchPath, trusted);
		return !!git && !restrictionMatches(git.argv.join(" "), restriction);
	}
	if (argv.some(arg => /^(?:--pre|--pre-glob|--hostname-bin|--jq|--template)(?:=|$)/u.test(arg))) return false;
	const dataCommand = /^(?:echo|printf|cat|tee|grep|rg)$/u.test(executable) ||
		(executable === "perms" && argv[1] === "check") ||
		(executable === "gh" && argv[1] === "pr" && /^(?:create|edit|view)$/u.test(argv[2] ?? ""));
	if (!dataCommand) return false;
	let word = 0;
	const masked = lexShellCommand(segment.text).map(token => {
		if (token.kind === "word" && ++word > 1 && /['"\\]/u.test(token.raw)) return "__omp_inert_argument__";
		return token.raw;
	}).join("");
	return masked !== segment.text && !restrictionMatches(masked, restriction, true) &&
		(restrictionMatches(segment.text, restriction) || restrictionMatches(argv.join(" "), restriction, true));
}

/**
 * Project only parser-owned root heredoc bytes, and only in a data-only line.
 * No text search may borrow a body from another command or hide a later
 * interpreter that could consume a generated script.
 */
function projectInertHeredocData(
	command: string, segments: readonly ApprovalShellSegment[] | null, searchPath: string | undefined,
): string {
	if (!segments?.length || segments.some(segment =>
		segment.unknownArgv?.length || segment.shellStateUnknown ||
		(segment.argv?.[0] !== "cd" && !resolveTrustedApprovalExecutable(segment.argv?.[0] ?? "", searchPath)) ||
		!/^(?:cat|tee|echo|printf|cd)$/u.test(path.basename(segment.argv?.[0] ?? "")))) return command;
	const bodies = new Map<number, QuotedHeredocBody>();
	for (const segment of segments) {
		if (!/^(?:cat|tee)$/u.test(path.basename(segment.argv?.[0] ?? ""))) continue;
		for (const body of segment.quotedHeredocs ?? []) {
			if (body.source === command && body.end > body.start) bodies.set(body.start, body);
		}
	}
	if (!bodies.size) return command;
	let projected = command;
	let boundary = command.length;
	for (const body of [...bodies.values()].sort((left, right) => right.start - left.start)) {
		if (body.end > boundary) return command;
		projected = projected.slice(0, body.start) + projected.slice(body.end);
		boundary = body.start;
	}
	return projected;
}

type ApprovalEnvSegment = ApprovalShellSegment & { envSourceArgv?: readonly string[]; envInnerText?: string };

/** Remove only validated literal prefix words; preserve the payload's exact quoting and expansions. */
function ordinaryEnvInnerText(text: string, prefix: readonly string[]): string | undefined {
	let words = 0;
	let offset = 0;
	for (const token of lexShellCommand(text)) {
		if (token.kind === "word") {
			if (token.value !== prefix[words]) return undefined;
			words++;
		} else if (!/^\s*$/u.test(token.raw)) {
			return undefined;
		}
		offset += token.raw.length;
		if (words === prefix.length) return text.slice(offset).trimStart();
	}
	return undefined;
}

/** Ordinary env values cannot select code/config/targets; unknown names stay wrapped. */
function ordinaryEnvApprovalSegments(
	segments: readonly ApprovalShellSegment[] | null, searchPath: string | undefined, cwd?: string,
): readonly ApprovalShellSegment[] | null {
	if (!segments) return null;
	let prepared: ApprovalShellSegment[] | undefined;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		const originalArgv = segment.argv;
		if (!originalArgv) continue;
		let argv: readonly string[] = originalArgv;
		let unknown: readonly number[] = segment.unknownArgv ?? [];
		while (path.basename(argv[0] ?? "") === "env" &&
			resolveTrustedApprovalExecutable(argv[0]!, searchPath, segments.length === 1 ? cwd : undefined)) {
			const ordinary = unwrapOrdinaryApprovalEnv(argv, unknown);
			if (!ordinary) break;
			argv = ordinary.argv;
			unknown = ordinary.unknown;
		}
		if (argv === originalArgv) continue;
		const envInnerText = ordinaryEnvInnerText(segment.text, originalArgv.slice(0, originalArgv.length - argv.length));
		if (!envInnerText) continue;
		const inner = [...argv];
		const unwrapped: ApprovalEnvSegment = { ...segment, argv: inner, unknownArgv: [...unknown],
			envSourceArgv: originalArgv, envInnerText, literal: segment.literal ? { ...segment.literal, argv: inner } : null };
		(prepared ??= [...segments])[index] = unwrapped;
	}
	return prepared ?? segments;
}

function resolveBashPatternDecision(
	command: string,
	compoundSegments: readonly ApprovalShellSegment[] | null,
	patternRules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
	cwd?: string,
	compoundEnabled = true,
	searchPath: string | undefined = process.env.PATH,
): BashPatternDecision {
	const original = legacyBashAssessment(command, patternRules, allowedEnvVars, compoundEnabled);
	const segments = ordinaryEnvApprovalSegments(compoundSegments ?? extractApprovalShellSegments(command), searchPath, cwd);
	const projected = projectInertHeredocData(command, segments, searchPath);
	const legacy = projected === command ? original :
		legacyBashAssessment(projected, patternRules, allowedEnvVars, compoundEnabled);
	// Env contributes no authorization. Its payload inherits the complete
	// predecessor floor of the exact unwrapped source, independently per unit.
	let innerFloors: Map<ApprovalShellSegment, LegacyBashAssessment> | undefined;
	let restrictions = legacy.restrictions;
	for (const segment of segments ?? []) {
		const innerText = (segment as ApprovalEnvSegment).envInnerText;
		if (!innerText) continue;
		const inner = legacyBashAssessment(innerText, patternRules, allowedEnvVars, compoundEnabled);
		(innerFloors ??= new Map()).set(segment, inner);
		for (const restriction of inner.restrictions) {
			if (restrictions === legacy.restrictions) restrictions = [...restrictions];
			restrictions.push({ ...restriction, segment, innerEnvironment: true });
		}
	}
	const authorizations = original.restrictions.length || !original.matchedAllow || innerFloors
		? new Map<ApprovalShellSegment, BashApprovalOverrideClass>() : undefined;
	const decision = resolveArgvBashPatternDecision(command, compoundSegments, patternRules, allowedEnvVars, cwd, authorizations, segments, searchPath);
	if (decision.kind === "deny") return decision;
	let inertDataSegments: Set<ApprovalShellSegment> | undefined;
	if (decision.kind === "prompt") {
		const denied = restrictions.find(restriction => restriction.rule.approval === "deny");
		return denied ? { kind: "deny", rule: denied.rule } : decision;
	}
	const classes = new Set<BashApprovalOverrideClass>();
	const inertHeredocOverride = projected !== command && original.restrictions.some(before =>
		!legacy.restrictions.some(after => before.rule === after.rule && before.criticalPattern === after.criticalPattern &&
			before.segment?.text === after.segment?.text));
	if (inertHeredocOverride) classes.add("inert-data");
	let promptRule: BashApprovalPatternRule | undefined;
	let criticalFloor = false;
	const authorize = (segment: ApprovalShellSegment, restriction: LegacyBashRestriction): boolean => {
		if (restriction.rule.approval === "deny") return false;
		const semantic = !(segment as ApprovalEnvSegment).envSourceArgv || restriction.innerEnvironment
			? authorizations?.get(segment) : undefined;
		const authorization = semantic && (semantic !== "captain-scoped-exception" ||
			(!restriction.criticalPattern && restriction.rule.approval !== "deny"))
			? semantic : isInertBashRestrictionData(segment, restriction, searchPath) ? "inert-data" : undefined;
		if (authorization) {
			classes.add(authorization);
			if (authorization === "inert-data") (inertDataSegments ??= new Set()).add(segment);
		}
		return authorization !== undefined;
	};
	for (const restriction of restrictions) {
		let justified = false;
		if (restriction.criticalPattern) {
			// Every actual matching unit must be safe; one quoted example cannot
			// excuse an actual destructive command elsewhere in the line.
			const affected = segments?.filter(segment => restrictionMatches(segment.text, restriction) ||
				restrictionMatches(segment.argv?.join(" ") ?? "", restriction)) ?? [];
			justified = affected.length > 0 && affected.every(segment => authorize(segment, restriction));
		} else if (restriction.segment) {
			const affected = segments?.filter(segment => segment.text === restriction.segment!.text ||
				segment.argv?.join(" ") === restriction.segment!.text) ?? [];
			justified = affected.length > 0 && affected.every(segment => authorize(segment, restriction));
		} else {
			const prefix = normalizeBashApprovalPattern(restriction.rule.match.split("*", 1)[0] ?? "");
			for (const segment of segments ?? []) {
				const authorization = authorizations?.get(segment);
				if (authorization && !(segment as ApprovalEnvSegment).envSourceArgv &&
					prefix && normalizeBashApprovalPattern(segment.text).startsWith(prefix)) {
					classes.add(authorization);
					justified = true;
					break;
				}
				if (isInertBashRestrictionData(segment, restriction, searchPath)) {
					classes.add("inert-data");
					(inertDataSegments ??= new Set()).add(segment);
					justified = true;
					break;
				}
			}
		}
		if (!justified) {
			if (restriction.rule.approval === "deny") return { kind: "deny", rule: restriction.rule };
			if (restriction.criticalPattern) {
				criticalFloor = true;
				continue;
			}
			promptRule ??= restriction.rule;
		}
	}
	if (promptRule) return { kind: "prompt", rule: promptRule };
	if (criticalFloor) return { kind: "critical", rule: LEGACY_CRITICAL_RULE,
		...(classes.size ? { overrideClasses: [...classes] } : {}) };
	if (!innerFloors && original.matchedAllow && decision.kind === "unmatched" && segments?.every(segment =>
		!segment.unknownArgv?.length && !segment.resolvedExpansion)) {
		return classes.size ? { kind: "allow", overrideClasses: [...classes] } : { kind: "allow" };
	}
	if (!original.matchedAllow || innerFloors) {
		const simple = extractSimpleApprovalShellSegments(command);
		const target = simple?.length === segments?.length ? segments?.at(-1) : undefined;
		const targetAuthorization = target && (authorizations?.get(target) ??
			(inertDataSegments?.has(target) ? "inert-data" : undefined));
		let complete = !!segments?.length;
		let legacyIndex = 0;
		for (const segment of segments ?? []) {
			let authorization = authorizations?.get(segment) ??
				(inertDataSegments?.has(segment) ? "inert-data" : undefined);
			if (!authorization && inertHeredocOverride &&
				segment.quotedHeredocs?.some(body => body.source === command)) authorization = "inert-data";
			// A verified semantic target owns its strictly literal initial cd
			// chain. It cannot authorize any unrelated preceding/following unit.
			if (!authorization && targetAuthorization && segment !== target && segment.argv?.[0] === "cd") {
				authorization = targetAuthorization;
			}
			const before = original.segments?.[legacyIndex];
			const sameUnit = before?.text === segment.text;
			if (sameUnit) legacyIndex++;
			const oldAllow = (innerFloors?.get(segment)?.matchedAllow ?? (sameUnit && before?.matchedAllow)) &&
				!segment.unknownArgv?.length && !segment.resolvedExpansion && !segment.shellStateUnknown;
			if (authorization) classes.add(authorization);
			else if (!oldAllow) complete = false;
		}
		// The exec tier is a separate floor for EVERY predecessor unit. One
		// config read or feature push may never carry an unmatched mutation.
		if (!complete) return classes.size ? { kind: "unmatched", overrideClasses: [...classes] } : { kind: "unmatched" };
		if (decision.kind === "unmatched" && targetAuthorization && targetAuthorization !== "inert-data") {
			return { kind: "allow", overrideClasses: [...classes] };
		}
	}
	return classes.size ? { ...decision, overrideClasses: [...classes] } : decision;
}

function resolveArgvBashPatternDecision(
	command: string,
	compoundSegments: readonly ApprovalShellSegment[] | null,
	patternRules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
	cwd?: string,
	authorizations?: Map<ApprovalShellSegment, BashApprovalOverrideClass>,
	parsedSegments?: readonly ApprovalShellSegment[] | null,
	searchPath: string | undefined = process.env.PATH,
): BashPatternDecision {
	const segments = parsedSegments ?? compoundSegments ?? extractApprovalShellSegments(command);
	// Structural eligibility is independent of the flattened parser's inferred bindings.
	// Match both original bytes and argv so loop expansion can never borrow this exception.
	const simpleSegments = extractSimpleApprovalShellSegments(command);
	if (!segments) {
		const rule = findNonCompoundBashRestrictionRule(command, patternRules);
		if (rule) return { kind: rule.approval === "deny" ? "deny" : "prompt", rule };
		if (tokenizeShellSegments(command).some(argv => {
			const executable = argv.find(word => !isShellEnvironmentAssignment(word));
			const program = path.basename(executable ?? "");
			return program === "git" || (Object.hasOwn(BASH_APPROVAL_COMMAND_WRAPPERS, program) &&
				requiresApprovalWrapperPrompt(argv));
		})) return { kind: "prompt", rule: { match: "git or command wrapper (unparsed shell syntax)", approval: "prompt" } };
		return { kind: "unmatched" };
	}
	let promptRule: BashApprovalPatternRule | undefined;
	let unmatched = false;
	let allowRule: BashApprovalPatternRule | undefined;
	const initialDirectory: ApprovalDirectory = { directory: cwd, sawSymlink: false, uncertain: false };
	const directories = new Map<number, ApprovalDirectory & { allowContext: boolean }>();
	directories.set(0, { ...initialDirectory, allowContext: true });
	for (const rule of segments.length > 1 ? patternRules : []) {
		if (rule.approval !== "allow" && /&&|\|\||;|\|/u.test(rule.match) &&
			!/^\*(?:&&|;|\|) /u.test(rule.match) &&
			commandMatchesBashApprovalPattern(command, rule.match)) {
			if (rule.approval === "deny") return { kind: "deny", rule };
			promptRule ??= rule;
		}
	}
	let segmentIndex = 0;
	let simpleDirectory = initialDirectory;
	for (const segment of segments) {
		const simpleCandidate = simpleSegments?.[segmentIndex++];
		const scope = segment.cwdScope ?? 0;
		if (!directories.has(scope)) {
			const inherited = directories.get(segment.cwdParentScope ?? 0) ?? directories.get(0)!;
			directories.set(scope, { ...inherited });
		}
		const context = directories.get(scope)!;
		if (segment.cwdUnknown) context.directory = undefined;
		const directory = context.directory;
		const allowContext = context.allowContext;
		const argv = segment.argv ?? segment.literal?.argv ?? tokenizeShellSegments(segment.text)[0] ?? [];
		if (argv.length > 0 && argv.every(isShellEnvironmentAssignment)) {
			unmatched = true;
			continue;
		}
		let firstCommand = 0;
		while (isShellEnvironmentAssignment(argv[firstCommand] ?? "")) firstCommand++;
		const sourceArgv = (segment as ApprovalEnvSegment).envSourceArgv ?? argv;
		const simple = !!simpleCandidate && scope === 0 && !segment.unknownArgv?.length &&
			simpleCandidate.text === segment.text && simpleCandidate.argv.length === sourceArgv.length &&
			simpleCandidate.argv.every((arg, index) => arg === sourceArgv[index]);
		if (simple && argv[0] === "cd") simpleDirectory = advanceApprovalDirectory(simpleDirectory, argv[1]!);
		const trustedExecutable = resolveTrustedApprovalExecutable(argv[firstCommand] ?? "", searchPath, directory);
		const trustedProgram = trustedExecutable ? path.basename(trustedExecutable) : "";
		const program = (argv[firstCommand] ?? "").includes("/") ? trustedProgram : argv[firstCommand] ?? "";
		const git = trustedProgram === "git"
			? normalizeGitApprovalArgv(argv, segment.unknownArgv ?? [], simple ? simpleDirectory : context, searchPath, trustedExecutable)
			: undefined;
		// Profile names and registry boot seeds do not prove a Marut kernel's
		// current backend. Marut writes therefore keep their configured guard.
		const semanticEnvironment = cleanBashApprovalEnvironment(argv, firstCommand, allowedEnvVars);
		const semanticEligible = simple && semanticEnvironment && !!trustedExecutable;
		const spelling = git ? [...argv.slice(0, firstCommand), ...git.argv].join(" ") : argv.join(" ");
		const stripped = withoutLeadingEnvironmentAssignments(spelling);
		const candidates = stripped === null ? [spelling] : [spelling, stripped];
		if (firstCommand > 0) candidates.push(argv.slice(firstCommand).join(" "));
		if (git?.configOverride) candidates.push(git.configArgv.join(" "));
		if (git?.argv[1] === "worktree" && git.argv[2] === "remove" && git.directory && !git.unknown && !git.repositoryOverride) {
			const targets = git.argv.slice(3).filter(arg => arg !== "--force" && arg !== "-f" && arg !== "--");
			if (targets.length === 1 && !targets[0]!.startsWith("-")) {
				try {
					const canonical = fs.realpathSync(path.resolve(git.directory, targets[0]!));
					candidates.push(git.argv.map((arg, index) => index >= 3 && arg === targets[0] ? canonical : arg).join(" "));
				} catch {
					// Missing or unreadable targets cannot acquire a semantic exception.
				}
			}
		}
		const matches = (rule: BashApprovalPatternRule) => {
			const match = rule.match.replace(/^\*(?:&&|;|\|) /u, "");
			if (/&&|\|\||;|\|/u.test(match)) return false;
			return candidates.some(text => commandMatchesBashApprovalPattern(text, match)) ||
				(git?.directory !== undefined && /^git -C (?!\* )/u.test(match) &&
					commandMatchesBashApprovalPattern(`git -C ${git.directory} ${git.argv.slice(1).join(" ")}`, match)) ||
				(rule.approval !== "allow" && (rule.approval === "deny" || /[<>]/u.test(match) || segment.text.includes("\n")) &&
					commandMatchesBashApprovalPattern(segment.text, match));
		};
		if ((segment as ApprovalEnvSegment).envSourceArgv) {
			let rawPrompt: BashApprovalPatternRule | undefined;
			for (const rule of patternRules) {
				if (rule.approval === "allow" || !commandMatchesBashApprovalPattern(segment.text, rule.match)) continue;
				if (rule.approval === "deny") return { kind: "deny", rule };
				rawPrompt ??= rule;
			}
			if (rawPrompt) {
				promptRule ??= rawPrompt;
				continue;
			}
		}
		if (segment.approvalGrouped && /^(?:git|marut)$/u.test(program)) {
			const denied = patternRules.find(rule => rule.approval === "deny" && matches(rule));
			if (denied) return { kind: "deny", rule: denied };
			promptRule ??= patternRules.find(rule => rule.approval === "prompt" && matches(rule)) ??
				{ match: "grouped Git or Marut command (unresolved execution context)", approval: "prompt" };
			continue;
		}
		if (program === "env" || (Object.hasOwn(BASH_APPROVAL_COMMAND_WRAPPERS, program) &&
			requiresApprovalWrapperPrompt(argv, segment.unknownArgv))) {
			const denied = patternRules.find(rule => rule.approval === "deny" && matches(rule));
			if (denied) return { kind: "deny", rule: denied };
			promptRule ??= patternRules.find(rule => rule.approval === "prompt" && matches(rule)) ??
				{ match: "command wrapper (unresolved execution context)", approval: "prompt" };
			continue;
		}
		if (trustedProgram === "git" && !git) {
			const denied = patternRules.find(rule => rule.approval === "deny" && matches(rule));
			if (denied) return { kind: "deny", rule: denied };
			promptRule ??= { match: "git (unresolved global options)", approval: "prompt" };
			continue;
		}
		if (git && ((git.unknown && /^(?:config|push|worktree)$/u.test(git.argv[1] ?? "")) ||
			(git.pathUncertain && /^(?:config|push|worktree)$/u.test(git.argv[1] ?? "")) ||
			(git.argv[1] === "push" && (git.repositoryOverride || git.configOverride)))) {
			const denied = patternRules.find(rule => rule.approval === "deny" && matches(rule));
			if (denied) return { kind: "deny", rule: denied };
			promptRule ??= { match: "git (uncertain arguments or repository selection)", approval: "prompt" };
			continue;
		}
		const pushAssessment = git?.argv[1] === "push" ? assessFeaturePush(git) : undefined;
		if (git?.argv[1] === "push" && (pushAssessment === "prompt" ||
			argv.slice(0, firstCommand).some(assignment => /^(?:GIT_|MARUT_)/u.test(assignment)))) {
			const denied = patternRules.find(rule => rule.approval === "deny" && matches(rule));
			if (denied) return { kind: "deny", rule: denied };
			promptRule ??= { match: "git push (unproven branch or tag selection)", approval: "prompt" };
			continue;
		}
		let safeGit = false;
		let authorization: BashApprovalOverrideClass | undefined;
		if (semanticEligible) {
			if (git?.argv[1] === "config" && !git.configOverride && !git.unknown) safeGit = isGitConfigRead(git.argv.slice(2));
			if (git?.argv[1] === "push") safeGit = pushAssessment === "safe";
			if (git?.argv[1] === "worktree" && git.argv[2] === "remove") safeGit = isSafeWorktreeRemoval(git);
		}
		if (safeGit) authorization = git?.argv[1] === "config" ? "config-read" :
			git?.argv[1] === "push" ? "feature-push" : "scratch-worktree-remove";
		// Like the live opaque-shell fallback, derived argv cannot acquire a
		// literal allow. Otherwise a saved feature glob can hide loop state.
		const guardedOperation = (git && (git.argv[1] === "push" || git.argv[1] === "config" ||
			(git.argv[1] === "worktree" && git.argv[2] === "remove"))) ||
			(argv[firstCommand] === "marut" && argv.includes("--allow-write"));
		const literalOperation = !guardedOperation || simple || extractSimpleApprovalShellSegments(segment.text) !== null;
		const writtenRule = patternRules.find(rule =>
			commandMatchesBashApprovalPattern(segment.text, rule.match) ||
			(withoutLeadingEnvironmentAssignments(segment.text) !== null &&
				commandMatchesBashApprovalPattern(withoutLeadingEnvironmentAssignments(segment.text)!, rule.match)));
		const reviewedWrittenAllow = semanticEligible && git?.directory && !git.pathUncertain &&
			!git.unknown && !git.repositoryOverride && !git.configOverride && writtenRule &&
			isCaptainBashException(writtenRule) && segment.literal !== null && !segment.allowUnsafe &&
			cleanBashApprovalEnvironment(argv, firstCommand, allowedEnvVars, writtenRule) ? writtenRule : undefined;
		const preservedWrittenAllow = literalOperation && git && !git.unknown && !git.repositoryOverride && !git.configOverride &&
			writtenRule?.approval === "allow" && /^git -C (?!\* )/u.test(writtenRule.match) &&
			cleanBashApprovalEnvironment(argv, firstCommand, allowedEnvVars, writtenRule) &&
			bashApprovalRuleMatches(segment.text, writtenRule, allowedEnvVars, true) &&
			segment.literal !== null && !segment.allowUnsafe && allowContext ? writtenRule : undefined;
		if (authorization) authorizations?.set(segment, authorization);
		const rule = reviewedWrittenAllow ?? preservedWrittenAllow ?? patternRules.find(rule => {
			if (!matches(rule)) return false;
			if (rule.approval === "allow") {
				if (/^git -C (?!\* )/u.test(rule.match) &&
					!cleanBashApprovalEnvironment(argv, firstCommand, allowedEnvVars, rule)) return false;
				if (!literalOperation) return false;
				if (!allowContext || !(compoundSegments !== null || segments.length === 1) || segment.literal === null || segment.allowUnsafe) return false;
				if (git?.argv[1] === "push" && git.unknown) return false;
				const env = rule.env ? [...allowedEnvVars, ...rule.env] : allowedEnvVars;
				if (firstCommand > 0 && !isShellEnvironmentAssignment(rule.match) &&
					!argv.slice(0, firstCommand).every(value => env.includes(value.slice(0, value.indexOf("="))))) return false;
				return git || (segment as ApprovalEnvSegment).envSourceArgv
					? matches(rule) : bashApprovalRuleMatches(segment.text, rule, allowedEnvVars, true);
			}
			// Only the operation's broad guard gets a semantic read/safe-target
			// exception. Independent restrictions (eg egress approval) still win.
			if (safeGit && rule.approval === "prompt" &&
				(/^(?:git config(?: \*)?|git push(?: \*)?|git worktree remove(?: .*)?)$/u.test(rule.match) ||
					/^git push --force-with-lease(?:=\*:\*)? origin \*$/u.test(rule.match))) return false;
			return true;
		});
		if (reviewedWrittenAllow) {
			authorizations?.set(segment, "captain-scoped-exception");
		}
		if (git?.argv[1] === "push" && !safeGit &&
			!(rule?.approval === "allow" && !rule.match.includes("*"))) {
			const positional = git.argv.slice(2).filter(arg => !arg.startsWith("-"));
			if (positional.length === 0 || (positional[0] === "origin" &&
				(positional.length === 1 || (positional.length === 2 && positional[1] === "HEAD")))) {
				promptRule ??= { match: "git push (unresolved destination)", approval: "prompt" };
			}
		}
		if (rule?.approval === "deny") return { kind: "deny", rule };
		if (rule?.approval === "prompt") promptRule ??= rule;
		if (rule?.approval === "allow") allowRule ??= rule;
		if (!rule && !safeGit) unmatched = true;
		if (argv[0] === "cd") {
			context.allowContext = false;
			if (argv.length === 2 && !segment.unknownArgv?.length) {
				Object.assign(context, advanceApprovalDirectory(context, argv[1]!));
			} else {
				context.directory = undefined;
				context.uncertain = true;
			}
		}
		if (segment.cwdUnknownAfter) {
			context.directory = undefined;
			const parent = directories.get(segment.cwdParentScope ?? scope);
			if (parent) parent.directory = undefined;
		}
	}
	if (promptRule) return { kind: "prompt", rule: promptRule };
	return unmatched ? { kind: "unmatched" } : { kind: "allow", rule: allowRule };
}

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.();
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

// Blank stays valid: some tool-call layers spell an unset field as "".
const SERVICE_NAME = type(/^(?:\s*|[A-Za-z0-9][A-Za-z0-9._-]{0,47})$/).describe(
	"starts a long-lived supervised service under this name; omit for finite commands, async jobs included. 1-48 of [A-Za-z0-9._-]",
);

const SERVICE_READY = type({
	"log?": type("string").describe("regex an output line matches once the service is ready"),
	"port?": type("number").describe("TCP port the service accepts connections on once ready"),
	"host?": type("string").describe("host for the port probe; default localhost (127.0.0.1 and ::1)"),
	"timeout?": type("number").describe("seconds to wait for readiness; default 30"),
}).describe("service readiness; needs log or port");

const bashSchemaBase = type({
	command: type("string"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
});

const bashSchemaWithAsync = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
});

const bashSchemaWithService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

const bashSchemaWithAsyncAndService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

// Without an interactive UI a finite command's `pty` can only fall back, so those sessions are not
// offered it; services keep it, since the daemon gives them a terminal of their own.
const bashSchemaBaseNoPty = bashSchemaBase.omit("pty");
const bashSchemaWithAsyncNoPty = bashSchemaWithAsync.omit("pty");

type BashToolSchema =
	| typeof bashSchemaBase
	| typeof bashSchemaWithAsync
	| typeof bashSchemaWithService
	| typeof bashSchemaWithAsyncAndService
	| typeof bashSchemaBaseNoPty
	| typeof bashSchemaWithAsyncNoPty;

export interface BashToolInput {
	command: string;
	timeout?: number;
	cwd?: string;
	name?: string;
	ready?: ServiceReady;
	async?: boolean;
	/**
	 * Regex; each output line it matches is reported while the command runs. Without `name` the command
	 * runs as a background job, as `async` does; with `name` the service reports.
	 */
	notify?: string;
	pty?: boolean;
}

const PTY_BOARD_COMMAND_MAX = 60;

/** A pty command as one board-label line of at most {@link PTY_BOARD_COMMAND_MAX} chars. */
function ptyBoardCommand(command: string): string {
	const line = command.replace(/\s+/gu, " ").trim();
	return line.length > PTY_BOARD_COMMAND_MAX ? `${line.slice(0, PTY_BOARD_COMMAND_MAX - 1)}…` : line;
}

/**
 * Treats a blank string as an unset field.
 *
 * Some tool-call layers materialize every optional argument, spelling "not set"
 * as `""`; a whitespace-only service name is no more a name than a missing one.
 */
function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Drops placeholder readiness fields, and the whole spec when it names no
 * condition (`log` or `port`): `host` and `timeout` only configure one. An
 * empty `log` pattern would otherwise match the first byte of output, an empty
 * `host` would break the TCP probe, and a zero `port` (how tool-call layers
 * materialize an unset number; no listener has it) would fail port validation,
 * so placeholder values must not reach {@link startService}.
 */
function normalizeReady(ready: ServiceReady | undefined): ServiceReady | undefined {
	if (!ready) return undefined;
	const log = blankToUndefined(ready.log);
	const port = Number.isFinite(ready.port) && ready.port !== 0 ? ready.port : undefined;
	if (log === undefined && port === undefined) return undefined;
	const host = blankToUndefined(ready.host);
	const timeout = Number.isFinite(ready.timeout) ? ready.timeout : undefined;
	return { log, host, port, timeout };
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	getLatestTrace: () => ShellTrace | undefined;
	/** Notices for this call's results, including the ones the run adds (URL writes). */
	notices: readonly string[];
	/** Hand the call's card to the job: later frames carry `details.async` and the last one settles it. */
	background: () => void;
	/** Text the run wrote to `out://` while the call was in the foreground, oldest first. */
	replies: readonly string[];
	/** Tool command dispatches of the run so far, in invocation order. */
	toolCommands: () => ToolCommandDispatch[];
}

interface BashProgressDetails extends BashToolDetails {
	images?: ImageContent[];
	/** A running job's output so far (`proc://` shows it). */
	output?: string;
}

/** Pid probe of a background job with no command in flight. */
const NO_PIDS = (): readonly number[] => [];

/**
 * Shown when a call ran in a fork of the session's busy shell (it overlapped a parallel or backgrounded call)
 * and what it set could not be carried back into the session's shell.
 */
const FORK_STATE_LOST_NOTICE = "Ran in a copy of the busy session shell; changes here won't persist.";
/** Shown when such a call left background jobs running: they stay in the copy. */
const FORK_JOBS_NOTICE =
	"Background jobs started here run in a copy of the busy session shell; later calls' jobs, wait and %N won't see them.";

/**
 * Names what a command changed in the session shell that the next call starts without: a `cd`
 * (calls start in `sessionCwd`) and `set -e`.
 */
function formatShellResetNotice(result: BashResult | BashInteractiveResult, sessionCwd: string): string | undefined {
	const reset: string[] = [];
	if ("movedCwd" in result && result.movedCwd) reset.push(`cwd → ${sessionCwd}`);
	if ("errexit" in result && result.errexit) reset.push("set -e off");
	return reset.length > 0 ? `Reset before the next call: ${reset.join(", ")}.` : undefined;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

/**
 * Incrementally decodes cumulative client-terminal snapshots. Normal snapshots
 * append only the unseen suffix; a host-side rolling/truncated window retires
 * the old decoder and starts from the replacement snapshot without losing
 * images already completed before the rollover.
 */
class TerminalSnapshotDecoder {
	#decoder = new TerminalGraphicsDecoder();
	#raw = "";
	#clean = "";
	#retiredImages: Array<Promise<ImageContent[]>> = [];

	push(snapshot: string): string {
		if (!snapshot.startsWith(this.#raw)) {
			this.#decoder.finish();
			this.#retiredImages.push(this.#decoder.images());
			this.#decoder = new TerminalGraphicsDecoder();
			this.#raw = "";
			this.#clean = "";
		}
		const suffix = snapshot.slice(this.#raw.length);
		this.#raw = snapshot;
		this.#clean += this.#decoder.push(suffix);
		return this.#clean;
	}

	async finish(snapshot: string): Promise<{ text: string; images: ImageContent[] }> {
		const text = this.push(snapshot) + this.#decoder.finish();
		const batches = await Promise.all([...this.#retiredImages, this.#decoder.images()]);
		return { text, images: batches.flat() };
	}
}

function formatTimeoutClampNotice(
	requestedTimeoutSec: number,
	effectiveTimeoutSec: number,
	maxTimeout: number,
): string | undefined {
	if (requestedTimeoutSec === effectiveTimeoutSec) return undefined;
	const cappedByGlobal = maxTimeout > 0 && effectiveTimeoutSec === maxTimeout && maxTimeout < TOOL_TIMEOUTS.bash.max;
	const limit = cappedByGlobal
		? `global tools.maxTimeout ceiling ${maxTimeout}s`
		: `allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s`;
	return `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; ${limit}).`;
}

/**
 * Records handler answers to a command's URL writes (`> proc://<id>/kill`, `> out://`) as
 * result notices: the shell itself shows only an errno for a refused write.
 */
function noticeUrlWrites(notices: string[]): (report: UrlWriteReport) => void {
	return ({ url, text, failed }) => {
		if (failed) notices.push(`Write to ${url} failed: ${text}`);
		else if (text) notices.push(`${url}: ${text}`);
	};
}

/** Explicit tool `cwd` keeps the workspace-root alias; a hoisted shell `cd` does not. */
function resolveCommandCwd(cwd: string | undefined, sessionCwd: string, hoistedShellCwd: boolean): string {
	if (!cwd) return sessionCwd;
	return hoistedShellCwd ? resolveShellDirectory(cwd, sessionCwd) : resolveToCwd(cwd, sessionCwd);
}

/** Words that may precede a simple command in a command list without being its name. */
const SHELL_COMMAND_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"!",
	"{",
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
	"time",
]);

/** Name of a command a simple command starts with, past leading assignments and list keywords. */
function simpleCommandName(words: readonly string[]): string | undefined {
	return words.find(word => !isShellEnvironmentAssignment(word) && !SHELL_COMMAND_PREFIX_WORDS.has(word));
}

/** First session tool command a simple command of `command` starts with. */
function invokedToolCommand(command: string, names: ReadonlySet<string>): string | undefined {
	if (names.size === 0) return undefined;
	for (const words of tokenizeShellSegments(command)) {
		const name = simpleCommandName(words);
		if (name !== undefined && names.has(name)) return name;
	}
	return undefined;
}

/** Whether the first simple command of `command` is a session tool command. */
function startsWithToolCommand(command: string, names: ReadonlySet<string>): boolean {
	const first = tokenizeShellSegments(command)[0]?.[0];
	return first !== undefined && names.has(first);
}

/** Operators that may join the commands of a line made only of tool commands. */
const TOOL_COMMAND_LINE_OPERATORS: Record<string, true> = {
	"": true,
	";": true,
	"&&": true,
	"||": true,
	"|": true,
	"|&": true,
};

/**
 * Whether every simple command of `command` invokes one of `names`, joined only by `;`, `&&`, `||`,
 * `|` and newlines, with no redirection, expansion or substitution, grouping, comment, backgrounding
 * or assignment prefix. Anything this scan cannot vouch for is not such a line.
 */
function isToolCommandLine(command: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0) return false;
	let commandStart = true;
	let commands = 0;
	for (const token of lexShellCommand(command)) {
		if (token.kind === "separator") {
			if (!Object.hasOwn(TOOL_COMMAND_LINE_OPERATORS, token.raw.replace(/[ \t\n]/gu, ""))) return false;
			if (/[\n;&|]/u.test(token.raw)) commandStart = true;
			continue;
		}
		if (/[<>`$\r]/u.test(token.raw) || token.raw.startsWith("#")) return false;
		if (commandStart) {
			if (!names.has(token.value)) return false;
			commands++;
			commandStart = false;
		}
	}
	return commands > 0;
}

/** Tool command dispatches of one bash run, in invocation order. */
class ToolCommandRecorder {
	#records: Array<ToolCommandDispatch | undefined> = [];
	#finished = new Set<number>();

	/** Record a finished dispatch. */
	finish(dispatch: ToolCommandDispatch, index: number): void {
		this.#records[index] = dispatch;
		this.#finished.add(index);
	}

	/** Record the partial details a running dispatch reported. */
	progress(dispatch: ToolCommandDispatch, index: number): void {
		if (this.#finished.has(index)) return;
		const current = this.#records[index];
		this.#records[index] = current ? { ...current, inner: dispatch.inner } : dispatch;
	}

	/** Records so far, in invocation order. */
	list(): ToolCommandDispatch[] {
		return this.#records.filter((record): record is ToolCommandDispatch => record !== undefined);
	}

	/** `details.toolCommands` for a frame or result; empty when nothing was dispatched. */
	details(): { toolCommands?: ToolCommandDispatch[] } {
		const toolCommands = this.list();
		return toolCommands.length > 0 ? { toolCommands } : {};
	}
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	/** Bash reads `skill://` paths through its shell filesystem, including as a working directory. */
	readonly readsSkillUris = true;
	/**
	 * The interceptor message for a call, checking the raw command and the one after a leading
	 * `cd … &&` so the wrapper hides neither shell-navigation rules nor the dedicated-tool command.
	 * A command led by a session tool command is that tool's own call and is never intercepted.
	 */
	#interception(
		rawCommand: string,
		command: string,
		name: string | undefined,
		toolNames: string[],
		toolCommands: ReadonlySet<string>,
	): string | undefined {
		if (!cfgBashInterceptorEnabled.get(this.session.settings)) return undefined;
		const rules = cfgBashInterceptorPatterns.get(this.session.settings).filter(rule => !name || rule.tool !== "bash");
		for (const commandToCheck of rawCommand === command ? [command] : [rawCommand, command]) {
			if (startsWithToolCommand(commandToCheck, toolCommands)) continue;
			const interception = checkBashInterception(commandToCheck, toolNames, rules, rawCommand);
			if (interception.block) return interception.message ?? "Command blocked";
		}
		return undefined;
	}

	/**
	 * Whether this line is pure tool-command traffic: every simple command is a mounted tool
	 * command (or a special command), joined only by `;`, `&&`, `||`, `|` and newlines, with no
	 * redirection, expansion, substitution or assignment — see {@link isToolCommandLine}. Such a
	 * line runs no program: it dispatches the same session tools a top-level call would, which is
	 * why a same-name extension replacement hands it back to this tool (#18339). Every other line
	 * stays the override's.
	 */
	servesToolCommandLine(command: string): boolean {
		return isToolCommandLine(command, new Set(toolCommandNames(this.session)));
	}

	readonly approval = (args: unknown, ctx?: AgentToolContext): ToolApprovalDecision => {
		const input = (args ?? {}) as Partial<BashToolInput>;
		const rawCommand = input.command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		// An intercepted call is refused outright; asking first would only approve a doomed call.
		const cwdCommand = input.cwd ? command : (extractLeadingCdTarget(command)?.rest ?? command);
		const name = typeof input.name === "string" ? blankToUndefined(input.name) : undefined;
		const toolCommands = new Set(toolCommandNames(this.session));
		const interception = this.#interception(command, cwdCommand, name, ctx?.toolNames ?? [], toolCommands);
		if (interception) {
			return { tier: "exec", override: true, policy: "deny", reason: interception.replace(/^Blocked:\s*/u, "") };
		}
		const { session: policy, authority } = this.#patternPolicies();
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		const compoundEnabled = !!shell && isPosixShell(shell);
		const compoundSegments = compoundEnabled ? extractApprovalShellSegments(command) : null;
		const base = input.cwd ? resolveToCwd(input.cwd, this.session.cwd) : this.session.cwd;
		// Sync approval sees configured/process PATH, not persistent-shell/direnv exports.
		// Execution has the latter via #sessionSeed; this snapshot limitation is deliberate.
		const searchPath = this.session.settings.getShellConfig().env?.PATH ?? process.env.PATH;
		const decision = resolveBashPatternDecision(command, compoundSegments, policy.rules, policy.allowedEnvVars, base, compoundEnabled, searchPath);
		// Project layers may tighten the operator's `bash.patterns`, never loosen
		// them: an operator deny or prompt still applies under a project allow.
		const authorityDecision =
			authority === policy
				? decision
				: resolveBashPatternDecision(command, compoundSegments, authority.rules, authority.allowedEnvVars, base, compoundEnabled, searchPath);
		const denied =
			authorityDecision.kind === "deny" ? authorityDecision : decision.kind === "deny" ? decision : undefined;
		if (denied) {
			return {
				tier: "exec",
				override: true,
				policy: "deny",
				reason: `Blocked by bash pattern: ${denied.rule.match}`,
			};
		}
		const prompted =
			authorityDecision.kind === "prompt" ? authorityDecision : decision.kind === "prompt" ? decision : undefined;
		if (prompted) {
			if (prompted.rule === LEGACY_CRITICAL_RULE || isCriticalBashCommand(command) || compoundSegments?.some(segment =>
				isCriticalBashCommand(segment.literal?.argv.join(" ") ?? segment.text))) {
				return { tier: "exec", override: true, policy: "prompt", reason: "Critical pattern detected" };
			}
			return {
				tier: "exec",
				override: true,
				policy: "prompt",
				reason: `Prompt required by bash pattern: ${prompted.rule.match}`,
			};
		}
		if (decision.kind === "critical" || authorityDecision.kind === "critical") {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		const criticalCommand = command !== "" && isCriticalBashCommand(command);
		if (!compoundSegments && criticalCommand) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		if (compoundSegments) {
			for (const segment of compoundSegments) {
				const literalCommand = segment.literal?.argv.join(" ") ?? segment.text;
				if (criticalCommand || isCriticalBashCommand(literalCommand)) {
					return { tier: "exec", override: true, reason: "Critical pattern detected" };
				}
			}
		}
		// Each tool command passes its own approval when it runs; the line itself only reads.
		if (isToolCommandLine(command, toolCommands)) return "read";
		const reason = decision.overrideClasses?.length
			? `P0 approval override: ${decision.overrideClasses.join(", ")}` : undefined;
		if (decision.kind === "allow") return { tier: "write", policy: "allow", ...(reason ? { reason } : {}) };
		return reason ? { tier: "exec", reason } : "exec";
	};
	/**
	 * `bash.patterns` rules and env allowlist for the session (`session`) and for the operator layers
	 * alone (`authority`, from `Settings.grantAuthority()`); `authority` is `session` when they agree.
	 * Shared by {@link approval} and the compound approval rows so both judge segments alike.
	 */
	#patternPolicies(): { session: BashPatternPolicy; authority: BashPatternPolicy } {
		const settings = this.session.settings;
		const rawPatterns = cfgBashPatterns.get(settings);
		const rawAllowedEnvVars = cfgBashAllowedEnvVars.get(settings);
		const session: BashPatternPolicy = {
			rules: getBashApprovalPatternRules(rawPatterns),
			allowedEnvVars: normalizeBashAllowedEnvList(rawAllowedEnvVars),
		};
		const authoritySettings = settings.grantAuthority?.();
		if (!authoritySettings) return { session, authority: session };
		const rawAuthorityPatterns = cfgBashPatterns.get(authoritySettings);
		const rawAuthorityAllowedEnvVars = cfgBashAllowedEnvVars.get(authoritySettings);
		if (rawAuthorityPatterns === rawPatterns && rawAuthorityAllowedEnvVars === rawAllowedEnvVars) {
			return { session, authority: session };
		}
		return {
			session,
			authority: {
				rules: getBashApprovalPatternRules(rawAuthorityPatterns),
				allowedEnvVars: normalizeBashAllowedEnvList(rawAuthorityAllowedEnvVars),
			},
		};
	}

	#formatCompoundApprovalDetails(command: string): string[] | null {
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		if (!shell || !isPosixShell(shell)) return null;
		const segments = extractAndChainSegments(command);
		if (!segments) return null;
		const { session: policy, authority } = this.#patternPolicies();
		// Whole-chain restrictions apply to the complete chain rather than individual segments.
		for (const rules of authority === policy ? [policy.rules] : [authority.rules, policy.rules]) {
			for (const rule of rules) {
				if (
					rule.approval !== "allow" &&
					commandMatchesBashApprovalPattern(command, rule.match) &&
					!segments.some(segment => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match))
				) {
					return null;
				}
			}
		}
		const segmentCritical = segments.map(segment => {
			const literalCommand = segment.literal?.argv.join(" ");
			return CRITICAL_BASH_PATTERNS.some(
				pattern => pattern.test(segment.text) || (literalCommand !== undefined && pattern.test(literalCommand)),
			);
		});
		const wholeChainOnlyCritical =
			command !== "" &&
			CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command)) &&
			!segmentCritical.some(Boolean);
		if (wholeChainOnlyCritical) return null;

		let chainUntainted = true;
		const rows: string[] = [];
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!;
			const isCritical = segmentCritical[i]!;
			const segmentRule = findBashApprovalPatternRule(segment.text, policy.rules, policy.allowedEnvVars);
			const authorityRule =
				authority === policy
					? segmentRule
					: findBashApprovalPatternRule(segment.text, authority.rules, authority.allowedEnvVars);
			const promptRule =
				authorityRule?.approval === "prompt"
					? authorityRule
					: segmentRule?.approval === "prompt"
						? segmentRule
						: undefined;
			const covered =
				chainUntainted &&
				segment.literal !== null &&
				!isCritical &&
				!promptRule &&
				authorityRule?.approval !== "deny" &&
				segmentRule?.approval === "allow";
			if (segment.mutatesShellState) chainUntainted = false;
			if (covered && segmentRule) {
				rows.push(`  ✓ ${truncateForPrompt(segment.text)} (allowed: ${segmentRule.match})`);
			} else {
				const reason = promptRule === LEGACY_CRITICAL_RULE || isCritical
					? "critical pattern"
					: promptRule
						? `prompt: ${promptRule.match}`
						: "requires approval";
				rows.push(`  ? ${truncateForPrompt(segment.text)} (${reason})`);
			}
		}
		return ["Command:", ...rows];
	}

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		if (typeof rawCommand === "string") {
			const compound = this.#formatCompoundApprovalDetails(command);
			if (compound) return compound;
		}
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		return prompt.render(bashDescription, {
			asyncEnabled: cfgAsyncEnabled.get(this.session.settings),
			// The deadline an omitted `timeout` resolves to, after the `tools.maxTimeout` cap.
			defaultTimeoutSec: clampTimeout("bash", undefined, cfgToolsMaxTimeout.get(this.session.settings)),
			autoBackgroundEnabled: cfgBashAutoBackgroundEnabled.get(this.session.settings),
			autoBackgroundSeconds: cfgBashAutoBackgroundThresholdMs.get(this.session.settings) / 1000,
			hasAstGrep: isToolActive("ast_grep", cfgAstGrepEnabled.get(this.session.settings)),
			hasAstEdit: isToolActive("ast_edit", cfgAstEditEnabled.get(this.session.settings)),
			hasGrep: isToolActive("grep", cfgGrepEnabled.get(this.session.settings)),
			hasGlob: isToolActive("glob", cfgGlobEnabled.get(this.session.settings)),
			hasFind: findHintVisible(this.session),
			hasRead: isToolActive("read", true),
			// Frozen at the last prompt rebuild (managed sessions). SDK consumers
			// building a bare ToolSession lack the rebuild lifecycle, so fall back
			// to the derived form (skillful && skills) instead of dropping the hint.
			hasSkills:
				(this.session.skillHintVisible ??
					(cfgSkillful.get(this.session.settings) && (this.session.skills?.length ?? 0) > 0)) === true,
			hasLaunch: this.#launchEnabled,
			hasPty: this.#ptyAvailable || this.#launchEnabled,
			hasEval: isToolActive("eval", evalBackends.python || evalBackends.js),
			// The embedded shell's session env is the shell config env (see bash-executor).
			builtins: shellBuiltins(this.session.settings.getShellConfig().env),
			isWindows: process.platform === "win32",
		});
	}
	/** Schema variant for the live `async.enabled` and `launch.enabled` settings and PTY availability. */
	get parameters(): BashToolSchema {
		const asyncEnabled = cfgAsyncEnabled.get(this.session.settings);
		if (this.#launchEnabled) return asyncEnabled ? bashSchemaWithAsyncAndService : bashSchemaWithService;
		if (this.#ptyAvailable) return asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		return asyncEnabled ? bashSchemaWithAsyncNoPty : bashSchemaBaseNoPty;
	}

	/** Whether `pty: true` can get a terminal: only an interactive UI hosts one. */
	get #ptyAvailable(): boolean {
		return this.session.hasUI && $env.PI_NO_PTY !== "1";
	}
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	/**
	 * URL filesystem for one embedded-shell run: this session's context, cancelled by the run's own
	 * signal. Without `onReply`/`onWrite` the run's writes to `out://` and other handler-written URLs
	 * are refused.
	 */
	#urlFilesystem(
		signal: AbortSignal | undefined,
		options: Omit<InternalUrlFilesystemOptions, "context">,
	): InternalUrlFilesystem {
		return new InternalUrlFilesystem({
			...options,
			context: sessionResolveContext(this.session, { signal }),
			// What the command's builtins and redirections write is journaled like an edit tool's write.
			onFileChange:
				this.session.recordFileChange &&
				(change => this.session.recordFileChange?.({ tool: "bash", ...shellChangeSnapshots(change) })),
		});
	}

	/**
	 * Session tool commands for one embedded shell run, plus `o2ctl` while services can launch;
	 * undefined when there are none. The handler lives as long as the run: `signal` is the run's
	 * own, and every tool dispatch lands in `recorder`, after which `onChange` re-emits the run's
	 * frame.
	 */
	#shellCommands(
		names: readonly string[],
		options: {
			toolCallId: string;
			signal: AbortSignal | undefined;
			context: AgentToolContext | undefined;
			recorder: ToolCommandRecorder;
			onChange?: () => void;
		},
	): ShellCommands | undefined {
		// A mounted tool of that name keeps it.
		const o2ctl = this.#launchEnabled && !names.includes(O2CTL_COMMAND);
		if (names.length === 0 && !o2ctl) return undefined;
		const { recorder, onChange } = options;
		const tools = createToolCommandHandler({
			session: this.session,
			toolCallId: options.toolCallId,
			signal: options.signal,
			context: options.context,
			onDispatch: (dispatch, index) => {
				recorder.finish(dispatch, index);
				onChange?.();
			},
			onProgress: (dispatch, index) => {
				recorder.progress(dispatch, index);
				onChange?.();
			},
		});
		return {
			names: o2ctl ? [...names, O2CTL_COMMAND] : [...names],
			handler: request =>
				o2ctl && request.name === O2CTL_COMMAND
					? runO2ctlCommand(this.session, request, options.signal)
					: tools(request),
		};
	}

	/**
	 * Session identity for a command ({@link sessionShellEnv}), read when its
	 * tool call starts, so `/fork`, `/new`, and `/resume` take effect on the next
	 * call while a call already under way keeps the session it began in.
	 * `PI_TOOL_CALL_ID` is the id this call runs under: the agent's call in the
	 * transcript, or the eval tool bridge's own id for a call made from an eval
	 * cell.
	 */
	#sessionEnv(toolCallId: string): Record<string, string> {
		const sessionId = owningSessionId(this.session) ?? "";
		return {
			...sessionShellEnv({ id: sessionId, file: this.session.getSessionFile() }),
			// Membership tag for processes the call leaves running (session-processes.ts).
			[BASH_SESSION_ENV]: sessionId,
			PI_TOOL_CALL_ID: toolCallId,
		};
	}

	/**
	 * Where the session's persistent shell stands, read from a copy of it, for a shell process
	 * (a service, a pty command) to start from: `env` holds what it exports (PATH included), as a
	 * child of that shell would see in the host directory `cwd` (its direnv environment
	 * included), and `script` defines its functions and aliases. Shell bookkeeping variables
	 * stay with the process's own shell.
	 */
	async #sessionSeed(
		sessionId: string | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<{ env: Record<string, string>; script: string }> {
		const dumpPath = path.join(os.tmpdir(), `omp-shell-env-${crypto.randomUUID()}`);
		const scriptPath = `${dumpPath}.sh`;
		const quote = (file: string): string => `'${file.replaceAll("'", `'\\''`)}'`;
		try {
			const sessionKey = sessionId ?? "";
			const dump = `env -0 > ${quote(dumpPath)} && { shopt -p expand_aliases; declare -f; alias -p; } > ${quote(scriptPath)} 2>/dev/null`;
			const result = await executeBash(dump, {
				cwd,
				// The same shell options as the session's calls, so the copy is of that session's shell.
				sessionKey: `${sessionKey}:async:service-env:${crypto.randomUUID()}`,
				seedSessionKey: sessionKey,
				minimize: !nativeShapingOff(this.session),
				gitGuard: cfgBashGitGuard.get(this.session.settings),
				ovnfs: ovnfsCommand(this.session.settings),
				timeout: 10_000,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.output || `env exited ${result.exitCode}`);
			const [dumped, script] = await Promise.all([Bun.file(dumpPath).text(), Bun.file(scriptPath).text()]);
			const env: Record<string, string> = {};
			for (const entry of dumped.split("\0")) {
				const eq = entry.indexOf("=");
				if (eq <= 0) continue;
				const key = entry.slice(0, eq);
				if (key === "PWD" || key === "OLDPWD" || key === "SHLVL" || key === "_") continue;
				env[key] = entry.slice(eq + 1);
			}
			return { env, script };
		} catch (error) {
			logger.warn("Could not read the session shell's state for a shell process", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { env: {}, script: "" };
		} finally {
			await Promise.all([fs.promises.rm(dumpPath, { force: true }), fs.promises.rm(scriptPath, { force: true })]);
		}
	}

	/**
	 * Run `command` as a shell process on a pseudo-terminal the user drives: the session's shell
	 * (its exports, functions and aliases, and the host files `mounts` puts behind its URL paths)
	 * leading a terminal of its own, so its programs own that terminal.
	 */
	async #runOnTerminal(
		ui: Pick<NonNullable<AgentToolContext["ui"]>, "custom">,
		run: {
			command: string;
			/** Host directory the process starts in. */
			hostCwd: string;
			/** URL directory its shell enters first. */
			urlCwd: string | undefined;
			sessionId: string | undefined;
			sessionEnv: Record<string, string>;
			timeoutMs: number | undefined;
			signal: AbortSignal | undefined;
			/** `urlmap` commands for the session's URL paths ({@link shellMounts}). */
			mounts: string;
		},
	): Promise<BashInteractiveResult> {
		const seed = await this.#sessionSeed(run.sessionId, run.hostCwd, run.signal);
		const script = run.mounts + seed.script;
		const source = script ? path.join(os.tmpdir(), `omp-shell-seed-${crypto.randomUUID()}.sh`) : undefined;
		// Set from the pty's start callback; a holder keeps the type from narrowing to `undefined`.
		const board: { entry?: BoardEntry } = {};
		try {
			if (source !== undefined) await fs.promises.writeFile(source, script, { mode: 0o600 });
			return await runInteractiveBashPty(ui, {
				command: run.command,
				...shellProcessCommand({ command: run.command, source, cwd: run.urlCwd }),
				cwd: run.hostCwd,
				env: { ...seed.env, ...run.sessionEnv },
				timeoutMs: run.timeoutMs,
				signal: run.signal,
				allocateArtifact: this.session.allocateOutputArtifact,
				onStart: pid => {
					board.entry = registerOnBoard({
						kind: "external",
						scope: { kind: "session", id: run.sessionId || `process-${process.pid}` },
						key: `pty:${pid}`,
						label: `pty: ${ptyBoardCommand(run.command)}`,
						pid,
					});
				},
			});
		} finally {
			// Resolves only after the pty program exited.
			board.entry?.dispose();
			if (source !== undefined) await fs.promises.rm(source, { force: true });
		}
	}

	/** Service launch mode: live `launch.enabled` while `bash` itself is an active tool. */
	get #launchEnabled(): boolean {
		return cfgLaunchEnabled.get(this.session.settings) === true && (this.session.isToolActive?.("bash") ?? true);
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		// A failed exit gets its own notice; a clean one says so, or an empty diff reads like a broken command.
		if (!outputText) return result.exitCode === 0 ? "(no output, exit code 0)" : "(no output)";
		return outputText;
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user aborts and a
	 * missing exit status. Timeouts are handled separately by
	 * #buildCompletedResult, which returns a non-throwing error result with
	 * details.timedOut=true so the renderer can show a warning border. The
	 * foreground and bridge callers plus the async job manager rely on these
	 * throwing so cancellations surface as aborts and jobs are recorded as
	 * failed. A definite non-zero exit is a completed command that failed;
	 * #buildCompletedResult surfaces it as an error *result* (carrying
	 * execution details) rather than a throw.
	 */
	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		const captureNotice = result.artifactError ? `\n\n[${formatArtifactErrorNotice(result.artifactError)}]` : "";
		if (result.cancelled) {
			// Local executor output already carries a leading `[Command cancelled]`
			// notice from the sink; PTY/bridge output does not, so annotate only
			// the latter.
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(`${annotated || "Command aborted"}${captureNotice}`);
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(`${out ? `${out}\n\n[${message}]` : message}${captureNotice}`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status${captureNotice}`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			command: string;
			cwd: string;
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			wallTimeMs?: number;
			/** Text the run wrote to `out://`. */
			replies?: readonly string[];
			/** The call the result answers; shapes the output under the session's Spotlight experiment. */
			toolCallId?: string;
			/** Tool command dispatches of the run, in invocation order. */
			toolCommands?: readonly ToolCommandDispatch[];
		},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const shaped =
			options.toolCallId === undefined
				? undefined
				: await this.#shapeOutput(result, options.toolCallId, options.command);
		const outputLines = [shaped?.text ?? this.#formatResultOutput(result)];
		const notices: string[] = [];
		const wallTimeMs = options.wallTimeMs;
		const wallTimeNoticeEmitted = wallTimeMs !== undefined && wallTimeMs >= WALL_TIME_NOTICE_MIN_MS;
		if (wallTimeNoticeEmitted) {
			notices.push(formatWallTimeNotice(wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		const resetNotice = formatShellResetNotice(result, this.session.cwd);
		if (resetNotice) notices.push(resetNotice);
		const fork = "fork" in result ? result.fork : undefined;
		if (fork && !fork.carried) notices.push(FORK_STATE_LOST_NOTICE);
		if (fork?.jobs) notices.push(FORK_JOBS_NOTICE);
		if (notices.length > 0) outputLines.push("", ...notices);
		// Shaped output already leads with its exit status.
		if (failedExit && !shaped?.text?.startsWith("[exit code ")) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Timeouts are not failures — the command ran its course. Return an error
		// result (isError=true for the model) but flag timedOut so the renderer
		// uses a warning border instead of error red. Both interactive and
		// non-interactive results carry an explicit `timedOut` field from the
		// executor/PTY layer.
		const isTimeout = result.timedOut === true;

		const details: BashToolDetails = { wallTimeNoticeEmitted };
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (wallTimeMs !== undefined) {
			details.wallTimeMs = wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}
		if (options.replies?.length) details.replies = [...options.replies];
		if (options.toolCommands?.length) details.toolCommands = [...options.toolCommands];
		if (shaped?.spotlight) details.spotlight = shaped.spotlight;
		// Native history is bounded; retain it whole so persisted calls remain replayable.
		const trace = "trace" in result ? result.trace : undefined;
		if (trace) details.trace = trace;

		// Final-defense inline cap config, shared by the timeout and normal
		// completion paths. The sink already bounds inline bodies to the spill
		// threshold, so with the notice slack this only fires on paths that
		// bypass the sink (client-bridge terminals, minimizer misses). When the
		// sink spilled, its artifact already holds the full raw stream — reuse
		// that id instead of saving a second (already-truncated) copy, so the
		// `[raw output: local://N.log]` footer and the truncation notice agree.
		const inlineCap = {
			maxBytes: resolveInlineByteCapBudget(this.session.settings),
			saveArtifact: result.artifactError
				? undefined
				: (full: string) => result.artifactId ?? saveBashOriginalArtifact(this.session, full),
		};

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			// executeBash has already emitted this leading sink notice. PTY output has not, and output shaped from the
			// artifact never carries it, so provide the LLM-facing annotation exactly once in the text sent.
			const lead = outputLines[0];
			if (lead !== `[${message}]` && !lead.startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), inlineCap);
			const timeoutBuilder = toolResult(details).content([
				{ type: "text", text: timeoutOutputText },
				...(result.images ?? []),
			]);
			if (!shaped?.whole) timeoutBuilder.truncationFromSummary(result, { direction: "tail" });
			return timeoutBuilder.error().done();
		}

		// Non-timeout cancellations and missing exit status still propagate as thrown errors.
		this.#throwIfUnfinished(result, timeoutSec, outputText);
		await invalidateGithubCacheForBashResult(options.command, options.cwd, result);

		// No-op for already-bounded output; see `inlineCap` above.
		const cappedOutputText = await enforceInlineByteCap(outputText, inlineCap);

		const resultBuilder = toolResult(details)
			.content([{ type: "text", text: cappedOutputText }, ...(result.images ?? [])])
			.minimized("minimized" in result ? result.minimized : undefined);
		// Output shaped from the whole spilled artifact no longer matches the sink's line ranges.
		if (!shaped?.whole) resultBuilder.truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	/**
	 * The command's output under the session's Spotlight shaping, or undefined when the session does not shape: `text`
	 * when shaping changed it, and the trace for the result's details. A spilled output, or one whose long lines the sink
	 * cut to its column cap, is shaped whole from its artifact (`whole`), up to {@link SPOTLIGHT_FULL_OUTPUT_MAX_BYTES}:
	 * shaping a capped line would only cut the preview further, past anything the cap dropped. Its savings still count
	 * against the capped text `plain` shows, truncation notice included, and a cut longer than that is not applied,
	 * except a short one when the column cap cut `plain` (`plainWidthCut`): the cap's preview leaves the rest to a read
	 * of the artifact. A result shaping does not cut (kept, held out, capped) stays as the sink built it, as under `plain`.
	 */
	async #shapeOutput(
		result: BashResult | BashInteractiveResult,
		toolCallId: string,
		command: string,
	): Promise<{ text?: string; whole: boolean; spotlight?: SpotlightDetails } | undefined> {
		const experiment = shapingExperiment(this.session);
		if (!experiment?.shapesTool("bash")) return undefined;
		const built = this.#formatResultOutput(result);
		let text = built;
		let whole = false;
		const widthCut = (result.columnTruncatedLines ?? 0) > 0;
		if (
			(result.truncated || widthCut) &&
			result.artifactId &&
			!result.artifactElidedBytes &&
			!result.artifactError &&
			result.totalBytes <= SPOTLIGHT_FULL_OUTPUT_MAX_BYTES
		) {
			const full = await experiment.readArtifact(result.artifactId);
			if (full !== null) {
				text = full;
				whole = true;
			}
		}
		const shaped = await shapeToolText(this.session, toolCallId, {
			tool: "bash",
			text,
			plain: built + formatOutputNotice(outputMeta().truncationFromSummary(result, { direction: "tail" }).get()),
			plainWidthCut: whole && widthCut,
			artifact: whole && result.artifactId ? spillUrl(result.artifactId) : undefined,
			command,
			exitCode: result.exitCode,
			source: command,
		});
		// Kept, held-out or capped text: the result stays as the sink built it (and keeps its truncation notice).
		return shaped.text === text
			? { whole: false, spotlight: shaped.spotlight }
			: { text: shaped.text, whole, spotlight: shaped.spotlight };
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			replies?: readonly string[];
			trace?: ShellTrace;
			toolCommands?: readonly ToolCommandDispatch[];
		} = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash" },
		};
		if (options.trace) details.trace = options.trace;
		if (options.replies?.length) details.replies = [...options.replies];
		if (options.toolCommands?.length) details.toolCommands = [...options.toolCommands];
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId, timeoutSec));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return text + formatOutputNotice(result.details?.meta);
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		/** A foreground wait races the job: updates stream to the caller and the row stays hidden until promoted. */
		foreground: boolean;
		/** Approval tier bounding the job's URL filesystem. */
		approvalTier: ToolTier;
		/** Session the call started in; its shell, even if the session changes before the job runs. */
		sessionId: string | undefined;
		/** That session's identity for the command (see {@link BashTool.#sessionEnv}). */
		sessionEnv: Record<string, string>;
		/** The model's `i` intent on the call, for the job's widget author. */
		intent?: string;
		/** The call that started the job. */
		toolCallId: string;
		/** Output lines to report while the job runs; see {@link BashToolInput.notify}. */
		notify?: NotifyPattern;
		/** Session tool command names installed for the run ({@link toolCommandNames}). */
		toolCommands: readonly string[];
		/** Tool context the run's tool commands execute under. */
		context?: AgentToolContext;
		/** A tool command is about to ask the user for approval while the call still waits on the run. */
		onApprovalPrompt?: () => void;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = formatAsyncJobLabel(options.command);
		// Holds the run's Shell only while it runs: a retained reference would
		// keep a finished `:async:` Shell (and its background children) alive.
		let pids: () => readonly number[] = NO_PIDS;
		// Outlives the run with the job row, so a finished pipeline stays readable.
		const streams = new PipeStreams();
		// The job's widget reads the command's own output and every pipe it opens.
		const outputTap = new TextTap("out", "the command's own stdout+stderr");
		const pipeSources = new PipeTextSources(streams);
		let latestText = "";
		// When the command last wrote its own output: the jobs sheet follows whichever source flows.
		let outputModified: number | undefined;
		let latestProgressDetails: BashProgressDetails | undefined;
		let backgrounded = !options.foreground;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();
		const notices = [...(options.notices ?? [])];
		const replies: string[] = [];
		const toolCommandRecorder = new ToolCommandRecorder();
		// The run's live trace; cleared once the result carries the final bounded snapshot.
		let liveTrace: ShellTrace | undefined;
		// While the call waits on the run, every frame of its card carries the replies so far and the
		// transcript draws the new ones. A backgrounded job's frames carry none: the call's result already did.
		// Every frame of a live run carries its latest trace and its tool command dispatches so far.
		const withReplies = (details: BashProgressDetails): BashProgressDetails => {
			const withTrace = liveTrace && details.trace === undefined ? { ...details, trace: liveTrace } : details;
			const withCommands = { ...withTrace, ...toolCommandRecorder.details() };
			return !backgrounded && replies.length > 0 ? { ...withCommands, replies: [...replies] } : withCommands;
		};
		// Replies reach the user only while the call waits on the run: once it returns, nothing draws them.
		const onReply = (text: string): void => {
			if (backgrounded) {
				throw new ToolError("out:// replies reach the user only while the command runs in the foreground.");
			}
			replies.push(text);
			options.onUpdate?.({
				content: [{ type: "text", text: latestText }],
				details: withReplies(latestProgressDetails ?? {}),
			});
		};
		// A prompt only promotes the run while the call still waits on it; once backgrounded it just waits for the user.
		const { onApprovalPrompt } = options;
		const toolContext =
			options.context && onApprovalPrompt
				? {
						...options.context,
						onApprovalPrompt: () => {
							if (!backgrounded) onApprovalPrompt();
						},
					}
				: options.context;

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				// Records the job's progress and shows it on the call's card: plain output
				// while the call still waits on it, the job frame (`details.async`) once
				// backgrounded, so the card keeps filling and settles with the job.
				const report = async (text: string, details: BashProgressDetails): Promise<void> => {
					latestText = text;
					const reported = reportProgress(text, { ...details });
					// `output` feeds job listings; the card already shows `text`.
					const { output: _output, ...frame } = details;
					options.onUpdate?.({
						content: [{ type: "text", text }],
						details: withReplies(backgrounded ? frame : (latestProgressDetails ?? {})),
					});
					await reported;
				};
				// `#execute` refused the call when this session has no notify channel.
				const notifier =
					options.notify && this.session.openAsyncNotify
						? new OutputNotifier(
								options.notify,
								outputTap,
								this.session.openAsyncNotify({
									id: jobId,
									type: "bash",
									command: options.command,
									pattern: options.notify.source,
									running: () => manager.getJob(jobId)?.status === "running",
								}),
							)
						: undefined;
				// A cancelled job reports nothing more, even while its command is still shutting down.
				if (notifier) runSignal.addEventListener("abort", () => notifier.stop(), { once: true });
				const wallTimeStart = performance.now();
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						env: options.sessionEnv,
						minimize: !nativeShapingOff(this.session),
						// A call that starts in the foreground runs in the session's
						// persistent shell, like the direct path, so its variables,
						// functions, and options reach the next call even after it is
						// backgrounded. A job that starts in the background gets its own
						// copy of the session's shell, so it sees what earlier calls set
						// but never holds the session's shell nor changes it.
						sessionKey: options.foreground ? options.sessionId : `${options.sessionId ?? ""}:async:${jobId}`,
						seedSessionKey: options.foreground ? undefined : (options.sessionId ?? ""),
						isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === options.sessionId,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						gitGuard: cfgBashGitGuard.get(this.session.settings),
						ovnfs: ovnfsCommand(this.session.settings),
						// Bound to the job's own signal: the job outlives the call that started it.
						filesystem: this.#urlFilesystem(runSignal, {
							tier: options.approvalTier,
							onReply,
							onWrite: noticeUrlWrites(notices),
							toolCallId: options.toolCallId,
						}).shellFilesystem(),
						speech: sessionShellSpeech(this.session),
						commands: this.#shellCommands(options.toolCommands, {
							toolCallId: options.toolCallId,
							// The job's own signal: the run outlives a call that returned when it was backgrounded.
							signal: runSignal,
							context: toolContext,
							recorder: toolCommandRecorder,
							onChange: () => {
								void report(latestText, {
									output: latestText,
									async: { state: "running", jobId, type: "bash" },
								});
							},
						}),
						allocateArtifact: this.session.allocateOutputArtifact,
						onChunk: chunk => {
							outputModified = Date.now();
							outputTap.append(chunk);
							notifier?.poll();
						},
						onPreview: text => {
							void report(text, { output: text, async: { state: "running", jobId, type: "bash" } });
						},
						onTrace: cfgDisplayShellVisualization.get(this.session.settings)
							? trace => {
									liveTrace = trace;
									void report(latestText, {
										output: latestText,
										async: { state: "running", jobId, type: "bash" },
									});
								}
							: undefined,
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
						streams,
						onStart: probe => {
							pids = probe;
						},
					}).finally(() => {
						pids = NO_PIDS;
						liveTrace = undefined;
						outputTap.close();
						// The result that follows carries the job's last output, matches included.
						notifier?.stop();
					});
					if (result.artifactError) latestProgressDetails = { meta: { artifactError: result.artifactError } };
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						command: options.command,
						cwd: options.commandCwd,
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices,
						wallTimeMs,
						replies: backgrounded ? undefined : replies,
						toolCallId: options.toolCallId,
						toolCommands: toolCommandRecorder.list(),
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					const images = finalResult.content.filter((block): block is ImageContent => block.type === "image");
					latestProgressDetails = {
						...finalResult.details,
						...(images.length > 0 ? { images } : {}),
					};
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await report(finalText, {
						...latestProgressDetails,
						async: { state: "completed", jobId, type: "bash" },
					});
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					completion.resolve({ kind: "failed", error });
					// Only a cancel aborts the job's own signal (deadlines end in a timed-out result).
					await report(message, {
						...latestProgressDetails,
						async: { state: runSignal.aborted ? "cancelled" : "failed", jobId, type: "bash" },
					});
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				foreground: options.foreground,
				process: {
					command: options.command,
					cwd: options.commandCwd,
					pids: () => pids(),
					streams,
					outputModified: () => outputModified,
					trace: () => liveTrace ?? latestProgressDetails?.trace,
				},
				intent: options.intent,
				widgetInputs: {
					sources: () => [outputTap, ...pipeSources.list()],
					brief: () => ({
						kind: "bash",
						command: options.command,
						timeoutSec: options.timeoutSec,
						intent: options.intent,
					}),
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			getLatestTrace: () => liveTrace ?? latestProgressDetails?.trace,
			notices,
			background: () => {
				backgrounded = true;
			},
			replies,
			toolCommands: () => toolCommandRecorder.list(),
		};
	}

	async execute(
		toolCallId: string,
		input: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		// The directory the command actually ran in, set once resolved. A hoisted
		// `cd <dir>; …` runs only the remainder, so renderers drawing the executed
		// script read the directory from here instead of re-parsing the command.
		const ran: { cwd?: string; cdSeparator?: ";" } = {};
		const stamp = (details: BashToolDetails | undefined): BashToolDetails | undefined =>
			ran.cwd === undefined
				? details
				: { ...details, cwd: ran.cwd, ...(ran.cdSeparator ? { cdSeparator: ran.cdSeparator } : {}) };
		const result = await this.#execute(
			toolCallId,
			input,
			ran,
			signal,
			onUpdate && (update => onUpdate({ ...update, details: stamp(update.details) })),
			ctx,
		);
		return { ...result, details: stamp(result.details) };
	}

	async #execute(
		toolCallId: string,
		{
			command: rawCommand,
			timeout: rawTimeout,
			cwd,
			name: rawName,
			ready: rawReady,
			async: rawAsync,
			notify: rawNotify,
			pty,
		}: BashToolInput,
		ran: { cwd?: string; cdSeparator?: ";" },
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;
		// The session this call belongs to, captured before any await: a session
		// change while the call waits must not move it into the new session's
		// shell, nor hand it the new session's identity.
		const sessionId = this.session.getSessionId?.() ?? undefined;
		const sessionEnv = this.#sessionEnv(toolCallId);

		// Extract a leading `cd <path> && ...` / `cd <path>; ...` into cwd when the
		// model ignores the cwd parameter. The scanner captures only a single path
		// token and defers to the shell for anything else (redirects, extra args,
		// shell expansion), so it never absorbs shell syntax like
		// `cd /tmp 2>/dev/null && ...` into the structured cwd. `&&` always hoists:
		// a missing directory fails early, as the shell would short-circuit. `;`
		// runs the rest even when `cd` fails, so it hoists only onto an existing host
		// directory; anything else (URL targets included) stays with the shell.
		// The target is a shell path: `/` is the filesystem root, not the workspace
		// alias an explicit tool `cwd` keeps.
		let hoistedShellCwd = false;
		if (!cwd) {
			const cd = extractLeadingCdTarget(command);
			const virtualTarget = cd !== null && InternalUrlRouter.instance().canHandle(cd.path);
			const semicolonDirectory =
				cd?.separator === ";" &&
				!virtualTarget &&
				(await fs.promises.stat(resolveShellDirectory(cd.path, this.session.cwd)).catch(() => null))?.isDirectory();
			if (cd && (cd.separator === "&&" || semicolonDirectory === true)) {
				hoistedShellCwd = !virtualTarget;
				cwd = cd.path;
				command = cd.rest;
				if (cd.separator === ";") ran.cdSeparator = ";";
			}
		}
		// Mode selection runs on normalized fields: a caller that materializes
		// every optional argument with empty or placeholder values still asked
		// for a plain command. Only `async: true` or a `notify` regex is an async
		// request, a blank `name` is no service name, and service-only fields
		// with nothing in them are not a service request.
		const name = blankToUndefined(rawName);
		const ready = normalizeReady(rawReady);
		const notifySource = blankToUndefined(rawNotify);
		// `notify` reports output while the command runs: a service does that as it is, and anything
		// else starts in the background as `async` does.
		const asyncRequested = rawAsync === true || (notifySource !== undefined && name === undefined);
		const pendingNotices: string[] = [];
		if (name !== undefined) {
			if (!this.#launchEnabled) throw new ToolError("Service launch is disabled in this session.");
			// Without a readiness condition nothing marks this as a service but `name`, while
			// async/timeout ask for a finite command: refuse rather than guess.
			if (ready === undefined && (rawAsync === true || rawTimeout !== undefined)) {
				throw new ToolError(
					"`name` starts a long-lived service, which takes no async or timeout. Omit `name` for a finite command (async jobs included), or drop async/timeout to start a service.",
				);
			}
			if (rawTimeout !== undefined)
				pendingNotices.push("Ignored timeout: service-only; readiness follows ready.timeout.");
			if (rawAsync === true)
				pendingNotices.push("Ignored async: service-only; a service start is asynchronous already.");
			// Host and timeout configure a readiness condition without naming one.
			if (
				ready === undefined &&
				(blankToUndefined(rawReady?.host) !== undefined || Number.isFinite(rawReady?.timeout))
			)
				pendingNotices.push("Ignored ready: it needs log or port; the service started without a readiness wait.");
		} else if (ready !== undefined) {
			pendingNotices.push("Ignored ready: service-only, and no service name was given.");
		}
		if (name === undefined && asyncRequested && !cfgAsyncEnabled.get(this.session.settings)) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}
		if (
			notifySource !== undefined &&
			!(name === undefined ? this.session.openAsyncNotify : this.session.queueServiceNotify)
		) {
			throw new ToolError("notify is unavailable in this session.");
		}
		// Compiled before anything runs: a bad regex fails the call instead of a job that never reports.
		// A service's regex is checked by `startService`.
		const notify = name === undefined && notifySource !== undefined ? compileNotifyPattern(notifySource) : undefined;
		// Tells the model which output reaches it before the command ends.
		const notifyNotice =
			notifySource === undefined
				? undefined
				: `Output lines matching /${notifySource}/ arrive as follow-ups while it runs.`;

		const toolCommandNameList = toolCommandNames(this.session);
		const toolCommands = new Set(toolCommandNameList);
		const interception = this.#interception(rawCommand, command, name, ctx?.toolNames ?? [], toolCommands);
		if (interception) throw new ToolError(interception);
		// Tool commands exist only in the embedded shell: a line naming one never leaves it.
		const invokedCommand = invokedToolCommand(command, toolCommands);
		if (invokedCommand !== undefined && pty === true) {
			throw new ToolError(
				`\`${invokedCommand}\` is a session tool command and cannot run in a PTY; run it without \`pty\`.`,
			);
		}
		// Models trained on Codex call the apply_patch tool as a shell command; omp ships no such
		// program, so a patch given that way goes to the tool (through its own approval).
		const shellPatch = applyPatchShellInput(command);
		if (shellPatch !== undefined && !$which("apply_patch")) {
			const applyPatch = this.session.getToolForEvalBridge?.("apply_patch");
			if (applyPatch?.customWireName === "apply_patch") {
				if (shellPatch === null) {
					throw new ToolError("apply_patch is a tool, not a shell command: call it with the patch text.");
				}
				const patched = await applyPatch.execute(toolCallId, { input: shellPatch }, signal, undefined, ctx);
				return { content: patched.content, isError: patched.isError, details: {} };
			}
		}

		const repaired = repairHeredocContinuations(command);
		if (repaired !== null) {
			pendingNotices.push(
				"Ran without the `\\` after `<<EOF &&`: a line continuation there makes the next line a command and starts the heredoc body after it. End such lines with the operator alone.",
			);
			command = repaired;
		}

		if (cfgWorktreeClone.get(this.session.settings)) {
			const rewritten = rewriteGitWorktreeAdd(command, resolveCliEntryCmd());
			if (rewritten !== command) {
				pendingNotices.push(
					"Ran `git worktree add` as `omp worktree add`: a copy-on-write clone of the checkout without .git, other worktrees, or untracked .env files. Set worktree.clone=false for plain git.",
				);
				command = rewritten;
			}
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		// URL paths resolve through the embedded shell's filesystem, within the
		// tier this command was approved at. A URL cwd stays a URL: only that
		// filesystem can enter it, so a service's or pty command's shell process
		// starts on the host and enters it, and the client terminal never runs there.
		const approval = this.approval({ command: rawCommand });
		const approvalTier = typeof approval === "string" ? approval : approval.tier;
		const router = InternalUrlRouter.instance();
		const virtualCwd = cwd && router.canHandle(cwd) ? router.normalize(cwd) : undefined;
		const commandCwd = virtualCwd ?? resolveCommandCwd(cwd, this.session.cwd, hoistedShellCwd);
		if (cwd) ran.cwd = commandCwd;
		// Where a process for this command starts: a URL directory has none of its own.
		const hostCwd = virtualCwd === undefined ? commandCwd : this.session.cwd;
		if (virtualCwd !== undefined) {
			const cwdStat = await this.#urlFilesystem(signal, { tier: approvalTier })
				.stat(virtualCwd)
				.catch((err: unknown) => {
					if (err instanceof UrlFsError && err.code === "ENOENT") {
						throw new ToolError(`Working directory does not exist: ${virtualCwd}`);
					}
					throw new ToolError(
						`Working directory ${virtualCwd} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			if (cwdStat.type !== "directory") {
				throw new ToolError(`Working directory is not a directory: ${virtualCwd}`);
			}
		} else {
			let cwdStat: fs.Stats;
			try {
				cwdStat = await fs.promises.stat(commandCwd);
			} catch (err) {
				if (isEnoent(err)) {
					throw new ToolError(`Working directory does not exist: ${commandCwd}`);
				}
				throw err;
			}
			if (!cwdStat.isDirectory()) {
				throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
			}
		}

		if (name !== undefined) {
			// The service is the session's shell as a process of its own: it starts from this
			// shell's exports, functions and aliases, with the host files behind its URL paths.
			const seed = await this.#sessionSeed(sessionId, hostCwd, signal);
			// Only a readiness wait can outlast a steer; without `ready` the start
			// returns once the process spawns.
			const service = await startService(
				this.session,
				{
					name,
					command,
					cwd: commandCwd,
					pty: pty ?? true,
					ready,
					notify: notifySource,
					env: { ...seed.env, ...sessionEnv },
					seed: (await shellMounts(sessionResolveContext(this.session), approvalTier)) + seed.script,
				},
				signal,
				ready === undefined ? undefined : ctx?.toolCall?.steeringSignal,
			);
			const daemon = service.daemon;
			const pid = daemon.pids[0];
			const notifyLine = service.notifyArmed ? notifyNotice : undefined;
			if (service.readyInterrupted) {
				// A queued message arrived mid-wait: return so it injects promptly.
				// The daemon keeps starting the service, inspectable via proc://.
				return {
					content: [
						{
							type: "text",
							text: `${name}: starting${pid === undefined ? "" : ` pid=${pid}`}\nReadiness wait interrupted early to handle an incoming message; the service is still starting and keeps running. Read proc://${name} for status.${notifyLine ? `\n${notifyLine}` : ""}`,
						},
					],
					details: { service: { name, state: daemon.state, ready: false, timedOut: false, pid } },
				};
			}
			const lines = [
				`${daemon.key}: ${daemon.state}${pid === undefined ? "" : ` pid=${pid}`}${daemon.readyAt === undefined ? "" : " ready"}`,
			];
			if (service.readyTimedOut)
				lines.push(
					`NOT ready — readiness timed out after ${ready?.timeout ?? 30}s; process state: ${daemon.state}.`,
				);
			if (daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			lines.push(...pendingNotices);
			if (notifyLine) lines.push(notifyLine);
			const log = await serviceLogs(this.session, name, signal);
			if (log) lines.push(log);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					service: {
						name,
						state: daemon.state,
						ready: daemon.readyAt !== undefined || daemon.state === "running",
						timedOut: service.readyTimedOut,
						pid,
					},
				},
			};
		}

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but OMP does not impose a deadline.
		const requestedTimeoutSec = rawTimeout ?? 300;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const maxTimeout = cfgToolsMaxTimeout.get(this.session.settings);
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec, maxTimeout);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec, maxTimeout);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: false,
				approvalTier,
				sessionId,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
				notify,
				toolCommands: toolCommandNameList,
				context: ctx,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: notifyNotice ? [...pendingNotices, notifyNotice] : pendingNotices,
				trace: job.getLatestTrace(),
			});
		}

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		// A line naming a tool command stays on the embedded shell, the only one that has them.
		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal &&
			clientBridge.createTerminal &&
			!pty &&
			virtualCwd === undefined &&
			invokedCommand === undefined,
		);

		const autoBgManager = this.session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		if (
			cfgBashAutoBackgroundEnabled.get(this.session.settings) &&
			!pty &&
			!bridgeTerminalAvailable &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(
				Math.floor(cfgBashAutoBackgroundThresholdMs.get(this.session.settings)),
				timeoutMs,
			);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			// A tool command about to ask the user promotes the run to the background at once.
			const approvalPrompt = Promise.withResolvers<{ kind: "approval" }>();
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: !startBackgrounded,
				approvalTier,
				sessionId,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
				toolCommands: toolCommandNameList,
				context: ctx,
				onApprovalPrompt: () => approvalPrompt.resolve({ kind: "approval" }),
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
					trace: job.getLatestTrace(),
					toolCommands: job.toolCommands(),
				});
			}
			// The job was registered as foreground-backed: hidden from listings and
			// delivery-suppressed until backgroundJob() promotes it, so a command
			// finishing within the wait never surfaces as a background job.
			const waitResult = await raceJobSettlement(
				Promise.race([job.completion, approvalPrompt.promise]),
				autoBackgroundWaitMs,
				signal,
				ctx?.toolCall?.steeringSignal,
			);
			if (waitResult.kind === "completed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.releaseForegroundJob(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.background();
			autoBgManager.backgroundJob(job.jobId);
			// "steer": a queued user/peer message arrived mid-wait — background
			// the command (it keeps running) so the message injects promptly.
			// "approval": a tool command is asking the user; the prompt stays open while the job runs on.
			// `job.notices` also carries the notices the run added so far.
			const notices =
				waitResult.kind === "steer"
					? [...job.notices, "Backgrounded early to handle an incoming message; the command keeps running."]
					: waitResult.kind === "approval"
						? [
								...job.notices,
								"Backgrounded while a tool command waits for the user's approval; the command keeps running.",
							]
						: job.notices;
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices,
				replies: job.replies,
				trace: job.getLatestTrace(),
				toolCommands: job.toolCommands(),
			});
		}

		// Fold direnv/devenv env into (command, env) ONCE for the one backend
		// that runs outside the engine: the ACP client terminal. The
		// `executeBash` branch below is intentionally excluded: it runs its own
		// preflight internally, so routing the pre-applied command there too
		// would double-apply the unset prefix. No
		// `commandPrefix` here: ACP applies the shell prefix via
		// `wrapShellLineForClientTerminal`.
		// `callerTimeoutMs` clamps the direnv load to a positive command timeout
		// (the backend's own timeout is installed only after this await), matching
		// the executeBash branch so a cold `.envrc` can't outlast a short call.
		const backendPreflight = bridgeTerminalAvailable
			? await applyDirenvPreflight(
					// The client's shell knows no internal URL.
					await hostCommandUrls(
						command,
						urlBacking(this.#urlFilesystem(signal, { tier: approvalTier })),
						this.session.settings.getShellConfig().shell,
					),
					commandCwd,
					{
						callerEnv: sessionEnv,
						signal,
						timeoutMs: cfgBashDirenvLoadTimeoutMs.get(this.session.settings),
						callerTimeoutMs: timeoutMs,
						direnvSetting: cfgBashDirenv.get(this.session.settings),
					},
				)
			: undefined;

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI), the cwd is a URL
		// (only the embedded shell's filesystem can enter it), or the line names a tool command.
		if (bridgeTerminalAvailable && clientBridge?.createTerminal) {
			// Invariant (ACP terminal bridge): createTerminal has no signal in its
			// contract; allocation cannot be cancelled retroactively. Guard before
			// allocation. Shared timeout helper / pure AbortSignal fusion rejected:
			// we need explicit kill-before-read ordering and distinct abort vs
			// timeout result shapes. Per-route race retained for testability.
			if (signal?.aborted) {
				throw new ToolAbortError("Command aborted");
			}

			const bridgeWallTimeStart = performance.now();
			const bridgeGraphics = new TerminalSnapshotDecoder();
			const killGraceMs = 1000;
			const outputSnapshotGraceMs = 2000;
			// Cancellable timeout: a bare Bun.sleep(timeoutMs) would leave a live,
			// ref'd timer for the full command timeout after fast completions —
			// accumulating timers and delaying process shutdown in SDK/headless use.
			// `timeoutMs` is optional (#4642): without one, no timer is armed and
			// the promise simply never resolves.
			const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{
				kind: "timeout";
			}>();
			const timeoutTimer = timeoutMs ? setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs) : undefined;
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let handle: ClientBridgeTerminalHandle | undefined;
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				const currentHandle = handle;
				if (!currentHandle) return Promise.resolve();
				killStarted = true;
				return currentHandle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: currentHandle.terminalId, error });
				});
			};
			const cleanupLateCreate = (createP: Promise<ClientBridgeTerminalHandle>): void => {
				void createP
					.then(async lateHandle => {
						try {
							await lateHandle.kill();
						} catch (error) {
							logger.warn("ACP terminal kill failed", { terminalId: lateHandle.terminalId, error });
						}
						try {
							await lateHandle.release();
						} catch (error) {
							logger.warn("ACP terminal release failed", { terminalId: lateHandle.terminalId, error });
						}
					})
					.catch((error: unknown) => {
						logger.warn("ACP terminal create failed after cancellation", { error });
					});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				// direnv-transformed command (carries any `unset -v` prefix) + direnv
				// env; falls back to the raw command when direnv is off/absent.
				const bridgeCommand = backendPreflight?.command ?? command;
				const bridgeEnv = backendPreflight?.env;
				const shellSpawn = wrapShellLineForClientTerminal(bridgeCommand, this.session.settings.getShellConfig());
				const createP = clientBridge.createTerminal({
					command: shellSpawn.command,
					args: shellSpawn.args,
					cwd: commandCwd,
					env: bridgeEnv
						? Object.entries(bridgeEnv).map(([name, value]) => ({ name, value: value as string }))
						: undefined,
					outputByteLimit: DEFAULT_MAX_BYTES,
				});
				const createRaced = await Promise.race([
					createP.then(createdHandle => ({ kind: "created" as const, handle: createdHandle })),
					timeoutPromise,
					abortedP.then(() => ({ kind: "aborted" as const })),
				]);
				if (createRaced.kind === "aborted" || signal?.aborted) {
					cleanupLateCreate(createP);
					throw new ToolAbortError("Command aborted");
				}
				if (createRaced.kind === "timeout") {
					cleanupLateCreate(createP);
					const timedOutResult: BashInteractiveResult = {
						output: "",
						exitCode: undefined,
						cancelled: false,
						timedOut: true,
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					return this.#buildCompletedResult(timedOutResult, timeoutSec, {
						command,
						cwd: commandCwd,
						requestedTimeoutSec,
						notices: pendingNotices,
						wallTimeMs: performance.now() - bridgeWallTimeStart,
						toolCallId,
					});
				}

				handle = createRaced.handle;

				// Emit partial update so the editor can embed the live terminal card.
				onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

				// Exit, timeout, and abort are each subscribed once and latch the first
				// outcome. Every wait below races only a fresh per-iteration promise, so
				// a long command does not pile reactions onto promises that stay pending.
				type BridgeOutcome =
					| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
					| { kind: "timeout" }
					| { kind: "aborted" }
					| { kind: "failed"; error: unknown };
				// Held on an object: TypeScript would narrow a closure-assigned `let` to `undefined`.
				const bridge: { outcome?: BridgeOutcome; wake?: () => void } = {};
				const settle = (next: BridgeOutcome): void => {
					bridge.outcome ??= next;
					bridge.wake?.();
				};
				void handle.waitForExit().then(
					status => settle({ kind: "exit", status }),
					(error: unknown) => settle({ kind: "failed", error }),
				);
				void timeoutPromise.then(settle);
				void abortedP.then(() => settle({ kind: "aborted" }));
				let exitStatus!: ClientBridgeTerminalExitStatus;
				let lastPolledOutput: ClientBridgeTerminalOutput = { output: "", truncated: false };

				// Poll until the process exits, times out, or the caller aborts.
				for (;;) {
					if (!bridge.outcome) {
						// The sleep settles within one tick even when an outcome wakes us first.
						const tick = Promise.withResolvers<void>();
						bridge.wake = tick.resolve;
						void Bun.sleep(250).then(tick.resolve);
						await tick.promise;
					}
					const outcome = bridge.outcome;

					if (outcome?.kind === "failed") throw outcome.error;

					if (outcome?.kind === "aborted" || signal?.aborted) {
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						throw new ToolAbortError("Command aborted");
					}

					if (outcome?.kind === "timeout") {
						// Kill before reading final output so a slow `terminal/output`
						// RPC cannot let a timed-out command keep running past the
						// enforced timeout. The handle stays valid post-kill so the
						// buffered output is still readable.
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						let current = lastPolledOutput;
						try {
							current = await Promise.race([
								handle.currentOutput(),
								Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
							]);
						} catch (error) {
							logger.warn("ACP terminal final output read failed", {
								terminalId: handle.terminalId,
								error,
							});
						}
						const decoded = await bridgeGraphics.finish(current.output);
						const timedOutText = await appendImageLinks(decoded.text, decoded.images);
						const timedOutResult: BashInteractiveResult = {
							output: timedOutText,
							exitCode: undefined,
							cancelled: false,
							timedOut: true,
							truncated: current.truncated,
							totalLines: timedOutText.length > 0 ? timedOutText.split("\n").length : 0,
							totalBytes: timedOutText.length,
							outputLines: timedOutText.length > 0 ? timedOutText.split("\n").length : 0,
							outputBytes: timedOutText.length,
							...(decoded.images.length > 0 ? { images: decoded.images } : {}),
						};
						return this.#buildCompletedResult(timedOutResult, timeoutSec, {
							command,
							cwd: commandCwd,
							requestedTimeoutSec,
							notices: pendingNotices,
							wallTimeMs: performance.now() - bridgeWallTimeStart,
							toolCallId,
						});
					}

					if (outcome?.kind === "exit") {
						exitStatus = outcome.status;
						break;
					}

					// Poll tick: push current output so agent-loop transcript stays consistent.
					// Race the read against the outcomes so a stuck `terminal/output` RPC does
					// not delay cancellation or let the command outlive its deadline.
					const interrupted = Promise.withResolvers<undefined>();
					bridge.wake = () => interrupted.resolve(undefined);
					const pollOutput = await Promise.race([handle.currentOutput(), interrupted.promise]);
					if (pollOutput === undefined) {
						// An outcome landed during the poll-tick read; let the next loop
						// iteration exit via the matching branch.
						continue;
					}
					lastPolledOutput = pollOutput;
					onUpdate?.({
						content: [{ type: "text", text: bridgeGraphics.push(pollOutput.output) }],
						details: { terminalId: handle.terminalId },
					});
				}

				// Fetch final output; the terminal is released in the outer finally.
				let finalOutput = lastPolledOutput;
				try {
					finalOutput = await Promise.race([
						handle.currentOutput(),
						Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
					]);
				} catch (error) {
					logger.warn("ACP terminal final output read failed", {
						terminalId: handle.terminalId,
						error,
					});
				}

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const decoded = await bridgeGraphics.finish(finalOutput.output);
				const outputText = await appendImageLinks(decoded.text, decoded.images);
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
					...(decoded.images.length > 0 ? { images: decoded.images } : {}),
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					command,
					cwd: commandCwd,
					requestedTimeoutSec,
					notices: bridgeNotices,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
					toolCallId,
				});
			} finally {
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbortSignal);
				if (handle) {
					const releaseHandle = handle;
					// Bound release like kill/output: a hung `terminal/release` RPC must not
					// keep the tool pending after the result is already decided.
					await Promise.race([
						releaseHandle.release().catch((error: unknown) => {
							logger.warn("ACP terminal release failed", { terminalId: releaseHandle.terminalId, error });
						}),
						Bun.sleep(killGraceMs),
					]);
				}
			}
		}

		const interactiveUi = canUseInteractiveBashPty(pty === true, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		// Each frame of the card repeats the latest preview with the replies so far; the transcript draws the new ones.
		const replies: string[] = [];
		const toolCommandRecorder = new ToolCommandRecorder();
		let preview = "";
		let trace: ShellTrace | undefined;
		const emitFrame = onUpdate
			? () =>
					onUpdate({
						content: [{ type: "text", text: preview }],
						details: {
							...(replies.length > 0 ? { replies: [...replies] } : {}),
							...(trace ? { trace } : {}),
							...toolCommandRecorder.details(),
						},
					})
			: undefined;
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await this.#runOnTerminal(interactiveUi, {
					command,
					hostCwd,
					urlCwd: virtualCwd,
					sessionId,
					sessionEnv,
					timeoutMs,
					signal,
					mounts: await shellMounts(sessionResolveContext(this.session, { signal }), approvalTier),
				})
			: // executeBash runs its OWN direnv preflight internally — pass the RAW
				// command here so the unset prefix is not applied twice.
				await executeBash(command, {
					cwd: commandCwd,
					env: sessionEnv,
					sessionKey: sessionId,
					minimize: !nativeShapingOff(this.session),
					isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === sessionId,
					timeout: timeoutMs ?? 0,
					signal,
					gitGuard: cfgBashGitGuard.get(this.session.settings),
					ovnfs: ovnfsCommand(this.session.settings),
					filesystem: this.#urlFilesystem(signal, {
						tier: approvalTier,
						onReply: text => {
							replies.push(text);
							emitFrame?.();
						},
						onWrite: noticeUrlWrites(pendingNotices),
						toolCallId,
					}).shellFilesystem(),
					speech: sessionShellSpeech(this.session),
					// The call is the run here: a tool command's approval prompt blocks it until answered.
					commands: this.#shellCommands(toolCommandNameList, {
						toolCallId,
						signal,
						context: ctx,
						recorder: toolCommandRecorder,
						onChange: emitFrame,
					}),
					allocateArtifact: this.session.allocateOutputArtifact,
					// Stream the sink's own inline view rather than re-buffering chunks.
					onPreview: emitFrame
						? text => {
								preview = text;
								emitFrame();
							}
						: undefined,
					onTrace:
						emitFrame && cfgDisplayShellVisualization.get(this.session.settings)
							? next => {
									trace = next;
									emitFrame();
								}
							: undefined,
					onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
				});
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			// A cancelled result is either a timeout (the command's deadline fired)
			// or a user/system abort. Timeouts are handled by #buildCompletedResult
			// which returns a non-throwing error result with details.timedOut=true
			// so the renderer can show a warning border instead of error red.
			// Both interactive and non-interactive results carry an explicit
			// `timedOut` field from the executor/PTY layer.
			const isTimeout = result.timedOut === true;
			if (!isTimeout) {
				const out = normalizeResultOutput(result);
				// The local executor already prepends `[Command cancelled]`; PTY
				// output does not, so preserve one cancellation notice in either case.
				let message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (result.artifactError) message += `\n\n[${formatArtifactErrorNotice(result.artifactError)}]`;
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			command,
			cwd: commandCwd,
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
			replies,
			toolCommands: toolCommandRecorder.list(),
			toolCallId,
		});
	}
}
