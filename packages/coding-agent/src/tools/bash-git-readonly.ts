type Operand = (value: string) => boolean;
type Options = Readonly<Record<string, Operand | true>>;

const text: Operand = value => value.length > 0;
const format: Operand = () => true;
const number: Operand = value => /^\d+$/.test(value);
const choice = (...values: string[]): Operand => value => values.includes(value);
const flags = (names: string): Options => Object.fromEntries(names.split(" ").map(name => [name, true]));

// Shared entries are copied only into commands that implement those options.
const diff: Options = {
	...flags("--stat --numstat --shortstat --summary --name-only --name-status --raw --patch --no-patch --binary --full-index --abbrev --no-abbrev --relative --no-relative --no-prefix --check --quiet --exit-code --cached --staged --no-ext-diff --no-textconv --ignore-space-at-eol --ignore-cr-at-eol --ignore-blank-lines --ignore-all-space --ignore-space-change --minimal --patience --histogram --word-diff --color-words --no-color --no-renames --find-renames --find-copies -p -s -u -w -b -R"),
	"--abbrev": number,
	"--relative": text,
	"--find-renames": value => /^\d+%?$/.test(value),
	"--find-copies": value => /^\d+%?$/.test(value),
	"--word-diff": choice("color", "plain", "porcelain", "none"),
	"--unified": number,
	"--inter-hunk-context": number,
	"--diff-filter": value => /^[ACDMRTUXBacdmrtuxb*]+$/.test(value),
	"--diff-algorithm": choice("myers", "minimal", "patience", "histogram"),
	"--color": choice("always", "never", "auto"),
	"--src-prefix": format,
	"--dst-prefix": format,
	"--line-prefix": format,
	"-U": number,
	"-S": text,
	"-G": text,
};
const revisions: Options = {
	...flags("--all --branches --tags --remotes --first-parent --no-merges --merges --reverse --topo-order --date-order --author-date-order --boundary --left-right --cherry-pick --cherry-mark --ancestry-path --full-history --simplify-merges --dense --sparse --no-walk --do-walk --parents --children --objects --count"),
	"--max-count": number,
	"--skip": number,
	"--since": text,
	"--until": text,
	"--after": text,
	"--before": text,
	"--author": text,
	"--committer": text,
	"--grep": text,
	"-n": number,
};
const presentation: Options = {
	...flags("--oneline --decorate --no-decorate --no-notes --no-show-signature --no-color --graph --no-patch -p -s"),
	"--decorate": choice("short", "full", "auto", "no"),
	"--format": format,
	"--pretty": format,
	"--date": choice("relative", "local", "iso", "iso-strict", "rfc", "short", "raw", "human", "unix", "default"),
	"--encoding": text,
};
const commands: Readonly<Record<string, Options>> = {
	log: { ...diff, ...revisions, ...presentation, ...flags("--follow --name-only --name-status") },
	show: { ...diff, ...revisions, ...presentation },
	status: {
		...flags("--short --branch --show-stash --long --verbose --ignored --untracked-files --no-renames -s -b -z -v"),
		"--porcelain": choice("v1", "v2", "1", "2"),
		"--untracked-files": choice("no", "normal", "all"),
		"--ignored": choice("traditional", "matching", "no"),
		"--ignore-submodules": choice("none", "untracked", "dirty", "all"),
	},
	diff,
	"rev-parse": {
		...flags("--show-toplevel --git-dir --git-common-dir --is-inside-work-tree --is-inside-git-dir --is-bare-repository --show-prefix --show-cdup --show-object-format --verify --quiet --short --abbrev-ref --symbolic --symbolic-full-name --sq --not --all --branches --tags --remotes --revs-only --no-revs --flags --no-flags --end-of-options"),
	},
	"rev-list": { ...revisions, ...flags("--header --timestamp --abbrev-commit --no-abbrev-commit") },
	"ls-files": {
		...flags("--cached --deleted --modified --others --ignored --stage --unmerged --killed --directory --no-empty-directory --exclude-standard --full-name --error-unmatch --deduplicate --eol -z -t -v -f -c -d -m -o -i -s -u -k"),
		"--exclude": text,
		"--exclude-from": text,
		"--with-tree": text,
		"--format": format,
		"-x": text,
		"-X": text,
	},
	"ls-tree": {
		...flags("--name-only --name-status --full-name --full-tree --long --object-only -d -r -t -l -z"),
		"--format": format,
	},
	"cat-file": { ...flags("-t -s -e -p --batch --batch-check --buffer --unordered --batch-all-objects") },
	"for-each-ref": {
		...flags("--ignore-case --omit-empty"),
		"--format": format,
		"--count": number,
		"--sort": text,
		"--points-at": text,
		"--merged": text,
		"--no-merged": text,
		"--contains": text,
		"--no-contains": text,
	},
	grep: {
		...flags("--cached --no-index --untracked --no-exclude-standard --recurse-submodules --text --ignore-case --word-regexp --invert-match --full-name --line-number --column --files-with-matches --files-without-match --only-matching --count --quiet --all-match --and --or --not --break --heading --no-color --fixed-strings --extended-regexp --basic-regexp --perl-regexp --no-textconv -a -I -i -w -v -n -h -H -l -L -o -c -q -z -F -E -G -P"),
		"--regexp": text,
		"--file": text,
		"--max-depth": number,
		"--after-context": number,
		"--before-context": number,
		"--context": number,
		"--threads": number,
		"-e": text,
		"-f": text,
		"-A": number,
		"-B": number,
		"-C": number,
	},
};

const optionalOperands: Readonly<Record<string, Options>> = {
	log: flags("--abbrev --relative --find-renames --find-copies --word-diff --color --decorate --pretty"),
	show: flags("--abbrev --relative --find-renames --find-copies --word-diff --color --decorate --pretty"),
	diff: flags("--abbrev --relative --find-renames --find-copies --word-diff --color"),
	status: flags("--porcelain --untracked-files --ignored --ignore-submodules"),
};

/** Proves only canonical, literal argv; global normalization and provenance belong to the caller. */
export function isReadOnlyGitApprovalArgv(argv: readonly string[]): boolean {
	if (argv[0] !== "git" || argv.length < 2) return false;
	const command = argv[1]!;
	if (!Object.hasOwn(commands, command)) return false;
	const options = commands[command]!;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--" || (command === "rev-parse" && arg === "--end-of-options")) return true;
		if (!arg.startsWith("-") || arg === "-") continue;
		if ((command === "log" || command === "show" || command === "rev-list") && /^-\d+$/.test(arg)) continue;
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const name = equals < 0 ? arg : arg.slice(0, equals);
			if (!Object.hasOwn(options, name)) return false;
			const operand = options[name]!;
			if (equals >= 0) {
				if (operand === true || !operand(arg.slice(equals + 1))) return false;
			} else if (operand !== true && !(optionalOperands[command] && Object.hasOwn(optionalOperands[command]!, name))) {
				const value = argv[++i];
				if (value === undefined || value.startsWith("-") || !operand(value)) return false;
			}
			continue;
		}
		// Parse clusters one flag at a time; an operand consumes the remainder, never new flags.
		for (let j = 1; j < arg.length; j++) {
			const name = `-${arg[j]}`;
			if (!Object.hasOwn(options, name)) return false;
			const operand = options[name]!;
			if (operand === true) continue;
			const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
			if (value === undefined || value.startsWith("-") || !operand(value)) return false;
			break;
		}
	}
	return true;
}
