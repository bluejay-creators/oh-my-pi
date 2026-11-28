/**
 * Conservative shell command tokenizer shared by the bash approval-pattern
 * matcher, the gh-cache invalidator, and the session anonymizer.
 *
 * Splits a bash command into independent command segments, each a list of word
 * tokens. Handles single/double-quoted strings, backslash escapes, and the
 * standard operators (`;`, `&&`, `||`, `|`, `&`, `(`, `)`, newlines) as segment
 * boundaries so callers treat the pieces as independent command sequences.
 *
 * It is deliberately not a full POSIX parser — heredocs, command substitution,
 * and arithmetic expansion are out of scope; callers fall through when they
 * cannot find the structure they need.
 */
export function tokenizeShellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of lexShellCommand(command)) {
		if (token.kind === "word") {
			// Empty quoted words (`''`) carry no argument text.
			if (token.value.length > 0) current.push(token.value);
		} else if (/[\n;&|()]/.test(token.raw) && current.length > 0) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/** One lexical piece of a shell command: a word, or the whitespace/operator run between words. */
export type ShellToken = { kind: "word"; raw: string; value: string } | { kind: "separator"; raw: string };

/**
 * Lex a command into words and separators with their source text, so callers can rewrite words
 * and reassemble the command. Word boundaries match {@link tokenizeShellSegments}: `value` is the
 * quote/escape-removed word, `raw` its verbatim spelling; separators are runs of spaces, tabs, and
 * the operator characters `\n ; & | ( )`.
 */
export function lexShellCommand(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let value = "";
	let wordStart = -1;
	let separatorStart = -1;
	let inSingle = false;
	let inDouble = false;
	const startWord = (index: number) => {
		if (wordStart >= 0) return;
		if (separatorStart >= 0) {
			tokens.push({ kind: "separator", raw: command.slice(separatorStart, index) });
			separatorStart = -1;
		}
		wordStart = index;
	};
	const endWord = (index: number) => {
		if (wordStart < 0) return;
		tokens.push({ kind: "word", raw: command.slice(wordStart, index), value });
		value = "";
		wordStart = -1;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') inDouble = false;
			else value += ch;
			continue;
		}
		if (
			ch === " " ||
			ch === "\t" ||
			ch === "\n" ||
			ch === ";" ||
			ch === "&" ||
			ch === "|" ||
			ch === "(" ||
			ch === ")"
		) {
			endWord(i);
			if (separatorStart < 0) separatorStart = i;
			continue;
		}
		startWord(i);
		if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			value += command[i + 1];
			i++;
		} else {
			value += ch;
		}
	}
	endWord(command.length);
	if (separatorStart >= 0) tokens.push({ kind: "separator", raw: command.slice(separatorStart) });
	return tokens;
}

/** A command in a conservative, flat `&&` chain. */
export interface LiteralShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** Literal argv after shell quote removal. */
	argv: string[];
	/** Indices whose shell expansion cannot be resolved without executing code. */
	unknownArgv?: number[];
}

/** One segment of a top-level `&&` chain, paired with its literal parse when eligible. */
export interface AndChainSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** Parsed literal command when the segment is eligible for compound allow, else `null`. */
	literal: LiteralShellCommandSegment | null;
	/** True when executing this clause can mutate current-shell state for later clauses. */
	mutatesShellState: boolean;
}
const SHELL_STATEFUL_COMMANDS = new Set([
	"!",
	":",
	".",
	// Bash test -v evaluates array subscripts, including command substitutions.
	"test",
	"[",
	"[[",
	// Zsh also runs behind the Bash tool; its builtins can mutate shell state.
	"-",
	"autoload",
	"bindkey",
	"bye",
	"chdir",
	"disable",
	"emulate",
	"functions",
	"limit",
	"print",
	"rehash",
	// Zsh's short `repeat N cmd && …` runs the whole sublist as the loop body.
	"repeat",
	"sched",
	"setopt",
	"unfunction",
	"unhash",
	"unlimit",
	"unsetopt",
	"vared",
	"zle",
	"zmodload",
	"zparseopts",
	"zstyle",
	"alias",
	"bg",
	"break",
	"builtin",
	"case",
	"cd",
	"command",
	"coproc",
	"continue",
	"declare",
	"dirs",
	"disown",
	"do",
	"done",
	"elif",
	"else",
	"enable",
	"esac",
	"eval",
	"exec",
	"exit",
	"export",
	"fc",
	"fg",
	"fi",
	"for",
	"function",
	"getopts",
	"hash",
	"history",
	"if",
	"in",
	"jobs",
	"let",
	"logout",
	"mapfile",
	"local",
	"popd",
	// Bash's printf -v can write BASH_CMDS and retarget a later command.
	"printf",
	"pushd",
	"readonly",
	"read",
	"readarray",
	"return",
	"select",
	"set",
	"shift",
	"shopt",
	"source",
	"suspend",
	"then",
	"time",
	"times",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"until",
	"wait",
	"while",
]);

const SHELL_INTERPRETER_COMMANDS: Record<string, true> = {
	ash: true,
	bash: true,
	busybox: true,
	csh: true,
	dash: true,
	env: true,
	nocorrect: true,
	noglob: true,
	fish: true,
	ksh: true,
	sh: true,
	sudo: true,
	tcsh: true,
	zsh: true,
};

const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;
const SHELL_ASSIGNMENT_NAME = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u;
const SHELL_REINTERPRET_OPTION = /^(?:-[^-\s]*[ce]|--(?:command|eval)(?:=.*)?)$/u;
export const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};

function hasBashApprovalShellControlChar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, text[i]!)) return true;
	}
	return false;
}

/** Whether `word` begins with a POSIX shell variable assignment prefix (`NAME=` or `NAME+=`). */
export function isShellEnvironmentAssignment(word: string): boolean {
	return SHELL_ASSIGNMENT.test(word);
}

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/**
 * Removes leading `NAME=value` (or `NAME+=value`) assignments without interpreting shell syntax.
 * When `allowName` is supplied, every leading assignment variable name must satisfy it or `null` is returned.
 */
export function withoutLeadingEnvironmentAssignments(
	command: string,
	allowName?: (name: string) => boolean,
): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const match = SHELL_ASSIGNMENT_NAME.exec(command.slice(index));
		if (!match) break;
		if (allowName && !allowName(match[1])) return null;
		const wordEnd = skipShellWord(command, index + match[0].length);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	if (commandWithoutAssignments.length === 0 || SHELL_ASSIGNMENT.test(commandWithoutAssignments)) return null;
	return commandWithoutAssignments;
}

/**
 * Parses the deliberately small command language eligible for compound-command
 * approval: two or more literal argv commands joined only by `&&`.
 *
 * Anything that needs shell interpretation beyond quote removal is rejected.
 * In particular, this excludes expansion, globbing, redirection, comments,
 * standalone or subscripted assignments, control flow, shell wrappers/interpreters,
 * and commands that mutate the current shell. Leading `NAME=value` assignments
 * scoped to a non-stateful command are retained in the segment text so callers can
 * validate them against `bash.allowedEnvVars` and per-rule `env` allowlists.
 */
export function extractLiteralAndChainSegments(command: string): LiteralShellCommandSegment[] | null {
	return extractStrictLiteralShellSegments(command, false);
}

/**
 * The semantic-exception boundary: only an initial literal `cd <path>` chain
 * connected by `&&` and its first non-cd command are eligible. Later commands cannot affect an
 * earlier target; an OR-list anywhere still invalidates destination certainty.
 * Environment assignments stay in argv for the caller's environment policy.
 */
export function extractSimpleApprovalShellSegments(command: string): LiteralShellCommandSegment[] | null {
	if (lexShellCommand(command).some(token => token.kind === "separator" && token.raw.includes("||"))) return null;
	const segments = extractStrictLiteralShellSegments(command, true);
	if (!segments) return null;
	const targetIndex = segments.findIndex(segment => segment.argv[0] !== "cd");
	return targetIndex < 0 ? segments : segments.slice(0, targetIndex + 1);
}

/** Share quote removal and literal validation with the existing compound parser. */
function extractStrictLiteralShellSegments(
	command: string,
	simpleApproval: boolean,
): LiteralShellCommandSegment[] | null {
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
	}
	const segments: LiteralShellCommandSegment[] = [];
	let argv: string[] = [];
	let rawTokens: string[] = [];
	let token = "";
	let tokenStart = -1;
	let quote: "'" | '"' | undefined;
	let segmentStart = 0;
	let redirectTarget = false;
	let invalidRedirect = false;

	const startToken = (index: number) => {
		if (tokenStart < 0) tokenStart = index;
	};
	const pushToken = (end: number) => {
		if (tokenStart < 0) return;
		if (redirectTarget) {
			if (token !== "/dev/null") invalidRedirect = true;
			redirectTarget = false;
		} else {
			argv.push(token);
			rawTokens.push(command.slice(tokenStart, end));
		}
		token = "";
		tokenStart = -1;
	};
	const pushSegment = (end: number): boolean => {
		pushToken(end);
		if (argv.length === 0 || redirectTarget || invalidRedirect) return false;
		let commandIndex = 0;
		while (commandIndex < rawTokens.length && SHELL_ASSIGNMENT_NAME.test(rawTokens[commandIndex]!)) {
			commandIndex++;
		}
		if (commandIndex >= argv.length) return false;
		const executable = argv[commandIndex]!;
		if (executable.length === 0) return false;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		const commandArguments = argv.slice(commandIndex + 1);
		if (
			argv.slice(commandIndex).some(argument => SHELL_ASSIGNMENT.test(argument)) ||
			(commandArguments.some(argument => SHELL_REINTERPRET_OPTION.test(argument)) &&
				commandArguments.some(hasBashApprovalShellControlChar)) ||
			(SHELL_STATEFUL_COMMANDS.has(commandName) && !(simpleApproval && executable === "cd")) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName)
		) {
			return false;
		}
		if (
			simpleApproval &&
			executable === "cd" &&
			(commandIndex !== 0 || argv.length !== 2 || !argv[1] || argv[1].startsWith("-"))
		) {
			return false;
		}
		segments.push({ text: command.slice(segmentStart, end).trim(), argv });
		argv = [];
		rawTokens = [];
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else {
				token += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "$" || ch === "`" || ch === "\n" || ch === "\r") return null;
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined || next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					token += next;
					i++;
				} else {
					token += ch;
				}
				continue;
			}
			token += ch;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			startToken(i);
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined || next === "\n" || next === "\r") return null;
			startToken(i);
			token += next;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken(i);
			continue;
		}
		if (simpleApproval && ch === ">") {
			if (redirectTarget) return null;
			const raw = tokenStart < 0 ? "" : command.slice(tokenStart, i);
			const stderr = raw === "2";
			if (stderr) {
				token = "";
				tokenStart = -1;
			} else {
				// An adjacent unquoted number is a file descriptor, not an argument.
				if (/^[0-9]+$/u.test(raw)) return null;
				pushToken(i);
			}
			if (command[i + 1] === "&") {
				const after = command[i + 3];
				if (
					!stderr ||
					command[i + 2] !== "1" ||
					(after !== undefined && !/[ \t;&>]/u.test(after))
				) {
					return null;
				}
				i += 2;
			} else {
				redirectTarget = true;
			}
			continue;
		}
		if (simpleApproval && ch === ";") {
			if (!pushSegment(i)) return null;
			if (segments.at(-1)?.argv[0] === "cd") return null;
			return command.slice(i + 1).trim() ? segments : null;
		}
		if (ch === "&" && command[i + 1] === "&") {
			if (!pushSegment(i)) return null;
			if (simpleApproval && segments.at(-1)?.argv[0] !== "cd") {
				return command.slice(i + 2).trim() ? segments : null;
			}
			i++;
			segmentStart = i + 1;
			continue;
		}
		if (
			ch === "\n" ||
			ch === "\r" ||
			ch === "&" ||
			ch === "|" ||
			ch === ";" ||
			ch === "<" ||
			ch === ">" ||
			ch === "`" ||
			ch === "$" ||
			ch === "(" ||
			ch === ")" ||
			ch === "*" ||
			ch === "?" ||
			ch === "[" ||
			ch === "]" ||
			ch === "{" ||
			ch === "}" ||
			ch === "~" ||
			(ch === "#" && tokenStart < 0)
		) {
			return null;
		}
		if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return null;
		startToken(i);
		token += ch;
	}

	if (quote || !pushSegment(command.length) || (!simpleApproval && segments.length < 2)) return null;
	return segments;
}

function parseLiteralShellCommandSegment(segmentText: string): LiteralShellCommandSegment | null {
	const pair = extractLiteralAndChainSegments(`${segmentText} && true`);
	return pair ? pair[0]! : null;
}

function segmentMutatesShellState(segmentText: string, literal: LiteralShellCommandSegment | null): boolean {
	if (literal !== null) return false;
	if (/[$`(){}[\]\n\r]/u.test(segmentText)) return true;
	const segments = tokenizeShellSegments(segmentText);
	if (segments.length === 0) return true;
	for (const words of segments) {
		let index = 0;
		while (index < words.length) {
			const word = words[index]!;
			if (SHELL_ASSIGNMENT.test(word)) {
				if (word.includes("[")) return true;
				index++;
			} else if (/^[0-9]*[<>]+$/u.test(word)) {
				index += 2;
			} else if (/^[0-9]*[<>]/u.test(word)) {
				index++;
			} else {
				break;
			}
		}
		const executable = words[index];
		if (!executable) return true;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		const commandArguments = words.slice(index + 1);
		if (
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName) ||
			(commandArguments.some(arg => SHELL_REINTERPRET_OPTION.test(arg)) &&
				commandArguments.some(hasBashApprovalShellControlChar))
		) {
			return true;
		}
	}
	return false;
}

interface ApprovalWord {
	value: string;
	unknown: boolean;
	splits?: boolean;
}

/** Locate executable substitution source without interpreting any of its payload. */
function readApprovalSubstitution(text: string, start: number): { body: string; end: number } | null {
	const backtick = text[start] === "`";
	let depth = 1;
	let quote: "'" | '"' | undefined;
	const bodyStart = start + (backtick ? 1 : 2);
	for (let i = bodyStart; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (backtick && ch === "`") return { body: text.slice(bodyStart, i), end: i + 1 };
		if (quote !== "'" && (text.startsWith("$((", i) || text.startsWith("${", i))) {
			const expansion = readApprovalUnknownExpansion(text, i);
			if (!expansion) return null;
			i = expansion.end - 1;
			continue;
		}
		if (quote !== "'" && ch === "$" && text[i + 1] === "(") {
			const nested = readApprovalSubstitution(text, i);
			if (!nested) return null;
			i = nested.end - 1;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (!backtick && ch === "(") depth++;
		if (!backtick && ch === ")" && --depth === 0) return { body: text.slice(bodyStart, i), end: i + 1 };
	}
	return null;
}

/** Preserve arithmetic/parameter expansion as one word while exposing nested executable substitutions. */
function readApprovalUnknownExpansion(
	text: string,
	start: number,
): { end: number; substitutions: string[] } | null {
	const arithmetic = text.startsWith("$((", start);
	if (!arithmetic && !text.startsWith("${", start)) return null;
	let depth = arithmetic ? 2 : 1;
	let quote: "'" | '"' | undefined;
	const substitutions: string[] = [];
	for (let i = start + (arithmetic ? 3 : 2); i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (quote !== "'" && (text.startsWith("$((", i) || text.startsWith("${", i))) {
			const nested = readApprovalUnknownExpansion(text, i);
			if (!nested) return null;
			substitutions.push(...nested.substitutions);
			i = nested.end - 1;
			continue;
		}
		if (quote !== "'" && (ch === "`" || text.startsWith("$(", i))) {
			const nested = readApprovalSubstitution(text, i);
			if (!nested) return null;
			substitutions.push(nested.body);
			i = nested.end - 1;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (arithmetic && ch === "(") depth++;
		if ((arithmetic ? ch === ")" : ch === "}") && --depth === 0) {
			return { end: i + 1, substitutions };
		}
	}
	return null;
}

/** Quote removal and literal variable propagation; unresolved words stay in their own argv slot. */
function parseApprovalWords(text: string, variables: ReadonlyMap<string, string>): ApprovalWord[] | null {
	const words: ApprovalWord[] = [];
	let value = "";
	let started = false;
	let unknown = false;
	let redirectTarget = false;
	let splits = false;
	let quote: "'" | '"' | undefined;
	const push = () => {
		if (started && !redirectTarget) words.push({ value, unknown, ...(splits ? { splits: true } : {}) });
		if (started) redirectTarget = false;
		value = "";
		started = false;
		unknown = false;
		splits = false;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else value += ch;
			continue;
		}
		if (ch === "\\" && (quote !== '"' || /["\\$`\n]/u.test(text[i + 1] ?? ""))) {
			if (i + 1 >= text.length) return null;
			started = true;
			if (text[i + 1] !== "\n") value += text[i + 1];
			i++;
			continue;
		}
		if (ch === quote) {
			quote = undefined;
			continue;
		}
		if (!quote && (ch === "'" || ch === '"')) {
			quote = ch;
			started = true;
			continue;
		}
		if (!quote && (ch === "<" || ch === ">" || (ch === "&" && text[i + 1] === ">"))) {
			// File descriptors and redirect operands are shell syntax, not executable argv.
			if (/^\d+$/u.test(value)) {
				value = "";
				started = false;
			} else push();
			if (ch === "&") i++;
			const operator = text[i]!;
			while (text[i + 1] === operator) i++;
			if (text[i + 1] === "&" || text[i + 1] === "|" || text[i + 1] === "-") i++;
			redirectTarget = true;
			continue;
		}
		if (!quote && /[ \t\n]/u.test(ch)) {
			push();
			continue;
		}
		started = true;
		if (text.startsWith("$((", i) || (text.startsWith("${", i) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(text.slice(i)))) {
			const expansion = readApprovalUnknownExpansion(text, i);
			if (!expansion) return null;
			value += text.slice(i, expansion.end);
			unknown = true;
			splits = true;
			i = expansion.end - 1;
			continue;
		}
		if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
			const substitution = readApprovalSubstitution(text, i);
			if (!substitution) return null;
			value += text.slice(i, substitution.end);
			unknown = true;
			splits ||= !quote;
			i = substitution.end - 1;
			continue;
		}
		if (ch === "$") {
			const variable = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/u.exec(text.slice(i));
			if (variable) {
				const resolved = variables.get(variable[1] ?? variable[2]!);
				value += resolved ?? variable[0];
				// Unquoted expansion may field-split or glob, so only a single plain word is exact.
				unknown ||= resolved === undefined || (!quote && /[\s*?[\]]/u.test(resolved));
				splits ||= !quote && unknown;
				i += variable[0].length - 1;
				continue;
			}
			const expansion = /^\$\{[^}]*\}|\$./u.exec(text.slice(i));
			value += expansion?.[0] ?? ch;
			unknown = true;
			splits = true;
			i += (expansion?.[0].length ?? 1) - 1;
			continue;
		}
		if (!quote && /[*?[\]~{}<>]/u.test(ch)) {
			unknown = true;
			splits = true;
		}
		value += ch;
	}
	if (quote) return null;
	push();
	return words;
}

// Unknown arguments can hide evaluated programs, write targets, or destructive options.
const APPROVAL_EXPANSION_SENSITIVE_COMMANDS: Record<string, true> = {
	rm: true, mv: true, cp: true, chmod: true, chown: true, dd: true, find: true,
	curl: true, wget: true, ssh: true, scp: true, eval: true, exec: true, sudo: true,
	sh: true, bash: true, dash: true, ash: true, ksh: true, zsh: true, env: true,
	python: true, node: true, bun: true, perl: true, ruby: true, awk: true, gawk: true,
	mawk: true, nawk: true, sed: true, gsed: true, xargs: true, rsync: true, make: true,
	psql: true, sqlite: true, mysql: true, osascript: true, lua: true, luajit: true,
	julia: true, deno: true, pypy: true,
};

function parseApprovalShellSegment(
	text: string,
	variables: ReadonlyMap<string, string>,
): { argv: string[]; unknownArgv: number[]; literal: LiteralShellCommandSegment | null; stateful: boolean; changesCwd: boolean; unsafeExpansion: boolean } | null {
	const words = parseApprovalWords(text, variables);
	if (!words?.length) return null;
	const argv = words.map(word => word.value);
	const unknownArgv = words.flatMap((word, index) => word.unknown ? [index] : []);
	let commandIndex = 0;
	while (commandIndex < argv.length && isShellEnvironmentAssignment(argv[commandIndex]!)) commandIndex++;
	const executable = argv[commandIndex]?.split("/").pop() ?? "";
	const expansionSensitive = unknownArgv.length > 0 && Object.hasOwn(
		APPROVAL_EXPANSION_SENSITIVE_COMMANDS,
		executable.toLowerCase().replace(/(?:[-.]?\d[\d.]*)?(?:\.exe)?$/u, ""),
	);
	const safePrintf = executable === "printf" && !argv.slice(commandIndex + 1).some(word => word.startsWith("-v") || word.includes("%n")) &&
		!unknownArgv.includes(commandIndex + 1);
	const safeSet = executable === "set" && unknownArgv.length === 0 && commandIndex === 0 &&
		/^(?:(?:-[eu]+)(?: |$)|-[eu]*o pipefail(?: |$))+$/u.test(argv.slice(1).join(" "));
	const scopedShellState = argv.slice(0, commandIndex).some(word =>
		/^(?:PATH|FPATH|IFS|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|path|fpath|commands|functions|builtins)=/u.test(word));
	const changesCwd = executable === "cd";
	const stateful = !executable || unknownArgv.includes(commandIndex) || scopedShellState ||
		(SHELL_STATEFUL_COMMANDS.has(executable) && !safePrintf && !safeSet && !changesCwd) ||
		Object.hasOwn(SHELL_INTERPRETER_COMMANDS, executable);
	// Preserve assignment syntax for the strict parser, but quote every literal argument.
	const quoted = argv.map((word, index) => {
		if (index < commandIndex) {
			const equals = word.indexOf("=");
			return `${word.slice(0, equals + 1)}'${word.slice(equals + 1).replaceAll("'", "'\\''")}'`;
		}
		return `'${((safePrintf || safeSet) && index === commandIndex ? "echo" : word).replaceAll("'", "'\\''")}'`;
	}).join(" ");
	const literal = stateful || expansionSensitive ? null : parseLiteralShellCommandSegment(quoted);
	if (literal) {
		literal.text = text;
		literal.argv = argv;
		if (unknownArgv.length) literal.unknownArgv = unknownArgv;
	}
	return {
		argv, unknownArgv, literal, stateful, changesCwd,
		unsafeExpansion: expansionSensitive || words.some(word => word.splits),
	};
}

/** An approval unit; opaque units retain their complete source, including heredoc bodies. */
export interface ApprovalShellSegment {
	text: string;
	literal: LiteralShellCommandSegment | null;
	/** Parsed argv even when an opaque command cannot be allowed. */
	argv?: string[];
	unknownArgv?: number[];
	/** Shell mutation or file redirection makes command-local allows insufficient. */
	allowUnsafe?: boolean;
	/** Command is inside a structural shell group or introduced by reserved shell negation. */
	approvalGrouped?: boolean;
	/** Executable lookup or shell interpretation may have been retargeted. Semantic allows must not override this. */
	shellStateUnknown?: boolean;
	/** Execution context whose cwd applies to this command; zero identifies the top-level shell. */
	cwdScope?: number;
	/** Parent scope to inherit on first use of cwdScope. */
	cwdParentScope?: number;
	/** Iteration/control-flow cwd cannot be reconstructed from the flattened command order. */
	cwdUnknown?: boolean;
	/** Invalidate the enclosing cwd after an uncertain final-pipeline or loop cwd change. */
	cwdUnknownAfter?: boolean;
}

/** Shell interpreters read stdin as source unless -c or a script operand selects another source. */
function approvalShellReadsStdin(argv: readonly string[]): boolean {
	let index = 0;
	while (index < argv.length && isShellEnvironmentAssignment(argv[index]!)) index++;
	if (!/^(?:ash|bash|dash|ksh|sh|zsh)$/u.test(argv[index]?.split("/").pop() ?? "")) return false;
	let stdin = false;
	let script = false;
	for (index++; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--command" || /^-[^-]*c/u.test(argument)) return false;
		if (argument === "--stdin" || /^-[^-]*s/u.test(argument)) stdin = true;
		if (argument === "-o" || argument === "+o" || argument === "--rcfile" || argument === "--init-file") {
			index++;
			continue;
		}
		if (argument === "--") {
			script ||= index + 1 < argv.length;
			break;
		}
		if (!/^[-+]/u.test(argument)) script = true;
	}
	return stdin || !script;
}

/**
 * Pinned e540 restriction view. This intentionally retains its opaque expansions
 * and literal-argv spelling: only the newer parser may justify removing one of
 * its restrictions. Never use this compatibility view to grant an allow.
 */
export function extractLegacyApprovalShellSegments(command: string): ApprovalShellSegment[] | null {
	const pieces: string[] = [];
	const heredocs = new Set<number>();
	const pending: { delimiter: string; stripTabs: boolean; owner: number }[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	const push = (end: number) => {
		const text = command.slice(start, end).trim();
		if (text) pieces.push(text);
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length || command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			i++;
			continue;
		}
		if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return null;
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === start || /[ \t]/u.test(command[i - 1]!))) return null;
		if (ch === "<" && command[i + 1] === "<") {
			const match = /^<<(-)?[ \t]*(?:'([^'\n]+)'|"([^"$`\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))(?=[ \t\n;&|)]|$)/u.exec(command.slice(i));
			if (!match) return null;
			pending.push({ delimiter: match[2] ?? match[3] ?? match[4]!, stripTabs: !!match[1], owner: pieces.length });
			i += match[0].length - 1;
			continue;
		}
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") return null;
		if (ch === "{" || ch === "}" || ch === "\r") return null;
		const redirect =
			(ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) ||
			(ch === "|" && command[i - 1] === ">");
		if (!redirect && /[\n;&|()]/u.test(ch)) {
			push(i);
			let operator = ch;
			if ((ch === "&" || ch === "|") && (command[i + 1] === ch || (ch === "|" && command[i + 1] === "&"))) operator += command[++i];
			pieces.push(operator);
			start = i + 1;
			if (ch === "\n" && pending.length > 0) {
				for (const doc of pending) {
					const bodyStart = start;
					let found = false;
					while (start < command.length) {
						const newline = command.indexOf("\n", start);
						const end = newline < 0 ? command.length : newline;
						const line = command.slice(start, end);
						start = newline < 0 ? command.length : newline + 1;
						if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.delimiter) {
							found = true;
							break;
						}
					}
					if (!found || !pieces[doc.owner]) return null;
					pieces[doc.owner] += `\n${command.slice(bodyStart, start).trimEnd()}`;
					heredocs.add(doc.owner);
				}
				pending.length = 0;
				i = start - 1;
			}
		}
	}
	if (quote || pending.length > 0) return null;
	push(command.length);
	const segments: ApprovalShellSegment[] = [];
	const stack: { kind: "for" | "while" | "until" | "("; body: boolean }[] = [];
	let expectCommand = true;
	let needsCommand = false;
	let structured = false;
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index]!;
		if (piece === "\n" && expectCommand) continue;
		if (/^(?:;|&|&&|\|\|?|\|&|\n)$/u.test(piece)) {
			if (expectCommand) return null;
			expectCommand = true;
			needsCommand = piece !== ";" && piece !== "&" && piece !== "\n";
			continue;
		}
		if (piece === "(") {
			if (!expectCommand || pieces[index + 1] === "(") return null;
			stack.push({ kind: "(", body: false });
			structured = true;
			continue;
		}
		if (piece === ")") {
			if (expectCommand && (needsCommand || pieces[index - 1] === "(")) return null;
			if (stack.pop()?.kind !== "(") return null;
			expectCommand = false;
			continue;
		}
		if (!expectCommand) return null;
		let text = piece;
		const top = stack[stack.length - 1];
		if (text === "done") {
			if (!top || top.kind === "(" || !top.body || needsCommand) return null;
			stack.pop();
			expectCommand = false;
			continue;
		}
		if (/^do(?:[ \t]|$)/u.test(text)) {
			if (!top || top.kind === "(" || top.body || needsCommand) return null;
			top.body = true;
			text = text.slice(2).trimStart();
			if (!text) continue;
		}
		const forLoop = /^for[ \t]+([a-z][a-z0-9_]*)[ \t]+in[ \t]+(.+)$/u.exec(text);
		if (forLoop) {
			if (["path", "fpath", "commands", "functions", "builtins"].includes(forLoop[1]!)) return null;
			if (!parseLiteralShellCommandSegment(`echo ${forLoop[2]}`) || heredocs.has(index)) return null;
			stack.push({ kind: "for", body: false });
			structured = true;
			expectCommand = false;
			continue;
		}
		const conditionLoop = /^(while|until)[ \t]+(.+)$/u.exec(text);
		if (conditionLoop) {
			stack.push({ kind: conditionLoop[1] as "while" | "until", body: false });
			structured = true;
			text = conditionLoop[2]!;
		}
		segments.push({ text, literal: heredocs.has(index) ? null : parseLegacyApprovalShellSegment(text) });
		expectCommand = false;
		needsCommand = false;
	}
	if (stack.length > 0 || needsCommand || segments.length === 0) return null;
	return structured || segments.length > 1 || heredocs.size > 0 ? segments : null;
}

function parseLegacyApprovalShellSegment(text: string): LiteralShellCommandSegment | null {
	let literalText = "";
	let quote: "'" | '"' | undefined;
	let expanded = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quote === "'") {
			literalText += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			literalText += text.slice(i, i + 2);
			i++;
			continue;
		}
		if (ch === "$") {
			const variable = quote === '"' ? /^\$[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(i)) : null;
			if (!variable) return null;
			literalText += "expanded-argument";
			expanded = true;
			i += variable[0].length - 1;
			continue;
		}
		if (!quote && (i === 0 || /[ \t]/u.test(text[i - 1]!))) {
			const redirect = /^(?:[12]?>&[12]|[12]?>[ \t]*\/dev\/null)(?=[ \t]|$)/u.exec(text.slice(i));
			if (redirect) {
				literalText += " ";
				i += redirect[0].length - 1;
				continue;
			}
		}
		literalText += ch;
		if (ch === quote) quote = undefined;
		else if (!quote && (ch === "'" || ch === '"')) quote = ch;
	}
	const words = tokenizeShellSegments(literalText);
	if (words.length !== 1 || words[0]!.length === 0) return null;
	const argv = words[0]!;
	let index = 0;
	while (index < argv.length && isShellEnvironmentAssignment(argv[index]!)) index++;
	const executable = argv[index]?.split("/").pop()?.toLowerCase().replace(/(?:[-.]?\d[\d.]*)?(?:\.exe)?$/u, "");
	if (!executable || (expanded && (argv[index]!.includes("expanded-argument") ||
		Object.hasOwn(APPROVAL_EXPANSION_SENSITIVE_COMMANDS, executable) ||
		(executable === "git" && argv.some(word => /^(?:push|reset|clean|checkout|restore|-c|--config(?:=|$))/u.test(word)))))) return null;
	const printf = /^printf[ \t]/u.test(literalText) &&
		!argv.some(word => word.startsWith("-v") || word.includes("%n")) && !argv[1]?.includes("expanded-argument");
	const literal = parseLiteralShellCommandSegment(printf ? literalText.replace(/^printf/u, "echo") : literalText);
	if (!literal) return null;
	if (printf) literal.argv[0] = "printf";
	literal.argv = tokenizeShellSegments(text)[0] ?? literal.argv;
	return literal;
}

/**
 * Split shell lists, pipelines, subshells and simple loops without treating data as commands.
 * Unknown expansions remain command-local unknown arguments. Substitution bodies are
 * inspected recursively. Heredoc bodies are data unless a shell interpreter reads them as source.
 */
export function extractApprovalShellSegments(command: string): ApprovalShellSegment[] | null {
	return extractApprovalShellSegmentsInScope(command, { next: 1 }, 0);
}

function extractApprovalShellSegmentsInScope(
	command: string,
	scopes: { next: number },
	initialScope: number,
	initialParentScope?: number,
	initialCwdUnknown = false,
): ApprovalShellSegment[] | null {
	const pieces: string[] = [];
	const heredocs = new Set<number>();
	const heredocSources = new Map<number, string[]>();
	const pending: { delimiter: string; stripTabs: boolean; owner: number; stdin: boolean }[] = [];
	const substitutions = new Map<number, string[]>();
	let start = 0;
	let quote: "'" | '"' | undefined;
	const push = (end: number) => {
		const text = command.slice(start, end).trim();
		if (text) pieces.push(text);
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length || command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			i++;
			continue;
		}
		if (command.startsWith("$((", i) || command.startsWith("${", i)) {
			const expansion = readApprovalUnknownExpansion(command, i);
			if (!expansion) return null;
			if (expansion.substitutions.length) {
				const bodies = substitutions.get(pieces.length) ?? [];
				bodies.push(...expansion.substitutions);
				substitutions.set(pieces.length, bodies);
			}
			i = expansion.end - 1;
			continue;
		}
		if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
			const substitution = readApprovalSubstitution(command, i);
			if (!substitution) return null;
			const bodies = substitutions.get(pieces.length) ?? [];
			bodies.push(substitution.body);
			substitutions.set(pieces.length, bodies);
			i = substitution.end - 1;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === start || /[ \t]/u.test(command[i - 1]!))) return null;
		if (ch === "<" && command[i + 1] === "<") {
			const match = /^<<(-)?[ \t]*(?:'([^'\n]+)'|"([^"$`\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))(?=[ \t\n;&|)]|$)/u.exec(
				command.slice(i),
			);
			if (!match) return null;
			const descriptor = /(?:^|[ \t])([0-9]+)$/u.exec(command.slice(start, i))?.[1];
			pending.push({
				delimiter: match[2] ?? match[3] ?? match[4]!,
				stripTabs: !!match[1],
				owner: pieces.length,
				stdin: descriptor === undefined || descriptor === "0",
			});
			i += match[0].length - 1;
			continue;
		}
		// Process substitution and arithmetic/group syntax outside the supported subshell grammar.
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") return null;
		if (ch === "\r") return null;
		const structuralCandidate = ch === "{" || ch === "}" || ch === "!";
		const prefix = structuralCandidate ? command.slice(start, i).trim() : "";
		const structuralBrace = (ch === "{" || ch === "}") &&
			(i === start || /[ \t\n;&|()]/u.test(command[i - 1]!)) &&
			(i + 1 === command.length || /[ \t\n;&|()]/u.test(command[i + 1]!)) &&
			(prefix === "" || (ch === "{" && /^(?:do|while|until)$/u.test(prefix)));
		const negation = ch === "!" && (prefix === "" || prefix === "do") &&
			(i + 1 === command.length || /[ \t\n;&|()]/u.test(command[i + 1]!));
		const redirect =
			(ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) ||
			(ch === "|" && command[i - 1] === ">");
		if (!redirect && (/[\n;&|()]/u.test(ch) || structuralBrace || negation)) {
			push(i);
			let operator = ch;
			if ((ch === "&" || ch === "|") && (command[i + 1] === ch || (ch === "|" && command[i + 1] === "&"))) {
				operator += command[++i];
			}
			pieces.push(operator);
			start = i + 1;
			if (ch === "\n" && pending.length > 0) {
				for (const doc of pending) {
					const bodyStart = start;
					let bodyEnd = start;
					let found = false;
					while (start < command.length) {
						const newline = command.indexOf("\n", start);
						const end = newline < 0 ? command.length : newline;
						const line = command.slice(start, end);
						start = newline < 0 ? command.length : newline + 1;
						if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.delimiter) {
							found = true;
							bodyEnd = end - line.length;
							break;
						}
					}
					if (!found || !pieces[doc.owner]) return null;
					if (doc.stdin) {
						const body = command.slice(bodyStart, bodyEnd);
						// Only the last stdin heredoc supplies interpreter source.
						heredocSources.set(doc.owner, [doc.stripTabs ? body.replace(/^\t+/gmu, "") : body]);
					}
					pieces[doc.owner] += `\n${command.slice(bodyStart, start).trimEnd()}`;
					heredocs.add(doc.owner);
				}
				pending.length = 0;
				i = start - 1;
			}
		}
	}
	if (quote || pending.length > 0) return null;
	push(command.length);

	const segments: ApprovalShellSegment[] = [];
	const stack: {
		kind: "for" | "while" | "until" | "(" | "{";
		body: boolean;
		variable?: string;
		values?: string[];
		assignments?: Map<string, Map<string, string | undefined>>;
		previousScope?: number;
		previousParentScope?: number;
		invalidatedVariables?: Set<string>;
	}[] = [];
	const variables = new Map<string, string>();
	let shellStateUnknown = false;
	let expectCommand = true;
	let needsCommand = false;
	let conditionalAssignment = false;
	let pendingNegation = false;
	let cwdScope = initialScope;
	let cwdParentScope = initialParentScope;
	// A successful cd is known only along its success-only && continuation.
	// List boundaries and skipped commands leave both old and new cwd possible.
	const cwdStates = new Map<number, { unknown: boolean; successOnly: boolean; conditional: boolean }>();
	cwdStates.set(initialScope, { unknown: initialCwdUnknown, successOnly: false, conditional: false });
	const cwdState = () => cwdStates.get(cwdScope)!;
	const loopMayChangeCwd = pieces.some(piece => {
		const words = parseApprovalWords(
			piece.replace(/^(?:do|while|until)[ \t]+/u, "").replace(/^(?:![ \t]+)+/u, ""),
			variables,
		);
		let commandIndex = 0;
		while (words?.[commandIndex] && isShellEnvironmentAssignment(words[commandIndex]!.value)) commandIndex++;
		return /^(?:cd|pushd|popd)$/u.test(words?.[commandIndex]?.value.split("/").pop() ?? "");
	});
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index]!;
		if (piece === "!") {
			if (!expectCommand) return null;
			pendingNegation = true;
			needsCommand = true;
			continue;
		}
		if (piece === "\n" && expectCommand && !pendingNegation) continue;
		if (/^(?:;|&|&&|\|\|?|\|&|\n)$/u.test(piece)) {
			if (expectCommand) return null;
			conditionalAssignment ||= piece !== ";" && piece !== "\n";
			const state = cwdState();
			if (piece !== "&&" && state.successOnly) {
				state.unknown = true;
				state.successOnly = false;
			}
			state.conditional = piece === "&&" || piece === "||";
			expectCommand = true;
			needsCommand = piece !== ";" && piece !== "&" && piece !== "\n";
			continue;
		}
		if (piece === "(" || piece === "{") {
			if (!expectCommand || (piece === "(" && pieces[index + 1] === "(")) return null;
			if (pendingNegation) cwdState().conditional = true;
			pendingNegation = false;
			needsCommand = false;
			stack.push({ kind: piece, body: false, previousScope: cwdScope, previousParentScope: cwdParentScope });
			if (piece === "{") continue;
			conditionalAssignment = true;
			cwdParentScope = cwdScope;
			cwdScope = scopes.next++;
			cwdStates.set(cwdScope, {
				unknown: cwdStates.get(cwdParentScope)!.unknown,
				successOnly: false,
				conditional: false,
			});
			continue;
		}
		if (piece === ")" || piece === "}") {
			if (expectCommand && (needsCommand || pieces[index - 1] === "(" || pieces[index - 1] === "{")) return null;
			if (piece === "}" && !expectCommand) return null;
			const frame = stack.pop();
			if (frame?.kind !== (piece === ")" ? "(" : "{")) return null;
			cwdScope = frame.previousScope!;
			cwdParentScope = frame.previousParentScope;
			expectCommand = false;
			continue;
		}
		if (!expectCommand) return null;
		let text = piece;
		// Unsupported compound bodies must not become definite cwd mutations.
		if (/^(?:if|then|elif|else|fi|case|esac|function)(?:[ \t]|$)/u.test(text)) return null;
		const top = stack[stack.length - 1];
		if (text === "done") {
			if (!top || top.kind === "(" || top.kind === "{" || !top.body || needsCommand) return null;
			stack.pop();
			if (top.variable && top.values?.length !== 0) {
				variables.delete(top.variable);
				for (const outer of stack) {
					outer.invalidatedVariables ??= new Set();
					outer.invalidatedVariables.add(top.variable);
				}
			}
			expectCommand = false;
			continue;
		}
		if (/^do(?:[ \t]|$)/u.test(text)) {
			if (!top || top.kind === "(" || top.kind === "{" || top.body || needsCommand) return null;
			top.body = true;
			text = text.slice(2).trimStart();
			if (!text) continue;
		}
		const conditionLoop = /^(while|until)[ \t]+(.+)$/u.exec(text);
		if (conditionLoop) {
			stack.push({ kind: conditionLoop[1] as "while" | "until", body: false });
			text = conditionLoop[2]!;
		}
		let negated = pendingNegation;
		pendingNegation = false;
		while (/^!(?:[ \t]|$)/u.test(text)) {
			negated = true;
			text = text.slice(1).trimStart();
		}
		if (!text) return null;
		if (negated) cwdState().conditional = true;
		const pipelineBefore = /^(?:\||\|&)$/u.test(pieces[index - 1] ?? "");
		const pipelineAfter = /^(?:\||\|&)$/u.test(pieces[index + 1] ?? "");
		const childProcess = pipelineBefore || pipelineAfter || pieces[index + 1] === "&";
		const executionScope = childProcess ? scopes.next++ : cwdScope;
		const executionParentScope = childProcess ? cwdScope : cwdParentScope;
		const loopCwdUnknown = loopMayChangeCwd &&
			(stack.some(frame => frame.kind !== "(" && frame.kind !== "{") || /^(?:while|until)[ \t]/u.test(text));
		const provenance = {
			cwdScope: executionScope,
			...(negated || stack.some(frame => frame.kind === "(" || frame.kind === "{") ? { approvalGrouped: true } : {}),
			...(loopCwdUnknown || cwdState().unknown ? { cwdUnknown: true } : {}),
			...(executionParentScope !== undefined ? { cwdParentScope: executionParentScope } : {}),
		};
		for (const body of substitutions.get(index) ?? []) {
			const inner = extractApprovalShellSegmentsInScope(body, scopes, scopes.next++, executionScope, cwdState().unknown);
			if (!inner) return null;
			segments.push(...inner.map(segment => ({
				...segment,
				literal: null,
				allowUnsafe: true,
				...(shellStateUnknown ? { shellStateUnknown: true } : {}),
			})));
		}
		const forLoop = /^for[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in(?:[ \t]+(.*))?$/u.exec(text);
		if (forLoop) {
			const variable = forLoop[1]!;
			// Shell-special variables can retarget executable lookup or alter later parsing.
			if (/^(?:PATH|FPATH|IFS|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|path|fpath|commands|functions|builtins)$/u.test(variable)) return null;
			const values = parseApprovalWords(forLoop[2] ?? "", variables);
			if (!values || heredocs.has(index)) return null;
			conditionalAssignment = false;
			stack.push({ kind: "for", body: false, variable, values: values.some(value => value.unknown) ? undefined : values.map(value => value.value) });
			expectCommand = false;
			continue;
		}
		let contexts: Map<string, string>[] = [new Map(variables)];
		const loopContextValues = new Map<Map<string, string>, Map<string, string>>();
		for (const loop of stack) {
			if (!loop.variable) continue;
			const variable = loop.variable;
			if (!loop.values) {
				for (const context of contexts) context.delete(variable);
			} else {
				contexts = contexts.flatMap(context => loop.values!.map(value => {
					const next = new Map(context).set(variable, value);
					loopContextValues.set(next, new Map(loopContextValues.get(context)).set(variable, value));
					for (const [name, assigned] of loop.assignments?.get(value) ?? []) {
						if (assigned === undefined) next.delete(name);
						else next.set(name, assigned);
					}
					return next;
				}));
			}
			for (const context of contexts) {
				for (const name of loop.invalidatedVariables ?? []) context.delete(name);
			}
		}
		const assignmentWords = parseApprovalWords(text, variables);
		if (assignmentWords?.length && assignmentWords.every(word => SHELL_ASSIGNMENT_NAME.test(word.value))) {
			for (const context of contexts) {
				const resolvedWords = parseApprovalWords(text, context)!;
				for (const word of resolvedWords) {
					const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word.value);
					if (!match || /^(?:PATH|FPATH|IFS|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|path|fpath|commands|functions|builtins)$/u.test(match[1]!)) {
						shellStateUnknown = true;
						variables.clear();
						continue;
					}
					const name = match[1]!;
					const unconditional = !conditionalAssignment &&
						!stack.some(frame => frame.kind !== "for" && frame.kind !== "{") &&
						!/^(?:\||\|&|&)$/u.test(pieces[index + 1] ?? "");
					const value = word.unknown || !unconditional ? undefined : match[2]!;
					const loop = stack.at(-1);
					if (loop?.variable) {
						variables.delete(name);
						// An inner loop can overwrite outer bindings; do not resurrect stale values on exit.
						for (const outer of stack) {
							if (outer === loop) continue;
							outer.invalidatedVariables ??= new Set();
							outer.invalidatedVariables.add(name);
							for (const assigned of outer.assignments?.values() ?? []) assigned.set(name, undefined);
						}
						const loopValue = loopContextValues.get(context)?.get(loop.variable);
						if (loopValue !== undefined) {
							loop.assignments ??= new Map();
							const assigned = loop.assignments.get(loopValue) ?? new Map<string, string | undefined>();
							assigned.set(name, value);
							loop.assignments.set(loopValue, assigned);
						}
					} else if (value === undefined) variables.delete(name);
					else variables.set(name, value);
				}
				segments.push({
					...provenance,
					text,
					argv: resolvedWords.map(word => word.value),
					literal: null,
					allowUnsafe: true,
					...(shellStateUnknown ? { shellStateUnknown: true } : {}),
					...(resolvedWords.some(word => word.unknown) ? {
						unknownArgv: resolvedWords.flatMap((word, wordIndex) => word.unknown ? [wordIndex] : []),
					} : {}),
				});
			}
		} else {
			for (const context of contexts) {
				const parsed = parseApprovalShellSegment(heredocs.has(index) ? text.split("\n", 1)[0]! : text, context);
				if (parsed && heredocSources.has(index) && approvalShellReadsStdin(parsed.argv)) {
					for (const body of heredocSources.get(index)!) {
						if (!body.trim()) continue;
						const inner = extractApprovalShellSegmentsInScope(body, scopes, scopes.next++, executionScope, cwdState().unknown);
						if (!inner) return null;
						segments.push(...inner.map(segment => ({
							...segment,
							literal: null,
							allowUnsafe: true,
							...(shellStateUnknown ? { shellStateUnknown: true } : {}),
						})));
					}
				}
				// Descriptor swaps and /dev/null output do not write a policy-relevant file.
				// Mask quoted data first so redirect-looking payloads cannot affect this decision.
				const redirectSource = text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/gu, quoted => "_".repeat(quoted.length));
				const redirect = /[<>]/u.test(redirectSource.replace(
					/(^|[ \t])(?:[12]?>&[12]|[12]?>[ \t]*\/dev\/null)(?=[ \t]|$)/gu, "$1",
				));
				const unsafe = shellStateUnknown || redirect || heredocs.has(index) ||
					substitutions.has(index) || parsed?.unsafeExpansion;
				segments.push({
					...provenance,
					...((pipelineBefore && !pipelineAfter || loopCwdUnknown) && parsed?.changesCwd ? { cwdUnknownAfter: true } : {}),
					text,
					literal: unsafe ? null : parsed?.literal ?? null,
					...(parsed ? { argv: parsed.argv } : {}),
					...(parsed?.unknownArgv.length ? { unknownArgv: parsed.unknownArgv } : {}),
					...(unsafe || parsed?.stateful || parsed?.changesCwd ? { allowUnsafe: true } : {}),
					...(shellStateUnknown || parsed?.stateful ? { shellStateUnknown: true } : {}),
				});
				if (parsed?.changesCwd && !childProcess) {
					const state = cwdState();
					const successOnly = !state.conditional && !loopCwdUnknown && pieces[index + 1] === "&&";
					state.unknown = !successOnly;
					state.successOnly = successOnly;
				}
				if (parsed?.stateful) {
					shellStateUnknown = true;
					variables.clear();
				}
			}
		}
		expectCommand = false;
		needsCommand = false;
	}
	if (stack.length > 0 || needsCommand || segments.length === 0) return null;
	return segments;
}

/**
 * Splits a single-line command on top-level unquoted `&&` (two or more clauses)
 * and annotates each clause with {@link LiteralShellCommandSegment} when that
 * clause alone qualifies for literal compound-command approval.
 *
 * Top-level `;`, `&`, and `||` have equal or lower precedence than `&&` and
 * alter short-circuit flow, so commands containing them outside quotes/parens
 * are rejected (`null`). Higher-precedence constructs inside a clause (pipes,
 * redirections, expansions, globs, stateful builtins) stay inside that clause
 * with `literal: null`.
 */
export function extractAndChainSegments(command: string): AndChainSegment[] | null {
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
	}
	const rawSegments: string[] = [];
	let quote: "'" | '"' | undefined;
	let parenDepth = 0;
	let inBacktick = false;
	let inDoubleBracket = false;
	let braceDepth = 0;
	let atWordStart = true;
	let segmentStart = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			atWordStart = false;
			continue;
		}
		if (ch === "`") {
			inBacktick = !inBacktick;
			atWordStart = false;
			continue;
		}
		if (inBacktick) continue;
		if (ch === "'" || ch === '"') {
			quote = ch;
			atWordStart = false;
			continue;
		}
		if (ch === "#" && atWordStart) {
			break;
		}
		if (
			!inDoubleBracket &&
			atWordStart &&
			ch === "[" &&
			command[i + 1] === "[" &&
			(command[i + 2] === " " || command[i + 2] === "\t")
		) {
			inDoubleBracket = true;
			i++;
			atWordStart = false;
			continue;
		}
		if (inDoubleBracket && atWordStart && ch === "]" && command[i + 1] === "]") {
			const after = command[i + 2];
			if (
				after === undefined ||
				after === " " ||
				after === "\t" ||
				after === ";" ||
				after === "&" ||
				after === "|" ||
				after === ")"
			) {
				inDoubleBracket = false;
				i++;
				atWordStart = false;
				continue;
			}
		}
		// `${…}` expansions and `{ …; }` groups (zsh also accepts `{ … }`) keep their `&&` inside.
		if (ch === "$" && command[i + 1] === "{") {
			braceDepth++;
			i++;
			atWordStart = false;
			continue;
		}
		if (ch === "{" && atWordStart && (command[i + 1] === " " || command[i + 1] === "\t")) {
			braceDepth++;
			continue;
		}
		if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			atWordStart = false;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
			atWordStart = true;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === 0) return null;
			parenDepth--;
			atWordStart = false;
			continue;
		}
		if (parenDepth > 0 || inDoubleBracket || braceDepth > 0) {
			atWordStart = ch === " " || ch === "\t" || ch === "&" || ch === "|" || ch === "(" || ch === ")";
			continue;
		}
		if (ch === ";") return null;
		if (ch === "|" && command[i + 1] === "|") return null;
		if (ch === "&") {
			const prev = command[i - 1];
			const next = command[i + 1];
			if (prev === ">" || prev === "<" || next === ">") {
				atWordStart = false;
				continue;
			}
			if (next === "&" && command[i + 2] !== "&") {
				const segment = command.slice(segmentStart, i).trim();
				if (segment.length === 0) return null;
				rawSegments.push(segment);
				i++;
				segmentStart = i + 1;
				atWordStart = true;
				continue;
			}
			return null;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (quote || inBacktick || parenDepth !== 0 || inDoubleBracket || braceDepth !== 0) return null;
	const tail = command.slice(segmentStart).trim();
	if (tail.length === 0) return null;
	rawSegments.push(tail);
	if (rawSegments.length < 2) return null;
	return rawSegments.map(text => {
		const literal = parseLiteralShellCommandSegment(text);
		return {
			text,
			literal,
			mutatesShellState: segmentMutatesShellState(text, literal),
		};
	});
}

/**
 * A flat shell command segment with the context needed to decide interception.
 *
 * @see extractFlatShellCommandSegments
 */
interface FlatShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/**
	 * True when this segment consumes the previous stage's stdout via an
	 * unquoted `|` or `|&`. Blank and comment-only continuation lines preserve
	 * the pending pipe state. Such a stage reads piped stdin, so path-based
	 * dedicated tools (read/grep/glob) cannot replace it. `||`, `;`, `&`, and
	 * `&&` start an independent command and leave this false.
	 */
	pipedStdin: boolean;
}

/**
 * Returns the flat shell command segments with the original text of each. Unlike
 * `tokenizeShellSegments`, this preserves quoting and escaping so the results
 * are safe to match against user-configured regular expressions, and flags
 * segments that receive piped stdin.
 *
 * The extractor deliberately declines to split syntax whose execution context
 * cannot be determined with this small scanner (heredocs, command substitution,
 * backticks, grouping, and malformed quoting). Callers must still check the
 * complete input in that case.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
	const segments: FlatShellCommandSegment[] = [];
	let segmentStart = 0;
	let inSingle = false;
	let inDouble = false;
	let atWordStart = true;
	let currentPiped = false;

	const pushSegment = (end: number): boolean => {
		const segment = command.slice(segmentStart, end).trim();
		if (segment.length === 0) return false;
		segments.push({ text: segment, pipedStdin: currentPiped });
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return [];
				i++;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return [];
			continue;
		}

		if (ch === "'") {
			inSingle = true;
			atWordStart = false;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			atWordStart = false;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return [];
			i++;
			atWordStart = false;
			continue;
		}
		if (
			ch === "`" ||
			ch === "(" ||
			ch === ")" ||
			(ch === "$" && command[i + 1] === "(") ||
			(ch === "$" && command[i + 1] === "{") ||
			(ch === "<" && command[i + 1] === "<") ||
			((ch === "{" || ch === "}") &&
				atWordStart &&
				(command[i + 1] === undefined || /[ \t\n;]/.test(command[i + 1])))
		) {
			return [];
		}
		if (ch === "#" && atWordStart) {
			const pushed = pushSegment(i);
			const newline = command.indexOf("\n", i + 1);
			if (newline === -1) return segments;
			i = newline;
			segmentStart = newline + 1;
			atWordStart = true;
			// Preserve a pending pipe through a comment-only continuation.
			if (pushed) currentPiped = false;
			continue;
		}
		const isRedirectionOperatorCharacter =
			ch === "|"
				? command[i - 1] === ">"
				: ch === "&"
					? command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">"
					: false;
		if ((ch === "\n" || ch === ";" || ch === "|" || ch === "&") && !isRedirectionOperatorCharacter) {
			const pushed = pushSegment(i);
			const doubled = (ch === "|" || ch === "&") && command[i + 1] === ch;
			const pipeStderr = ch === "|" && command[i + 1] === "&";
			if (doubled || pipeStderr) i++;
			// `|` and `|&` pipe into the next segment. Blank continuation
			// lines preserve that pending state; all other operators reset it.
			if (pushed || ch !== "\n") currentPiped = ch === "|" && !doubled;
			segmentStart = i + 1;
			atWordStart = true;
			continue;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (inSingle || inDouble) return [];
	pushSegment(command.length);
	return segments;
}

/**
 * Shell metacharacters that end an unquoted `cd` target token. A redirect,
 * extra argument, or any operator in this set means the leading construct is
 * more than a bare `cd <path>`, so extraction must bail.
 */
const CD_TARGET_TERMINATORS: Record<string, true> = {
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
	"&": true,
	"|": true,
	";": true,
	"<": true,
	">": true,
	"(": true,
	")": true,
};

const CD_TARGET_EXPANSION_CHARS = "$`()*?[]{}";

/**
 * Parses a leading `cd <path> && ...` or `cd <path>; ...` prefix so the bash
 * tool can route the target through its structured `cwd` parameter when the
 * model omits it.
 *
 * Returns the single path token (quotes and backslash escapes resolved to their
 * literal value), the command remainder after the separator, and which
 * separator it was, or `null` when the command does not begin with exactly
 * `cd`, one path token, and a top-level `&&` or `;`. The scanner deliberately
 * bails on anything else in the prefix — redirects (`cd /tmp 2>/dev/null && ...`),
 * extra arguments, or paths needing shell expansion (`$`, backticks, `(`) —
 * leaving the whole command for the shell instead of absorbing shell syntax
 * into `cwd`.
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string; separator: "&&" | ";" } | null {
	const prefix = /^cd[ \t]+/.exec(command);
	if (!prefix) return null;
	let i = prefix[0].length;
	const hasUnquotedLeadingTilde = command[i] === "~";
	let path = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				// A line continuation crosses the first physical line. Leave it to
				// the shell rather than turning the escaped newline into cwd text.
				if (next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					path += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "$" || ch === "`") return null;
			path += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			// Preserve shell line-continuation semantics by declining extraction.
			if (command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			path += command[i + 1];
			i++;
			continue;
		}
		if (CD_TARGET_EXPANSION_CHARS.includes(ch)) return null;
		if (CD_TARGET_TERMINATORS[ch]) break;
		path += ch;
	}
	// Unterminated quote or empty target: leave the command for the shell.
	if (inSingle || inDouble || path.length === 0) return null;
	// These operands depend on shell directory-stack state rather than naming a
	// literal directory, even when their spelling was quoted.
	if (path === "-" || /^[+-]\d+$/.test(path)) return null;
	// Only the current user's home is resolved outside the shell. A named-user
	// (or other special) tilde prefix needs the shell's own expansion rules.
	if (hasUnquotedLeadingTilde && path !== "~" && !path.startsWith("~/")) return null;
	// Skip inter-token whitespace, then require a top-level `&&` or `;` (a single
	// `&`, `||`, `|`, a `case` terminator `;;`/`;&`, or a redirect all mean this
	// is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	let separator: "&&" | ";";
	if (command[i] === "&" && command[i + 1] === "&") {
		separator = "&&";
	} else if (command[i] === ";" && command[i + 1] !== ";" && command[i + 1] !== "&") {
		separator = ";";
	} else {
		return null;
	}
	i += separator.length;
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i), separator };
}

/**
 * Reads one shell-style word from the start of `text`: quoted and unquoted
 * runs concatenate as a shell would (`a"b c"d` → `ab cd`), quoting/escaping
 * follows the same rules as {@link tokenizeShellSegments} (no escapes inside
 * single quotes; `\"`, `\\`, `\$`, `` \` `` inside double quotes; backslash
 * escapes the next character when unquoted), and the word ends at the first
 * unquoted whitespace character (space, tab, `\n`, or `\r`) or the end of
 * the string.
 *
 * Shared so callers reading one quoted flag value (`/loop --until "…"`) do not
 * each maintain their own `indexOf`-based quote scanner, which breaks on an
 * escaped instance of the closing delimiter.
 *
 * Returns `undefined` when `text` is empty or all leading whitespace, and
 * `"unterminated"` for an unclosed quote.
 */
export function readShellWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
	let i = 0;
	while (i < text.length && /[ \t\n\r]/.test(text[i])) i++;
	if (i >= text.length) return undefined;

	let value = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			value += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			value += text[i + 1];
			i++;
			continue;
		}
		if (/[ \t\n\r]/.test(ch)) break;
		value += ch;
	}
	if (inSingle || inDouble) return "unterminated";
	return { value, rest: text.slice(i).trim() };
}
