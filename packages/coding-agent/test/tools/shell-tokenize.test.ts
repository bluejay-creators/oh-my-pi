import { describe, expect, it } from "bun:test";
import {
	extractApprovalShellSegments,
	extractLeadingCdTarget,
	extractSimpleApprovalShellSegments,
	lexShellCommand,
	readShellWord,
} from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";

describe("lexShellCommand", () => {
	it("splits words from separators, keeping verbatim spelling beside the quote-removed value", () => {
		const command = `git -C "my repo" log && echo 'a b' 2>&1`;
		const tokens = lexShellCommand(command);
		// Rewriters reassemble commands from `raw`, so the pieces must reproduce the input exactly.
		expect(tokens.map(token => token.raw).join("")).toBe(command);
		expect(tokens.filter(token => token.kind === "word").map(token => token.value)).toEqual([
			"git",
			"-C",
			"my repo",
			"log",
			"echo",
			"a b",
			"2>",
			"1",
		]);
	});
});

describe("extractSimpleApprovalShellSegments", () => {
	it("returns only the initial literal cd chain and first target, preserving their source", () => {
		const command = "'cd' '/repo one' && cd /repo-two; git push origin feature; git push origin main";
		expect(extractSimpleApprovalShellSegments(command)).toEqual([
			{ text: "'cd' '/repo one'", argv: ["cd", "/repo one"] },
			{ text: "cd /repo-two", argv: ["cd", "/repo-two"] },
			{ text: "git push origin feature", argv: ["git", "push", "origin", "feature"] },
		]);
		expect(extractSimpleApprovalShellSegments("git status; cd /other; git push origin feature")).toEqual([
			{ text: "git status", argv: ["git", "status"] },
		]);
		expect(extractSimpleApprovalShellSegments('cd /repo; git push origin "feature/topic"')).toEqual([
			{ text: "cd /repo", argv: ["cd", "/repo"] },
			{ text: 'git push origin "feature/topic"', argv: ["git", "push", "origin", "feature/topic"] },
		]);
	});

	it("keeps literal environment overrides visible for Bash policy rather than approving their names", () => {
		for (const prefix of [
			"GIT_DIR=/other",
			"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main",
		]) {
			const result = extractSimpleApprovalShellSegments(`${prefix} git push origin feature`);
			expect(result?.[0]?.argv).toEqual([...prefix.split(" "), "git", "push", "origin", "feature"]);
		}
	});

	it("rejects loops including quoted cd and loop-carried literal variable bindings", () => {
		for (const command of [
			"for x in one; do git push origin feature; done",
			"for x in one; do 'cd' /other; git push origin feature; done",
			'b=feature; for x in one two; do git push origin "$b"; b=main; done',
			'for b in feature; do git push origin "$b"; done',
			"while true; do git push origin feature; done",
			"until false; do git push origin feature; done",
			"repeat 2 git push origin feature",
		]) {
			expect(extractSimpleApprovalShellSegments(command)).toBeNull();
		}
	});

	it("never infers a cwd through a conditional cd or a prior non-cd command", () => {
		expect(extractSimpleApprovalShellSegments("false && cd /other; git push origin feature")).toEqual([
			{ text: "false", argv: ["false"] },
		]);
		expect(extractSimpleApprovalShellSegments("cd /one || cd /two; git push origin feature")).toBeNull();
		expect(extractSimpleApprovalShellSegments("if false; then cd /other; fi; git push origin feature")).toBeNull();
	});

	it("rejects standalone assignments, exports, expansions and nonliteral redirect targets", () => {
		for (const command of [
			"b=feature; git push origin feature",
			"export b=feature; git push origin feature",
			'b=feature; git push origin "$b"',
			'git push origin "$b"',
			"cd /repo extra && git push origin feature",
			"cd - && git push origin feature",
			"GIT_DIR=/other cd /repo && git push origin feature",
			"git config user.name >$OUTPUT",
			"git config user.name >/tmp/output",
			"git config user.name 2>$(target)",
			"git config user.name >>/dev/null",
			"git config user.name </dev/null",
			"git config user.name 3>/dev/null",
			"git config user.name 2>&2",
			"git config user.name >&1",
			"git config user.name &>/dev/null",
			"git config user.name >/dev/null$OUTPUT",
			"git config user.name >/dev/null/other",
		]) {
			expect(extractSimpleApprovalShellSegments(command)).toBeNull();
		}
		for (const suffix of ["export b=feature; git push origin feature", "b=feature; git push origin feature", "echo ok | cat", 'echo "$UNKNOWN"']) {
			expect(extractSimpleApprovalShellSegments(`git status; ${suffix}`)).toEqual([
				{ text: "git status", argv: ["git", "status"] },
			]);
		}
	});

	it("allows only the three safe redirects without including them in argv", () => {
		for (const redirect of ["2>&1", ">/dev/null", "2>/dev/null", '> "/dev/null"', "2> /dev/null"]) {
			const command = `git config user.name ${redirect}`;
			expect(extractSimpleApprovalShellSegments(command)).toEqual([
				{ text: command, argv: ["git", "config", "user.name"] },
			]);
		}
		expect(extractSimpleApprovalShellSegments("cd /repo && git push origin feature >/dev/null 2>&1")).toEqual([
			{ text: "cd /repo", argv: ["cd", "/repo"] },
			{ text: "git push origin feature >/dev/null 2>&1", argv: ["git", "push", "origin", "feature"] },
		]);
	});

	it("rejects unsupported target structure and OR-lists anywhere", () => {
		for (const command of [
			"git status || true",
			"git status; echo ok || true",
			"git status | cat",
			"cd /repo | git status",
			"(git status)",
			"{ git status; }",
			"f() { git status; }; f",
			"function f { git status; }; f",
			"case x in x) git status;; esac",
			"git status &",
			"git status\n",
			"git status;",
			"git status &&",
			"git status 'unterminated",
			'git status "unterminated',
		]) {
			expect(extractSimpleApprovalShellSegments(command)).toBeNull();
		}
	});

	it("keeps quoted and escaped operators as literal argument data", () => {
		expect(extractSimpleApprovalShellSegments(String.raw`git log 'a || b; c && d | (e)' "x > y" \$branch`)).toEqual([
			{
				text: String.raw`git log 'a || b; c && d | (e)' "x > y" \$branch`,
				argv: ["git", "log", "a || b; c && d | (e)", "x > y", "$branch"],
			},
		]);
	});
});

describe("extractLeadingCdTarget", () => {
	it("extracts a bare cd target and returns the remainder", () => {
		expect(extractLeadingCdTarget("cd /some/dir && echo ok")).toEqual({
			path: "/some/dir",
			rest: "echo ok",
			separator: "&&",
		});
		expect(extractLeadingCdTarget("cd /some/dir; echo ok")).toEqual({
			path: "/some/dir",
			rest: "echo ok",
			separator: ";",
		});
	});

	it("resolves quoted and escaped path tokens", () => {
		expect(extractLeadingCdTarget('cd "/my dir" && ls')).toEqual({ path: "/my dir", rest: "ls", separator: "&&" });
		expect(extractLeadingCdTarget("cd '/a b' && ls")).toEqual({ path: "/a b", rest: "ls", separator: "&&" });
		expect(extractLeadingCdTarget("cd /a\\ b && ls")).toEqual({ path: "/a b", rest: "ls", separator: "&&" });
	});

	it("leaves escaped newlines to the shell", () => {
		expect(extractLeadingCdTarget("cd /tmp\\\n&& echo ok")).toBeNull();
		expect(extractLeadingCdTarget('cd "/tmp\\\n" && echo ok')).toBeNull();
	});

	it("preserves ~ so resolveToCwd can expand it", () => {
		expect(extractLeadingCdTarget("cd ~/proj && make")).toEqual({ path: "~/proj", rest: "make", separator: "&&" });
	});

	it("accepts a && or ; with no leading whitespace", () => {
		expect(extractLeadingCdTarget("cd /tmp&& echo ok")).toEqual({ path: "/tmp", rest: "echo ok", separator: "&&" });
		expect(extractLeadingCdTarget("cd /tmp;echo ok")).toEqual({ path: "/tmp", rest: "echo ok", separator: ";" });
	});

	// Regression for #7883: a redirect between the path and `&&` must not be
	// absorbed into the cwd token — the command belongs to the shell intact.
	it("bails when a redirect follows the path", () => {
		expect(extractLeadingCdTarget("cd /tmp 2>/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp >/dev/null && echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp >/dev/null 2>&1 && echo ok")).toBeNull();
	});

	it("bails when an extra argument follows the path", () => {
		expect(extractLeadingCdTarget("cd /tmp extra && echo ok")).toBeNull();
	});

	it("bails on paths that need shell expansion", () => {
		expect(extractLeadingCdTarget("cd $HOME && ls")).toBeNull();
		expect(extractLeadingCdTarget('cd "$(git rev-parse --show-toplevel)" && make')).toBeNull();
		expect(extractLeadingCdTarget("cd `pwd` && ls")).toBeNull();
	});

	it("leaves glob, brace, and special cd targets to the shell", () => {
		expect(extractLeadingCdTarget("cd /tmp/demo/*/ && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp/demo/? && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp/demo/[ab] && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp/demo/{a,b} && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd - && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd +1 && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd -1 && pwd")).toBeNull();
		expect(extractLeadingCdTarget("cd ~other/project && pwd")).toBeNull();
	});

	it("keeps quoted and escaped expansion characters literal", () => {
		expect(extractLeadingCdTarget("cd '/tmp/*?[abc]{x,y}' && ls")).toEqual({
			path: "/tmp/*?[abc]{x,y}",
			rest: "ls",
			separator: "&&",
		});
		expect(extractLeadingCdTarget('cd "/tmp/*?[abc]{x,y}" && ls')).toEqual({
			path: "/tmp/*?[abc]{x,y}",
			rest: "ls",
			separator: "&&",
		});
		expect(extractLeadingCdTarget(String.raw`cd /tmp/\*\?\[abc\]\{x,y\} && ls`)).toEqual({
			path: "/tmp/*?[abc]{x,y}",
			rest: "ls",
			separator: "&&",
		});
		expect(extractLeadingCdTarget("cd '$HOME' && ls")).toEqual({ path: "$HOME", rest: "ls", separator: "&&" });
		expect(extractLeadingCdTarget(String.raw`cd \$HOME && ls`)).toEqual({
			path: "$HOME",
			rest: "ls",
			separator: "&&",
		});
		expect(extractLeadingCdTarget('cd "\\$HOME" && ls')).toEqual({
			path: "$HOME",
			rest: "ls",
			separator: "&&",
		});
	});

	it("requires a top-level && or ; separator", () => {
		expect(extractLeadingCdTarget("cd /foo || echo fail")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp &echo")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp;; echo ok")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp;& echo ok")).toBeNull();
	});

	it("bails when there is no cd target", () => {
		expect(extractLeadingCdTarget("cd  && echo")).toBeNull();
		expect(extractLeadingCdTarget("ls -la")).toBeNull();
		expect(extractLeadingCdTarget("cdx /tmp && ls")).toBeNull();
	});
});

describe("readShellWord", () => {
	it("reads a bare whitespace-delimited token", () => {
		expect(readShellWord("bun test extra")).toEqual({ value: "bun", rest: "test extra" });
	});

	it("reads a fully quoted value and preserves internal whitespace", () => {
		expect(readShellWord('"bun test" fix it')).toEqual({ value: "bun test", rest: "fix it" });
		expect(readShellWord("'bun test' fix it")).toEqual({ value: "bun test", rest: "fix it" });
	});

	// Regression: an `indexOf`-based scanner treats an escaped instance of the
	// outer delimiter as the closing quote, silently truncating the value.
	it("keeps an escaped instance of the outer delimiter inside the value", () => {
		expect(readShellWord(`"node -e \\"process.exit(0)\\"" fix it`)).toEqual({
			value: 'node -e "process.exit(0)"',
			rest: "fix it",
		});
		expect(readShellWord(`"test \\"$READY\\" = yes" continue`)).toEqual({
			value: 'test "$READY" = yes',
			rest: "continue",
		});
	});

	// Regression: a scanner that only checks space/tab does not end a quoted
	// value at a newline, so a multiline invocation folds the next line's
	// prompt text into the condition command.
	it("stops on a newline or carriage return, not just space and tab", () => {
		expect(readShellWord("'bun test'\nfix the tests")).toEqual({ value: "bun test", rest: "fix the tests" });
		expect(readShellWord("bun\ntest")).toEqual({ value: "bun", rest: "test" });
		expect(readShellWord("bun\r\ntest")).toEqual({ value: "bun", rest: "test" });
	});

	it("does not un-escape inside single quotes", () => {
		expect(readShellWord(String.raw`'a\"b' rest`)).toEqual({ value: 'a\\"b', rest: "rest" });
	});

	it("reports an unterminated quote", () => {
		expect(readShellWord('"bun test')).toBe("unterminated");
		expect(readShellWord("'bun test")).toBe("unterminated");
	});

	it("returns undefined for empty or all-whitespace input", () => {
		expect(readShellWord("")).toBeUndefined();
		expect(readShellWord("   ")).toBeUndefined();
	});
});

describe("segment-aware shell approval extraction", () => {
	it("keeps heredoc source attached to its interpreter and never parses its body as commands", () => {
		const body = "python3 <<'PY'\nslack_write('hello; world')\nPY";
		const segments = extractApprovalShellSegments(`echo before; ${body}\necho after`);
		expect(segments?.map(segment => segment.text)).toEqual(["echo before", body, "echo after"]);
		expect(segments?.[1]?.literal).toBeNull();
	});

	it("attaches multiple and tab-stripped heredocs to the correct pipeline commands", () => {
		const segments = extractApprovalShellSegments("cat <<A <<-B | tail -3\none; two\nA\n\tthree | four\n\tB\necho done");
		expect(segments?.map(segment => segment.text)).toEqual([
			"cat <<A <<-B\none; two\nA\n\tthree | four\n\tB",
			"tail -3",
			"echo done",
		]);
		expect(segments?.[0]?.literal).toBeNull();
	});

	it("does not split quoted operators or mistake quoted descriptor text for a redirect", () => {
		const segments = extractApprovalShellSegments('echo "a; b | c 2>&1" | tail -3');
		expect(segments?.map(segment => segment.text)).toEqual(['echo "a; b | c 2>&1"', "tail -3"]);
		expect(segments?.[0]?.literal?.argv).toEqual(["echo", "a; b | c 2>&1"]);
	});

	it("declines unsupported process substitution, incomplete heredocs and malformed control flow", () => {
		for (const command of [
			"cat <(echo data); echo done",
			"python3 <<PY\nprint('unterminated')",
			"for b in one two; do echo done",
			"echo before &&",
			"(echo before",
		]) expect(extractApprovalShellSegments(command)).toBeNull();
	});

	it("returns a single argv command without mistaking quoted shell text for execution", () => {
		const segments = extractApprovalShellSegments(`printf '%s' 'git push origin main; env; $(rm -rf /)'`);
		expect(segments?.map(segment => segment.argv)).toEqual([
			["printf", "%s", "git push origin main; env; $(rm -rf /)"],
		]);
		expect(segments?.[0]?.literal?.argv[0]).toBe("printf");
	});

	it("exposes every literal loop branch including a protected destination", () => {
		const segments = extractApprovalShellSegments('for b in feature/one main; do git push origin "$b"; done');
		expect(segments?.map(segment => segment.argv)).toEqual([
			["git", "push", "origin", "feature/one"],
			["git", "push", "origin", "main"],
		]);
	});

	it("keeps lease pushes to each literal feature branch independently approvable", () => {
		const segments = extractApprovalShellSegments('for b in feature/one feature/two; do git push --force-with-lease origin "$b"; done');
		expect(segments?.map(segment => segment.literal?.argv)).toEqual([
			["git", "push", "--force-with-lease", "origin", "feature/one"],
			["git", "push", "--force-with-lease", "origin", "feature/two"],
		]);
	});

	it("expands a literal directory assignment without resolving ambient directory variables", () => {
		const segments = extractApprovalShellSegments('d=/tmp/omp-scratch; rm -rf "$d"; git -C "$checkout" push origin feature/one');
		expect(segments?.[1]?.argv).toEqual(["rm", "-rf", "/tmp/omp-scratch"]);
		expect(segments?.[2]?.argv).toEqual(["git", "-C", "$checkout", "push", "origin", "feature/one"]);
		expect(segments?.[2]?.unknownArgv).toEqual([2]);
	});

	it("inspects substitution commands next to gh arguments without inventing commands from quoted payloads", () => {
		const segments = extractApprovalShellSegments(`gh pr create --body "$(printf '%s' 'git push origin main')" --repo owner/repo`);
		expect(segments?.map(segment => segment.argv?.[0])).toEqual(["printf", "gh"]);
		expect(segments?.[0]?.argv).toEqual(["printf", "%s", "git push origin main"]);
		expect(segments?.[1]?.argv?.slice(-2)).toEqual(["--repo", "owner/repo"]);
		expect(segments?.[1]?.unknownArgv).toEqual([4]);
	});

	it("exposes dangerous executable substitutions and backticks in their own command segments", () => {
		for (const substitution of ["$(git push origin main)", "`git push origin main`"]) {
			const segments = extractApprovalShellSegments(`gh pr create --body "${substitution}" --repo owner/repo`);
			expect(segments?.[0]?.argv).toEqual(["git", "push", "origin", "main"]);
			expect(segments?.[1]?.argv?.[0]).toBe("gh");
			expect(segments?.every(segment => segment.literal === null && segment.allowUnsafe)).toBe(true);
		}
	});

	it("keeps an unknown argument local instead of merging adjacent commands", () => {
		const segments = extractApprovalShellSegments('echo "$unknown"; git push origin main; env');
		expect(segments?.map(segment => segment.argv)).toEqual([
			["echo", "$unknown"],
			["git", "push", "origin", "main"],
			["env"],
		]);
		expect(segments?.[0]?.unknownArgv).toEqual([1]);
		expect(segments?.[1]?.unknownArgv).toBeUndefined();
	});

	it("exposes deny commands after shell mutations but does not infer allows from their names", () => {
		const segments = extractApprovalShellSegments("alias git=env; git status; env");
		expect(segments?.map(segment => segment.argv?.[0])).toEqual(["alias", "git", "env"]);
		expect(segments?.slice(1).every(segment => segment.literal === null && segment.allowUnsafe)).toBe(true);
	});

	it("retains file redirect targets for deny inspection and refuses a command-local allow", () => {
		const segments = extractApprovalShellSegments("echo data >/protected/file; env");
		expect(segments?.[0]?.text).toContain("/protected/file");
		expect(segments?.[0]?.argv).toEqual(["echo", "data"]);
		expect(segments?.[0]?.literal).toBeNull();
		expect(segments?.[0]?.allowUnsafe).toBe(true);
		expect(segments?.[1]?.argv).toEqual(["env"]);
	});

	it("does not propagate conditional or subshell assignments into later destructive arguments", () => {
		for (const prefix of ["false && d=/tmp/scratch", "(d=/tmp/scratch)", "d=/tmp/scratch | cat"]) {
			const segments = extractApprovalShellSegments(`${prefix}; rm -rf "$d"`);
			expect(segments?.at(-1)?.argv).toEqual(["rm", "-rf", "$d"]);
			expect(segments?.at(-1)?.unknownArgv).toEqual([2]);
		}
	});

	it("keeps unknown loop values local while exposing commands that generate those values", () => {
		const segments = extractApprovalShellSegments('for b in $(git push origin main); do git push origin "$b"; done');
		expect(segments?.[0]?.argv).toEqual(["git", "push", "origin", "main"]);
		expect(segments?.[1]?.argv).toEqual(["git", "push", "origin", "$b"]);
		expect(segments?.[1]?.unknownArgv).toEqual([3]);
	});

	it("does not allow executable lookup changes to disguise a following command", () => {
		const segments = extractApprovalShellSegments("PATH=/unsafe; git status; env");
		expect(segments?.map(segment => segment.argv?.[0])).toEqual(["PATH=/unsafe", "git", "env"]);
		expect(segments?.slice(1).every(segment => segment.literal === null && segment.allowUnsafe)).toBe(true);
	});

	it("does not approve unknown unquoted directory values that can inject push flags", () => {
		const segments = extractApprovalShellSegments("git -C $checkout push origin feature/one");
		expect(segments?.[0]?.argv).toEqual(["git", "-C", "$checkout", "push", "origin", "feature/one"]);
		expect(segments?.[0]?.unknownArgv).toEqual([2]);
		expect(segments?.[0]?.allowUnsafe).toBe(true);
		expect(segments?.[0]?.literal).toBeNull();
	});

	it("does not taint executable lookup for literal errexit nounset and pipefail options", () => {
		for (const options of ["-u", "-e", "-eu", "-o pipefail", "-euo pipefail", "-e -u -o pipefail"]) {
			const segments = extractApprovalShellSegments(`set ${options}; git push origin feature/one`);
			expect(segments?.[0]?.literal?.argv[0]).toBe("set");
			expect(segments?.[1]?.literal?.argv).toEqual(["git", "push", "origin", "feature/one"]);
			expect(segments?.[1]?.shellStateUnknown).toBeUndefined();
		}
	});

	it("propagates loop-local literal and loop-derived directory assignments per iteration", () => {
		const segments = extractApprovalShellSegments(
			'set -u; for repo in one two; do d="/tmp/$repo"; rm -rf "$d"; done',
		);
		expect(segments?.filter(segment => segment.argv?.[0] === "rm").map(segment => segment.argv)).toEqual([
			["rm", "-rf", "/tmp/one"],
			["rm", "-rf", "/tmp/two"],
		]);
		const fixed = extractApprovalShellSegments('for repo in one two; do d=/tmp/repo; rm -rf "$d"; done');
		expect(fixed?.filter(segment => segment.argv?.[0] === "rm").map(segment => segment.argv?.[2])).toEqual([
			"/tmp/repo", "/tmp/repo",
		]);
	});

	it("marks shell retargeting separately from an unknown quoted directory argument", () => {
		const unsafe = extractApprovalShellSegments('PATH=/unsafe; git -C "$d" push origin feature/one');
		expect(unsafe?.[1]?.shellStateUnknown).toBe(true);
		const unknown = extractApprovalShellSegments('git -C "$d" push origin feature/one');
		expect(unknown?.[0]?.unknownArgv).toEqual([2]);
		expect(unknown?.[0]?.shellStateUnknown).toBeUndefined();
	});

	it("exposes commands in shell interpreter stdin heredocs but not ordinary heredoc data", () => {
		for (const interpreter of ["bash", "/bin/sh", "sh -s", "zsh -s -- argument"]) {
			const segments = extractApprovalShellSegments(`${interpreter} <<'EOF'\ngit config --global user.name value\nEOF`);
			expect(segments?.map(segment => segment.argv?.[0])).toEqual(["git", interpreter.split(" ")[0]]);
			expect(segments?.[0]?.argv).toEqual(["git", "config", "--global", "user.name", "value"]);
			expect(segments?.[0]?.literal).toBeNull();
			expect(segments?.[0]?.allowUnsafe).toBe(true);
		}
		const data = extractApprovalShellSegments("cat <<'EOF'\ngit config --global user.name value\nEOF");
		expect(data?.map(segment => segment.argv)).toEqual([["cat"]]);
	});

	it("does not interpret heredoc data passed to a script file or non-stdin descriptor", () => {
		for (const header of ["bash script.sh <<'EOF'", "sh -c 'cat' <<'EOF'", "bash 3<<'EOF'"]) {
			const segments = extractApprovalShellSegments(`${header}\ngit config --global user.name value\nEOF`);
			expect(segments?.map(segment => segment.argv?.[0])).toEqual([header.split(" ")[0]]);
		}
	});

	it("inspects only the final shell stdin heredoc and keeps quoted payloads as data", () => {
		const segments = extractApprovalShellSegments(
			"bash <<A <<-B\ngit push origin main\nA\n\tprintf '%s' 'git config --global user.name value'\n\tB",
		);
		expect(segments?.map(segment => segment.argv?.[0])).toEqual(["printf", "bash"]);
		expect(segments?.[0]?.argv).toEqual(["printf", "%s", "git config --global user.name value"]);
	});

	it("keeps arithmetic and complex parameter expansions local to one unknown argv argument", () => {
		for (const expansion of ["$((1 + (2 * 3)))", "${branch:-feature/one}", "${branch:-${fallback:-feature/two}}"]) {
			const segments = extractApprovalShellSegments(`echo "${expansion}"; gh pr view --repo owner/repo`);
			expect(segments?.map(segment => segment.argv)).toEqual([
				["echo", expansion],
				["gh", "pr", "view", "--repo", "owner/repo"],
			]);
			expect(segments?.[0]?.unknownArgv).toEqual([1]);
			expect(segments?.[1]?.unknownArgv).toBeUndefined();
		}
	});

	it("exposes executable substitutions nested in arithmetic and parameter expansions", () => {
		for (const expansion of [
			"$((1 + $(git config --global user.name value)))",
			"${branch:-$(git config --global user.name value)}",
			"${branch:-${fallback:-`git config --global user.name value`}}",
		]) {
			const segments = extractApprovalShellSegments(`echo "${expansion}"; gh pr view --repo owner/repo`);
			expect(segments?.map(segment => segment.argv?.[0])).toEqual(["git", "echo", "gh"]);
			expect(segments?.[0]?.argv).toEqual(["git", "config", "--global", "user.name", "value"]);
			expect(segments?.[1]?.argv).toEqual(["echo", expansion]);
			expect(segments?.[1]?.unknownArgv).toEqual([1]);
			expect(segments?.[0]?.allowUnsafe).toBe(true);
		}
	});

	it("still declines incomplete arithmetic and parameter expansion syntax", () => {
		for (const command of ["echo $((1 + 2)", "echo ${branch:-value", "echo ${branch:-$(id}"]) {
			expect(extractApprovalShellSegments(command)).toBeNull();
		}
	});

	it("does not resurrect a feature-valued loop variable after iterating over a protected branch", () => {
		const segments = extractApprovalShellSegments('b=feature/topic; for b in main; do echo ok; done; git push origin "$b"');
		expect(segments?.at(-1)?.argv).toEqual(["git", "push", "origin", "$b"]);
		expect(segments?.at(-1)?.unknownArgv).toEqual([3]);
		const empty = extractApprovalShellSegments('b=feature/topic; for b in; do echo ok; done; git push origin "$b"');
		expect(empty?.at(-1)?.argv).toEqual(["git", "push", "origin", "feature/topic"]);
	});

	it("does not restore an outer feature binding after a same-named nested loop or assignment", () => {
		for (const body of [
			"for b in main; do echo ok; done",
			"for inner in once; do b=main; done",
		]) {
			const segments = extractApprovalShellSegments(`for b in feature/topic; do ${body}; git push origin "$b"; done`);
			const push = segments?.find(segment => segment.argv?.[0] === "git");
			expect(push?.argv).toEqual(["git", "push", "origin", "$b"]);
			expect(push?.unknownArgv).toEqual([3]);
		}
	});

	it("keys reassigned loop-variable bindings by their original iteration rather than their mutated value", () => {
		const segments = extractApprovalShellSegments('for b in original; do b=feature/topic; b=main; git push origin "$b"; done');
		expect(segments?.find(segment => segment.argv?.[0] === "git")?.argv).toEqual(["git", "push", "origin", "main"]);
	});

	it("declines conditional and function bodies whose execution is not modeled", () => {
		for (const command of [
			"if false; then cd /feature; fi; git push",
			"if true; then echo ok; else cd /feature; fi; git push",
			"if cd /feature; then echo ok; fi; git push",
			"case value in other) cd /feature;; esac; git push",
			"f() { cd /feature; }; git push",
			"function f { cd /feature; }; f; git push",
			"f() (cd /feature); git push",
		]) expect(extractApprovalShellSegments(command)).toBeNull();
	});

	it("lets cwd consumers isolate subshell pipeline substitution and heredoc changes", () => {
		const pushDirectories = (command: string) => {
			const directories = new Map<number, string | undefined>([[0, "/protected"]]);
			const pushes: (string | undefined)[] = [];
			for (const segment of extractApprovalShellSegments(command) ?? []) {
				const scope = segment.cwdScope ?? 0;
				if (!directories.has(scope)) directories.set(scope, directories.get(segment.cwdParentScope ?? 0));
				if (segment.cwdUnknown) directories.set(scope, undefined);
				if (segment.argv?.[0] === "cd") directories.set(scope, segment.argv[1]);
				if (segment.argv?.[0] === "git" && segment.argv[1] === "push") pushes.push(directories.get(scope));
				if (segment.cwdUnknownAfter) directories.set(segment.cwdParentScope ?? scope, undefined);
			}
			return pushes;
		};
		expect(pushDirectories("(cd /feature); git push")).toEqual(["/protected"]);
		expect(pushDirectories("cd /feature | cat; git push")).toEqual(["/protected"]);
		expect(pushDirectories("(cd /feature && git push); git push")).toEqual(["/feature", "/protected"]);
		expect(pushDirectories('echo "$(cd /feature && git push)"; git push')).toEqual(["/feature", "/protected"]);
		expect(pushDirectories("bash <<'EOF'\ncd /feature && git push\nEOF\ngit push")).toEqual(["/feature", "/protected"]);
		expect(pushDirectories("echo ok | cd /feature; git push")).toEqual([undefined]);
		expect(pushDirectories('for d in /feature /protected; do cd "$d"; git push; done; git push')).toEqual([
			undefined, undefined, undefined,
		]);
		for (const prefix of [
			"false && cd /feature",
			"true || cd /feature",
			"cd /feature || true",
			"cd /feature && echo ok",
			"cd /feature",
			"false && cd /feature && echo ok",
			"while false; do cd /feature; done",
			"until true; do cd /feature; done",
			"for d in /feature; do X=value cd /feature; done",
		]) expect(pushDirectories(`${prefix}; git push`)).toEqual([undefined]);
		expect(pushDirectories("(cd /feature; git push); git push")).toEqual([undefined, "/protected"]);
		expect(pushDirectories('echo "$(cd /feature; git push)"; git push')).toEqual([undefined, "/protected"]);
		expect(pushDirectories("while cd /feature; do git push; done; git push")).toEqual([undefined, undefined]);
		expect(pushDirectories("cd /feature && git push")).toEqual(["/feature"]);
		expect(pushDirectories("cd /feature && git push; git push")).toEqual(["/feature", undefined]);
		expect(pushDirectories("false && cd /feature && git push")).toEqual([undefined]);
		expect(pushDirectories("true || cd /feature && git push")).toEqual([undefined]);
		expect(pushDirectories('false && cd /feature; echo "$(git push)"')).toEqual([undefined]);
		expect(pushDirectories("false && cd /feature; (git push)")).toEqual([undefined]);
		expect(pushDirectories("cd /feature; cd /other && git push")).toEqual(["/other"]);
	});
});
