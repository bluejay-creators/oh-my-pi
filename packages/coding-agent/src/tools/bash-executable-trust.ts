import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isExecutable } from "@oh-my-pi/pi-utils";

const trustedSystemDirectories = [
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
	"/opt/homebrew/bin",
	"/nix/store",
	"/run/current-system/sw/bin",
];

function isWithin(candidate: string, directory: string): boolean {
	return candidate.startsWith(`${directory}/`);
}

function trustedDirectory(candidate: string, home: string): string | undefined {
	for (const directory of trustedSystemDirectories) {
		if (isWithin(candidate, directory)) return directory;
	}
	if (path.isAbsolute(home)) {
		const profileBin = path.join(home, ".nix-profile", "bin");
		if (isWithin(candidate, profileBin)) return profileBin;
	}
	return candidate.match(/^(\/etc\/profiles\/per-user\/[^/]+\/bin)\//)?.[1];
}

function hasUnprovableTraversal(candidate: string): boolean {
	const components = candidate.split("/");
	if (!components.includes("..")) return false;
	let prefix = "";
	try {
		for (const component of components) {
			if (!component) continue;
			prefix += `/${component}`;
			// realpath may normalize ".." before following symlinks. Inspect
			// each unnormalized prefix instead; mixed traversal fails closed.
			if (fs.lstatSync(prefix).isSymbolicLink()) return true;
		}
		return false;
	} catch {
		return true;
	}
}

function isTrustedCandidate(candidate: string, home: string): boolean {
	const directory = trustedDirectory(path.normalize(candidate), home);
	if (directory === undefined) return false;
	try {
		const root = fs.realpathSync(directory);
		const parent = fs.realpathSync(path.dirname(candidate));
		// The containing directory must remain inside its trusted anchor even
		// through nested directory symlinks.
		return parent === root || isWithin(parent, root);
	} catch {
		return false;
	}
}

/**
 * Prove executable provenance for approval classification, without executing it.
 * Trust belongs to the selected entry inside an approved bin/store directory,
 * not its basename or its eventual symlink target. File symlinks installed in
 * trusted bins are accepted (Homebrew Cellar and Nix profile layouts need this);
 * an untrusted entry pointing at /usr/bin/cat is still untrusted. Trusted bin
 * roots may themselves be symlinks, but nested directory escapes are rejected.
 * Paths mixing ".." with any symlink component are deliberately unprovable.
 *
 * PATH lookup is uncached and stops at its first executable file. An unknown cwd
 * makes an earlier relative/empty PATH entry unprovable, never safe to skip.
 * Returns the selected absolute entry path, preserving symlinks and traversal
 * so callers can execute exactly the file whose provenance was checked.
 */
export function resolveTrustedApprovalExecutable(
	executable: string,
	searchPath: string | undefined = process.env.PATH,
	cwd?: string,
	home: string = os.homedir(),
): string | undefined {
	if (!executable || executable.includes("\0")) return undefined;
	if (path.isAbsolute(executable)) {
		return !hasUnprovableTraversal(executable) && isExecutable(executable) && isTrustedCandidate(executable, home)
			? executable
			: undefined;
	}
	if (executable.includes("/") || searchPath === undefined) return undefined;

	for (const entry of searchPath.split(path.delimiter)) {
		let directory = entry;
		if (!path.isAbsolute(directory)) {
			if (cwd === undefined || !path.isAbsolute(cwd)) return undefined;
			// Preserve traversal for filesystem lookup: normalizing before lookup
			// would change the meaning of a directory symlink followed by "..".
			directory = `${cwd}/${entry || "."}`;
		}
		const candidate = `${directory}/${executable}`;
		if (hasUnprovableTraversal(candidate)) return undefined;
		if (isExecutable(candidate)) return isTrustedCandidate(candidate, home) ? candidate : undefined;
	}
	return undefined;
}
