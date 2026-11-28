import { describe, expect, it } from "bun:test";
import { isReadOnlyGitApprovalArgv } from "@oh-my-pi/pi-coding-agent/tools/bash-git-readonly";

describe("isReadOnlyGitApprovalArgv", () => {
	it("accepts literal read commands and flags represented in the real corpus", () => {
		const commands = [
			["diff", "--stat"],
			["log", "--oneline", "-5"],
			["log", "-1", "--format=%H"],
			["log", "-1", "--format=%h", "--", "skills/alert-triage/SKILL.md"],
			["log", "-5", "--format=%h %s", "origin/main", "--", "docs/design/acp-host-seam.md"],
			["ls-files", "*daemon*", "*worker-selectors*"],
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
			["ls-files", "--stage", "--", ".terraform.lock.hcl", ".terraform/providers"],
			["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "HEAD"],
			["rev-parse", "--show-toplevel", "--is-inside-work-tree"],
			["rev-parse", "HEAD"],
			["show", "--format=", "452fb70", "--", "bin/fm_durable_service.py"],
			["show", "--format=short", "21f9f2d", "--", "docs/design/acp-host-seam.md"],
			["show", "--stat", "--oneline", "452fb70"],
			["show", "HEAD"],
			["status"],
			["status", "--porcelain=v1", "--branch"],
			["status", "--short", "--branch", "--", "ide/state.md"],
		];
		for (const args of commands) expect(isReadOnlyGitApprovalArgv(["git", ...args])).toBe(true);
	});

	it("binds short options, clusters and operands to their own command", () => {
		const commands = [
			["grep", "-c", "pattern"],
			["grep", "-nFi", "-e", "literal pattern", "HEAD", "--", "src"],
			["grep", "-C3", "pattern"],
			["grep", "-C", "3", "pattern"],
			["log", "-n3", "HEAD~2..HEAD"],
			["grep", "-o", "pattern"],
			["log", "-n", "3", "--format", "%h %s"],
			["diff", "-U3", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"],
			["diff", "-Sneedle", "--diff-filter=AM", "--color=never"],
			["status", "-sb", "--porcelain"],
			["rev-list", "--count", "--max-count=20", "HEAD"],
			["ls-tree", "-rz", "HEAD", "src"],
			["cat-file", "-p", "HEAD:src/file.ts"],
			["for-each-ref", "--format=%(refname)", "--count", "3", "refs/heads"],
		];
		commands.push(["ls-files", "-o", "result"]);
		for (const args of commands) expect(isReadOnlyGitApprovalArgv(["git", ...args])).toBe(true);
		for (const args of [["log", "-c"], ["diff", "-c"], ["status", "-n"], ["grep", "-n3", "pattern"], ["show", "-poresult"]]) {
			expect(isReadOnlyGitApprovalArgv(["git", ...args])).toBe(false);
		}
	});

	it("rejects output writes and executable options, attached or separate", () => {
		for (const command of ["log", "show", "status", "diff", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "for-each-ref", "grep"]) {
			for (const args of [
				["--output", "result"], ["--output=result"], ["--output-indicator-new=X"],
				["--output-future=result"], ["--ext-diff"], ["--ext-diff=helper"],
				["--textconv"], ["--textconv=helper"], ["-Oorder"], ["-O", "order"],
				...(command === "grep" || command === "ls-files" ? [] : [["-oresult"], ["-o", "result"]]), ["--future-option"],
				["--config-env=alias.x=ENV"], ["--config-env", "alias.x=ENV"],
			]) expect(isReadOnlyGitApprovalArgv(["git", command, ...args]), `${command} ${args.join(" ")}`).toBe(false);
		}
		for (const args of [
			["grep", "--open-files-in-pager"], ["grep", "--open-files-in-pager=helper"],
			["grep", "--open-files-in-pager", "helper"], ["grep", "--pre=helper"],
			["grep", "--pre", "helper"], ["grep", "-phelper"],
			["cat-file", "--filters", "HEAD:file"], ["cat-file", "--textconv", "HEAD:file"],
			["for-each-ref", "--shell"], ["for-each-ref", "--python"],
			["format-patch", "-o", "result", "HEAD"],
		]) expect(isReadOnlyGitApprovalArgv(["git", ...args])).toBe(false);
	});

	it("fails closed on missing or invalid operands and mixed unsafe clusters", () => {
		for (const args of [
			["log", "--max-count"], ["log", "--max-count="], ["log", "--max-count=many"],
			["log", "-n"], ["log", "-n3p"], ["log", "-pn"], ["log", "--format"],
			["diff", "--unified", "--stat"], ["diff", "-U"], ["diff", "-Ubad"],
			["diff", "--color=execute"], ["diff", "--stat=result"],
			["status", "--porcelain=v3"], ["grep", "-C"], ["grep", "-C-2", "pattern"],
			["grep", "-e"], ["grep", "-nOhelper", "pattern"],
			["for-each-ref", "--count", "-1"], ["ls-files", "--exclude"],
		]) expect(isReadOnlyGitApprovalArgv(["git", ...args])).toBe(false);
	});

	it("rejects unnormalized globals and unknown commands without inventing defaults", () => {
		for (const argv of [
			[], ["git"], ["other", "status"], ["git", "future-command"], ["git", "toString"],
			["git", "-c", "alias.x=!helper", "status"], ["git", "-calias.x=!helper", "status"],
			["git", "--config-env=alias.x=ENV", "status"], ["git", "-C", "/repo", "status"],
			["git", "--git-dir=/repo", "status"],
		]) expect(isReadOnlyGitApprovalArgv(argv)).toBe(false);
	});

	it("honors end-options as literal data, but not when an operand is missing", () => {
		for (const command of ["log", "show", "status", "diff", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "for-each-ref", "grep"]) {
			expect(isReadOnlyGitApprovalArgv(["git", command, "--", "--output=literal", "-O", "--ext-diff"])).toBe(true);
		}
		expect(isReadOnlyGitApprovalArgv(["git", "rev-parse", "--end-of-options", "--output=literal"])).toBe(true);
		expect(isReadOnlyGitApprovalArgv(["git", "grep", "-e", "--", "pattern"])).toBe(false);
		expect(isReadOnlyGitApprovalArgv(["git", "diff", "--unified", "--", "file"])).toBe(false);
	});
});
