import { describe, expect, it } from "bun:test";
import { unwrapOrdinaryApprovalEnv } from "@oh-my-pi/pi-coding-agent/tools/bash-env-wrapper";

describe("unwrapOrdinaryApprovalEnv", () => {
	it("unwraps env without assignments and leaves executable trust to the caller", () => {
		for (const executable of ["env", "/usr/bin/env", "/tmp/env"]) {
			expect(unwrapOrdinaryApprovalEnv([executable, "git", "status"])).toEqual({
				argv: ["git", "status"],
				unknown: [],
				assignments: [],
			});
		}
	});

	it("preserves literal ordinary assignments, including empty values and additional equals", () => {
		expect(unwrapOrdinaryApprovalEnv(["env", "NO_COLOR=1", "TERM=a=b", "LANG=", "git", "status", "--short"])).toEqual({
			argv: ["git", "status", "--short"],
			unknown: [],
			assignments: ["NO_COLOR=1", "TERM=a=b", "LANG="],
		});
	});

	it("accepts only the approved presentation and locale names", () => {
		for (const name of [
			"NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "CLICOLOR_CUSTOM",
			"TERM", "COLUMNS", "LINES", "CI", "LANG", "LC_ALL", "LC_CTYPE", "LC_CUSTOM", "TZ",
			"BLUEJAY_PUSH_APPROVED",
		]) {
			expect(unwrapOrdinaryApprovalEnv(["env", `${name}=value`, "git", "status"])).toEqual({
				argv: ["git", "status"],
				unknown: [],
				assignments: [`${name}=value`],
			});
		}
	});

	it("allows only literal zero for GIT_TERMINAL_PROMPT", () => {
		expect(unwrapOrdinaryApprovalEnv(["env", "GIT_TERMINAL_PROMPT=0", "git", "status"])).toEqual({
			argv: ["git", "status"],
			unknown: [],
			assignments: ["GIT_TERMINAL_PROMPT=0"],
		});
		for (const value of ["", "1", "00", "false", "0=extra", "0 "]) {
			expect(unwrapOrdinaryApprovalEnv(["env", `GIT_TERMINAL_PROMPT=${value}`, "git", "status"])).toBeUndefined();
		}
		expect(unwrapOrdinaryApprovalEnv(["env", "GIT_TERMINAL_PROMPT=0", "git", "status"], [1])).toBeUndefined();
	});

	it("does not turn ordinary or approval-looking assignments into payload authorization", () => {
		expect(unwrapOrdinaryApprovalEnv(["env", "NO_COLOR=1", "BLUEJAY_PUSH_APPROVED=1", "git", "push", "--force", "origin", "main"])).toEqual({
			argv: ["git", "push", "--force", "origin", "main"],
			unknown: [],
			assignments: ["NO_COLOR=1", "BLUEJAY_PUSH_APPROVED=1"],
		});
	});

	it("rejects environment names that change executable resolution, configuration, or proxying", () => {
		for (const name of [
			"GIT_DIR", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "MARUT_ENV", "MARUT_CONFIG",
			"PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
			"BASH_ENV", "ENV", "HTTP_PROXY", "https_proxy", "No_PrOxY", "CUSTOM_proxy",
			"HOME", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "NODE_OPTIONS", "BUN_OPTIONS", "PYTHONPATH",
			"PAGER", "EDITOR", "LABEL", "EMPTY", "no_color", "LANGUAGE", "TERMINFO", "GIT_TERMINAL_PROMPT",
		]) {
			expect(unwrapOrdinaryApprovalEnv(["env", `${name}=value`, "git", "status"])).toBeUndefined();
		}
	});

	it("rejects every env option and the end-options separator before the payload", () => {
		for (const option of [
			"-", "--", "-i", "--ignore-environment", "-u", "--unset=PATH", "-S", "--split-string=git status",
			"-C", "--chdir=/tmp", "--argv0=git", "--help", "--version", "--unknown",
		]) {
			for (const assignments of [[], ["NO_COLOR=1"]]) {
				expect(unwrapOrdinaryApprovalEnv(["env", ...assignments, option, "git", "status"])).toBeUndefined();
			}
		}
	});

	it("rejects non-env invocations, missing payloads and malformed assignments", () => {
		for (const argv of [
			[], ["git", "status"], ["printenv", "git"], ["/usr/bin/environment", "git"],
			["env"], ["env", "NO_COLOR=1"], ["env", ""], ["env", "NO_COLOR=1", ""],
			["env", "=value", "git"], ["env", "1NAME=value", "git"], ["env", "BAD-NAME=value", "git"],
		]) expect(unwrapOrdinaryApprovalEnv(argv)).toBeUndefined();
	});

	it("rejects unknown wrapper, assignment and payload executable positions", () => {
		for (const index of [0, 1, 2]) {
			expect(unwrapOrdinaryApprovalEnv(["env", "NO_COLOR=1", "git", "status"], [index])).toBeUndefined();
		}
		expect(unwrapOrdinaryApprovalEnv(["env", "git", "status"], [1])).toBeUndefined();
	});

	it("shifts unknown payload argument indices without treating them as known", () => {
		expect(unwrapOrdinaryApprovalEnv(["env", "NO_COLOR=1", "TERM=a=b", "git", "log", "revision", "--", "file"], [5, 7])).toEqual({
			argv: ["git", "log", "revision", "--", "file"],
			unknown: [2, 4],
			assignments: ["NO_COLOR=1", "TERM=a=b"],
		});
		expect(unwrapOrdinaryApprovalEnv(["env", "git", "show", "revision"], [3])).toEqual({
			argv: ["git", "show", "revision"],
			unknown: [2],
			assignments: [],
		});
	});

	it("leaves all trailing payload arguments intact instead of interpreting them as env syntax", () => {
		expect(unwrapOrdinaryApprovalEnv(["env", "NO_COLOR=1", "git", "status", "--", "PATH=literal", "-S", "file"])).toEqual({
			argv: ["git", "status", "--", "PATH=literal", "-S", "file"],
			unknown: [],
			assignments: ["NO_COLOR=1"],
		});
	});
});
