// git config uses POSIX EREs, not JavaScript's noncapturing-group syntax.
export const GIT_PUSH_CONFIG_PATTERN =
	"^(remote[.]origin[.](url|mirror|push|pushurl)|push[.](default|followtags)|remote[.]pushdefault|url[.].*[.]pushinsteadof|branch[.].+[.](remote|pushremote|merge))$";

const pushConfigKeyPattern = new RegExp(GIT_PUSH_CONFIG_PATTERN);

function normalizePushConfigKey(key: string): string | undefined {
	if (/[\x00-\x1f\x7f]/.test(key)) return undefined;
	const firstDot = key.indexOf(".");
	const lastDot = key.lastIndexOf(".");
	if (firstDot <= 0) return undefined;
	const section = key.slice(0, firstDot).toLowerCase();
	const variable = key.slice(lastDot + 1).toLowerCase();
	// Only section and variable names are case-insensitive; subsections are identities.
	const normalized =
		firstDot === lastDot
			? `${section}.${variable}`
			: `${section}.${key.slice(firstDot + 1, lastDot)}.${variable}`;
	return pushConfigKeyPattern.test(normalized) ? normalized : undefined;
}

/** Parse git config --null --get-regexp output without trimming values. */
export function parseGitPushConfig(output: string): ReadonlyMap<string, string> | undefined {
	if (!output.endsWith("\0")) return undefined;
	const config = new Map<string, string>();
	for (const record of output.slice(0, -1).split("\0")) {
		const separator = record.indexOf("\n");
		if (separator <= 0) return undefined;
		const key = normalizePushConfigKey(record.slice(0, separator));
		if (key === undefined) return undefined;
		const value = record.slice(separator + 1);
		// URLs and merge refs are multi-valued; scalar selectors use Git's last-value precedence.
		const multiValued = key === "remote.origin.url" || (key.startsWith("branch.") && key.endsWith(".merge"));
		if (multiValued && config.has(key) && config.get(key) !== value) return undefined;
		config.set(key, value);
	}
	if (!config.get("remote.origin.url")?.trim()) return undefined;
	return config;
}

/** Prove configuration cannot widen a branch push; target/upstream proof is the caller's job. */
export function isGitPushBranchConfigSafe(config: ReadonlyMap<string, string>, branch?: string): boolean {
	if (!config.get("remote.origin.url")?.trim()) return false;
	for (const [key, value] of config) {
		if (normalizePushConfigKey(key) !== key || value.includes("\0")) return false;
		if (
			key === "remote.origin.mirror" ||
			key === "remote.origin.push" ||
			key === "remote.origin.pushurl" ||
			key === "push.followtags" ||
			(key.startsWith("url.") && key.endsWith(".pushinsteadof"))
		) {
			// Presence is disqualifying, including an empty value or the boolean false.
			return false;
		}
	}
	const pushDefault = config.get("push.default");
	if (pushDefault !== undefined && pushDefault !== "simple" && pushDefault !== "current" && pushDefault !== "upstream") {
		return false;
	}
	const pushRemote = config.get("remote.pushdefault");
	if (pushRemote !== undefined && pushRemote !== "origin") return false;
	if (branch !== undefined) {
		const branchPushRemote = config.get(`branch.${branch}.pushremote`);
		if (branchPushRemote !== undefined && branchPushRemote !== "origin") return false;
	}
	return true;
}
