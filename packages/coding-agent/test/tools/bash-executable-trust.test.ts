import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTrustedApprovalExecutable } from "../../src/tools/bash-executable-trust";

let temporary: string;
let home: string;
let trustedBin: string;
let untrustedBin: string;

async function executable(filename: string): Promise<string> {
	await Bun.write(filename, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(filename, 0o755);
	return filename;
}

beforeEach(() => {
	temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-executable-trust-")));
	home = path.join(temporary, "home");
	trustedBin = path.join(home, ".nix-profile", "bin");
	untrustedBin = path.join(temporary, "untrusted");
	fs.mkdirSync(trustedBin, { recursive: true });
	fs.mkdirSync(untrustedBin);
});

afterEach(() => {
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe("resolveTrustedApprovalExecutable", () => {
	it("accepts existing system executables by absolute path or explicit trusted PATH", () => {
		for (const [name, directory] of [["cat", "/bin"], ["env", "/usr/bin"]] as const) {
			expect(resolveTrustedApprovalExecutable(`${directory}/${name}`, "", undefined, home)).toBe(`${directory}/${name}`);
			expect(resolveTrustedApprovalExecutable(name, directory, undefined, home)).toBe(`${directory}/${name}`);
		}
	});

	it("never gives real temporary cat or git programs a trusted basename", async () => {
		for (const name of ["cat", "git"]) {
			const fake = await executable(path.join(untrustedBin, name));
			expect(resolveTrustedApprovalExecutable(fake, "/bin", undefined, home)).toBeUndefined();
			expect(resolveTrustedApprovalExecutable(name, untrustedBin, undefined, home)).toBeUndefined();
		}
	});

	it("stops at an untrusted executable instead of skipping to a later trusted match", async () => {
		for (const name of ["cat", "git"]) {
			await executable(path.join(untrustedBin, name));
			await executable(path.join(trustedBin, name));
			expect(resolveTrustedApprovalExecutable(name, `${untrustedBin}:${trustedBin}`, undefined, home)).toBeUndefined();
			expect(resolveTrustedApprovalExecutable(name, `${trustedBin}:${untrustedBin}`, undefined, home)).toBe(`${trustedBin}/${name}`);
		}
	});

	it("skips missing, nonexecutable, directory and broken-link PATH candidates", async () => {
		const denied = path.join(temporary, "nonexecutable");
		const directory = path.join(temporary, "directory");
		const broken = path.join(temporary, "broken");
		fs.mkdirSync(denied);
		fs.mkdirSync(path.join(directory, "cat"), { recursive: true });
		fs.mkdirSync(broken);
		await Bun.write(path.join(denied, "cat"), "not executable\n");
		fs.chmodSync(path.join(denied, "cat"), 0o644);
		fs.symlinkSync(path.join(temporary, "missing"), path.join(broken, "cat"));
		expect(resolveTrustedApprovalExecutable("cat", `${temporary}/missing:${denied}:${directory}:${broken}:/bin`, undefined, home)).toBe("/bin/cat");
	});

	it("resolves relative and empty PATH entries against the supplied cwd before later entries", async () => {
		await executable(path.join(untrustedBin, "cat"));
		await executable(path.join(trustedBin, "cat"));
		expect(resolveTrustedApprovalExecutable("cat", "untrusted:/bin", temporary, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("cat", ":/bin", untrustedBin, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("cat", ".nix-profile/bin:/bin", home, home)).toBe(`${home}/.nix-profile/bin/cat`);
		expect(resolveTrustedApprovalExecutable("cat", "", trustedBin, home)).toBe(`${trustedBin}/./cat`);
		expect(resolveTrustedApprovalExecutable("cat", "missing:/bin", temporary, home)).toBe("/bin/cat");
	});

	it("cannot skip an unresolved relative PATH entry when cwd is unknown", () => {
		for (const searchPath of [".:/bin", ":/bin", "relative:/bin", ""]) {
			expect(resolveTrustedApprovalExecutable("cat", searchPath, undefined, home)).toBeUndefined();
		}
		expect(resolveTrustedApprovalExecutable("cat", ".:/bin", "relative-cwd", home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("cat", "/bin:.", undefined, home)).toBe("/bin/cat");
	});

	it("rejects relative executable spellings even when they resolve into a trusted directory", async () => {
		await executable(path.join(trustedBin, "cat"));
		for (const name of ["./cat", "../bin/cat", ".nix-profile/bin/cat", "bin/cat"]) {
			expect(resolveTrustedApprovalExecutable(name, trustedBin, trustedBin, home)).toBeUndefined();
		}
		for (const name of ["", "cat\0", "/bin/cat\0"]) {
			expect(resolveTrustedApprovalExecutable(name, "/bin", undefined, home)).toBeUndefined();
		}
	});

	it("normalizes dot segments without trusting directory-prefix lookalikes or escapes", async () => {
		await executable(path.join(trustedBin, "cat"));
		const lookalikes = [
			path.join(home, ".nix-profile", "bin-evil", "cat"),
			path.join(home, ".nix-profile", "binary", "cat"),
			path.join(home, ".nix-profile-evil", "bin", "cat"),
			path.join(home, "other", "cat"),
		];
		for (const filename of lookalikes) {
			await executable(filename);
			expect(resolveTrustedApprovalExecutable(filename, "", undefined, home)).toBeUndefined();
		}
		expect(resolveTrustedApprovalExecutable(`${trustedBin}/../bin/cat`, "", undefined, home)).toBe(`${trustedBin}/../bin/cat`);
		expect(resolveTrustedApprovalExecutable(`${trustedBin}/../../other/cat`, "", undefined, home)).toBeUndefined();
	});

	it("accepts package-manager executable symlinks only through trusted entries", async () => {
		const packageExecutable = await executable(path.join(temporary, "cellar", "package", "bin", "cat"));
		const installed = path.join(trustedBin, "cat");
		fs.symlinkSync(packageExecutable, installed);
		expect(resolveTrustedApprovalExecutable(installed, "", undefined, home)).toBe(installed);
		expect(resolveTrustedApprovalExecutable("cat", trustedBin, undefined, home)).toBe(installed);
		expect(resolveTrustedApprovalExecutable(packageExecutable, "", undefined, home)).toBeUndefined();
		const alias = path.join(untrustedBin, "cat");
		fs.symlinkSync("/bin/cat", alias);
		expect(resolveTrustedApprovalExecutable(alias, "", undefined, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("cat", `${untrustedBin}:/bin`, undefined, home)).toBeUndefined();
	});

	it("accepts a Nix profile bin directory whose root is itself a symlink", async () => {
		const profileHome = path.join(temporary, "profile-home");
		const storeBin = path.join(temporary, "store", "package", "bin");
		await executable(path.join(storeBin, "git"));
		fs.mkdirSync(profileHome);
		fs.symlinkSync(path.dirname(storeBin), path.join(profileHome, ".nix-profile"));
		const profileBin = path.join(profileHome, ".nix-profile", "bin");
		expect(resolveTrustedApprovalExecutable("git", profileBin, undefined, profileHome)).toBe(`${profileBin}/git`);
		expect(resolveTrustedApprovalExecutable(`${profileBin}/../bin/git`, "", undefined, profileHome)).toBeUndefined();
	});

	it("rejects nested directory symlink escapes including traversal that normalizes back into a trusted bin", async () => {
		const outside = path.join(temporary, "outside");
		await executable(path.join(outside, "cat"));
		await executable(path.join(outside, "deep", "cat"));
		await executable(path.join(trustedBin, "cat"));
		const escape = path.join(trustedBin, "escape");
		fs.symlinkSync(path.join(outside, "deep"), escape);
		expect(resolveTrustedApprovalExecutable(`${escape}/cat`, "", undefined, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable(`${escape}/../cat`, "", undefined, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("cat", `${escape}/..:/bin`, undefined, home)).toBeUndefined();
	});

	it("returns undefined for missing, nonexecutable, directory and unresolvable trusted entries", async () => {
		expect(resolveTrustedApprovalExecutable(path.join(trustedBin, "missing"), "", undefined, home)).toBeUndefined();
		const plain = path.join(trustedBin, "plain");
		await Bun.write(plain, "not executable\n");
		fs.chmodSync(plain, 0o644);
		expect(resolveTrustedApprovalExecutable(plain, "", undefined, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable(trustedBin, "", undefined, home)).toBeUndefined();
		const broken = path.join(trustedBin, "broken");
		fs.symlinkSync(path.join(temporary, "absent"), broken);
		expect(resolveTrustedApprovalExecutable(broken, "", undefined, home)).toBeUndefined();
		const loop = path.join(trustedBin, "loop");
		fs.symlinkSync(loop, loop);
		expect(resolveTrustedApprovalExecutable(loop, "", undefined, home)).toBeUndefined();
		expect(resolveTrustedApprovalExecutable("missing", trustedBin, undefined, home)).toBeUndefined();
	});
});
