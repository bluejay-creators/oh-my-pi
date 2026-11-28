import { describe, expect, it } from "bun:test";
import {
	GIT_PUSH_CONFIG_PATTERN,
	isGitPushBranchConfigSafe,
	parseGitPushConfig,
} from "../../src/tools/bash-git-push-config";

const originRecord = "remote.origin.url\nssh://git@example.invalid/team/repo.git\0";

function parseWithOrigin(...records: string[]): ReadonlyMap<string, string> {
	const config = parseGitPushConfig(originRecord + records.map(record => `${record}\0`).join(""));
	if (config === undefined) throw new Error("Expected structurally valid Git configuration");
	return config;
}

describe("Git push configuration query", () => {
	it("selects every target-changing setting using the shared POSIX ERE subset", () => {
		// This exercises the common ERE/JS subset without invoking Git or a shell.
		expect(GIT_PUSH_CONFIG_PATTERN).not.toContain("(?");
		const pattern = new RegExp(GIT_PUSH_CONFIG_PATTERN);
		for (const key of [
			"remote.origin.url", "remote.origin.mirror", "remote.origin.push", "remote.origin.pushurl",
			"push.default", "push.followtags", "remote.pushdefault", "url.ssh://git@host/.pushinsteadof",
			"url..pushinsteadof", "branch.Feature.With.Dots/Topic.remote",
			"branch.Feature.With.Dots/Topic.pushremote", "branch.Feature.With.Dots/Topic.merge",
		]) {
			expect(pattern.test(key)).toBe(true);
		}
		for (const key of [
			"core.bare", "remote.other.url", "remote.Origin.url", "push.default.extra",
			"branch.topic.rebase", "url.base.insteadof", "prefix.remote.origin.url", "remote.origin.url.suffix",
		]) {
			expect(pattern.test(key)).toBe(false);
		}
	});
});

describe("parseGitPushConfig", () => {
	it("decodes NUL records, normalizes section/variable case, and preserves subsection identities", () => {
		const config = parseGitPushConfig(
			"REMOTE.origin.URL\nssh://git@example.invalid/repo\0" +
			"BRANCH.Feature.With.Dots/Topic.PushRemote\norigin\0" +
			"branch.Feature.With.Dots/Topic.Remote\nfetch-only\0" +
			"branch.Feature.With.Dots/Topic.Merge\nrefs/heads/Other.Topic\0",
		);
		expect(config?.get("remote.origin.url")).toBe("ssh://git@example.invalid/repo");
		expect(config?.get("branch.Feature.With.Dots/Topic.pushremote")).toBe("origin");
		expect(config?.get("branch.Feature.With.Dots/Topic.remote")).toBe("fetch-only");
		expect(config?.get("branch.Feature.With.Dots/Topic.merge")).toBe("refs/heads/Other.Topic");
		expect(config?.has("branch.feature.with.dots/topic.pushremote")).toBe(false);
	});

	it("preserves empty, whitespace, and multiline values rather than splitting on lines", () => {
		const config = parseWithOrigin(
			"branch.Topic.remote\n",
			"branch.Topic.merge\n refs/heads/topic \nsecond line\n",
			"remote.origin.pushurl\n\t \n ",
		);
		expect(config.get("branch.Topic.remote")).toBe("");
		expect(config.get("branch.Topic.merge")).toBe(" refs/heads/topic \nsecond line\n");
		expect(config.get("remote.origin.pushurl")).toBe("\t \n ");
		expect(isGitPushBranchConfigSafe(config, "Topic")).toBe(false);
	});

	it("collapses identical duplicates but rejects contradictory multi-valued URLs and merge refs", () => {
		const config = parseWithOrigin("PUSH.Default\nsimple", "push.default\nsimple");
		expect(config.get("push.default")).toBe("simple");
		expect(isGitPushBranchConfigSafe(config)).toBe(true);
		const repeatedMultiValue = parseWithOrigin(
			originRecord.slice(0, -1),
			"branch.Topic.merge\nrefs/heads/topic",
			"branch.Topic.merge\nrefs/heads/topic",
		);
		expect(repeatedMultiValue.get("branch.Topic.merge")).toBe("refs/heads/topic");
		expect(isGitPushBranchConfigSafe(repeatedMultiValue, "Topic")).toBe(true);
		for (const output of [
			originRecord + "remote.origin.url\nssh://other.invalid/repo\0",
			originRecord + "branch.Topic.merge\n\0branch.Topic.merge\nrefs/heads/topic\0",
		]) {
			expect(parseGitPushConfig(output)).toBeUndefined();
		}
	});

	it("uses the last configured scalar push.default rather than rejecting safe scope overrides", () => {
		for (const mode of ["current", "upstream"]) {
			const config = parseWithOrigin("push.default\nsimple", `PUSH.Default\n${mode}`);
			expect(config.get("push.default")).toBe(mode);
			expect(isGitPushBranchConfigSafe(config, "Topic")).toBe(true);
		}
		expect(isGitPushBranchConfigSafe(parseWithOrigin("push.default\nmatching", "push.default\ncurrent"))).toBe(true);
		expect(isGitPushBranchConfigSafe(parseWithOrigin("push.default\ncurrent", "push.default\nmatching"))).toBe(false);
	});

	it("uses the last global and selected-branch push remote, including unsafe-to-safe overrides", () => {
		for (const key of ["remote.pushdefault", "branch.Topic.pushremote"]) {
			const safe = parseWithOrigin(`${key}\nelsewhere`, `${key}\norigin`);
			expect(safe.get(key)).toBe("origin");
			expect(isGitPushBranchConfigSafe(safe, "Topic")).toBe(true);
			const unsafe = parseWithOrigin(`${key}\norigin`, `${key}\nelsewhere`);
			expect(unsafe.get(key)).toBe("elsewhere");
			expect(isGitPushBranchConfigSafe(unsafe, "Topic")).toBe(false);
		}
		const fetchRemote = parseWithOrigin("branch.Topic.remote\norigin", "BRANCH.Topic.Remote\nfetch-only");
		expect(fetchRemote.get("branch.Topic.remote")).toBe("fetch-only");
		expect(isGitPushBranchConfigSafe(fetchRemote, "Topic")).toBe(true);
	});

	it("keeps forbidden settings disqualifying when their final value is false or empty", () => {
		for (const key of [
			"remote.origin.mirror", "remote.origin.push", "remote.origin.pushurl", "push.followtags",
			"url.base.pushinsteadof",
		]) {
			for (const value of ["false", ""]) {
				expect(isGitPushBranchConfigSafe(parseWithOrigin(`${key}\ntrue`, `${key}\n${value}`))).toBe(false);
			}
		}
	});

	it("requires a nonempty origin URL to distinguish a successful proof query from missing origin", () => {
		for (const output of ["", "push.default\nsimple\0", "remote.origin.url\n\0", "remote.origin.url\n \t\n\0"]) {
			expect(parseGitPushConfig(output)).toBeUndefined();
		}
	});

	it("rejects truncated records, missing separators, malformed keys, and unqueried keys", () => {
		for (const output of [
			originRecord.slice(0, -1),
			originRecord + "push.default\nsimple",
			originRecord + "push.default\0",
			originRecord + "\0",
			originRecord + "\nsimple\0",
			originRecord + "push.default simple\0",
			originRecord + "push.\nsimple\0",
			originRecord + ".default\nsimple\0",
			originRecord + "branch..remote\norigin\0",
			originRecord + "branch.Topic\t.remote\norigin\0",
			originRecord + "push.default\r\nsimple\0",
			originRecord + "core.bare\nfalse\0",
			originRecord + "remote.Origin.url\nssh://elsewhere.invalid/repo\0",
			originRecord + "remote.other.pushurl\nssh://elsewhere.invalid/repo\0",
			originRecord + "url.base.insteadof\nssh://host/\0",
		]) {
			expect(parseGitPushConfig(output)).toBeUndefined();
		}
	});
});

describe("isGitPushBranchConfigSafe", () => {
	it("allows Git's builtin simple default and configured simple/current/upstream modes", () => {
		expect(isGitPushBranchConfigSafe(parseWithOrigin())).toBe(true);
		for (const mode of ["simple", "current", "upstream"]) {
			expect(isGitPushBranchConfigSafe(parseWithOrigin(`push.default\n${mode}`))).toBe(true);
		}
	});

	it("rejects matching, legacy tracking, and all unproven push.default values", () => {
		for (const mode of ["matching", "tracking", "nothing", "", "SIMPLE", " simple", "simple ", "simple\ncurrent"]) {
			expect(isGitPushBranchConfigSafe(parseWithOrigin(`push.default\n${mode}`))).toBe(false);
		}
	});

	it("rejects mirror, refspec, alternate URL, follow-tags, and URL rewrites by presence", () => {
		for (const key of [
			"remote.origin.mirror", "remote.origin.push", "remote.origin.pushurl", "push.followtags",
			"url.ssh://alternate.invalid/.pushinsteadof", "url..pushinsteadof",
		]) {
			for (const value of ["", "false", "true", "0", "refs/heads/*:refs/heads/*", "ssh://git@example.invalid/"]) {
				expect(isGitPushBranchConfigSafe(parseWithOrigin(`${key}\n${value}`))).toBe(false);
			}
		}
	});

	it("accepts only origin as a configured global push remote", () => {
		expect(isGitPushBranchConfigSafe(parseWithOrigin("remote.pushdefault\norigin"))).toBe(true);
		for (const remote of ["", ".", "upstream", "Origin", "origin ", "origin\nelsewhere"]) {
			expect(isGitPushBranchConfigSafe(parseWithOrigin(`remote.pushdefault\n${remote}`))).toBe(false);
		}
	});

	it("checks only the selected branch's push remote and preserves exact branch identity", () => {
		const config = parseWithOrigin(
			"branch.Feature.With.Dots/Topic.pushremote\nelsewhere",
			"branch.feature.with.dots/topic.pushremote\norigin",
			"branch.Other.pushremote\n",
		);
		expect(isGitPushBranchConfigSafe(config, "Feature.With.Dots/Topic")).toBe(false);
		expect(isGitPushBranchConfigSafe(config, "feature.with.dots/topic")).toBe(true);
		expect(isGitPushBranchConfigSafe(config, "Other")).toBe(false);
		expect(isGitPushBranchConfigSafe(config, "Unconfigured")).toBe(true);
		expect(isGitPushBranchConfigSafe(config)).toBe(true);
	});

	it("leaves fetch remote and upstream destination interpretation to the caller", () => {
		const config = parseWithOrigin(
			"branch.Topic.remote\nfetch-only",
			"branch.Topic.merge\nrefs/heads/main",
			"branch.Topic.pushremote\norigin",
			"push.default\nupstream",
		);
		expect(isGitPushBranchConfigSafe(config, "Topic")).toBe(true);
		expect(config.get("branch.Topic.remote")).toBe("fetch-only");
		expect(config.get("branch.Topic.merge")).toBe("refs/heads/main");
	});

	it("fails closed for missing origin or maps that did not satisfy the parser schema", () => {
		for (const config of [
			new Map<string, string>(),
			new Map([["remote.origin.url", ""]]),
			new Map([["remote.origin.url", " \t\n"]]),
			new Map([...parseWithOrigin(), ["core.bare", "false"]]),
			new Map([...parseWithOrigin(), ["PUSH.Default", "matching"]]),
			new Map([...parseWithOrigin(), ["branch.Topic.remote", "origin\0elsewhere"]]),
		]) {
			expect(isGitPushBranchConfigSafe(config, "Topic")).toBe(false);
		}
	});
});
