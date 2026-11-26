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

	const startToken = (index: number) => {
		if (tokenStart < 0) tokenStart = index;
	};
	const pushToken = (end: number) => {
		if (tokenStart < 0) return;
		argv.push(token);
		rawTokens.push(command.slice(tokenStart, end));
		token = "";
		tokenStart = -1;
	};
	const pushSegment = (end: number): boolean => {
		pushToken(end);
		if (argv.length === 0) return false;
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
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName)
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
		if (ch === "&" && command[i + 1] === "&") {
			if (!pushSegment(i)) return null;
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

	if (quote || !pushSegment(command.length) || segments.length < 2) return null;
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

// Parameter expansion can change these commands' safety surface even when the
// command name is literal. Never infer an allow for their expanded arguments.
const APPROVAL_EXPANSION_SENSITIVE_COMMANDS: Record<string, true> = {
	rm: true,
	mv: true,
	cp: true,
	chmod: true,
	chown: true,
	dd: true,
	find: true,
	curl: true,
	wget: true,
	ssh: true,
	scp: true,
	eval: true,
	exec: true,
	sudo: true,
	sh: true,
	bash: true,
	dash: true,
	ash: true,
	ksh: true,
	zsh: true,
	env: true,
	python: true,
	node: true,
	bun: true,
	perl: true,
	ruby: true,
	awk: true,
	gawk: true,
	mawk: true,
	nawk: true,
	sed: true,
	gsed: true,
	xargs: true,
	rsync: true,
	make: true,
	psql: true,
	sqlite: true,
	mysql: true,
	osascript: true,
	lua: true,
	luajit: true,
	julia: true,
	deno: true,
	pypy: true,
};

function parseApprovalShellSegment(text: string): LiteralShellCommandSegment | null {
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
			// Only simple double-quoted argument expansions preserve argv boundaries.
			const variable = quote === '"' ? /^\$[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(i)) : null;
			if (!variable) return null;
			literalText += "expanded-argument";
			expanded = true;
			i += variable[0].length - 1;
			continue;
		}
		if (!quote && (i === 0 || /[ \t]/u.test(text[i - 1]!))) {
			// Discard only descriptor swaps and /dev/null output, never file writes.
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
	let commandIndex = 0;
	while (commandIndex < argv.length && isShellEnvironmentAssignment(argv[commandIndex]!)) commandIndex++;
	const executable = argv[commandIndex]?.split("/").pop()?.toLowerCase().replace(/(?:[-.]?\d[\d.]*)?(?:\.exe)?$/u, "");
	if (!executable) return null;
	if (
		expanded &&
		(argv[commandIndex]!.includes("expanded-argument") ||
			Object.hasOwn(APPROVAL_EXPANSION_SENSITIVE_COMMANDS, executable) ||
			(executable === "git" && argv.some(word => /^(?:push|reset|clean|checkout|restore|-c|--config(?:=|$))/u.test(word))))
	) return null;
	// printf -v and %n write shell variables; an expanded format could hide %n.
	const printf =
		/^printf[ \t]/u.test(literalText) &&
		!argv.some(word => word.startsWith("-v") || word.includes("%n")) &&
		!argv[1]?.includes("expanded-argument");
	const literal = parseLiteralShellCommandSegment(printf ? literalText.replace(/^printf/u, "echo") : literalText);
	if (!literal) return null;
	if (printf) literal.argv[0] = "printf";
	literal.argv = tokenizeShellSegments(text)[0] ?? literal.argv;
	return literal;
}

/** An approval unit; opaque units retain their complete source, including heredoc bodies. */
export interface ApprovalShellSegment {
	text: string;
	literal: LiteralShellCommandSegment | null;
}

/**
 * Split shell lists, pipelines, subshells and simple loops without treating data as commands.
 * Unsupported grammar, substitutions and incomplete syntax decline segmentation. Stateful
 * commands and heredocs remain opaque: restrictions can inspect them, but allows cannot.
 */
export function extractApprovalShellSegments(command: string): ApprovalShellSegment[] | null {
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
			const match = /^<<(-)?[ \t]*(?:'([^'\n]+)'|"([^"$`\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))(?=[ \t\n;&|)]|$)/u.exec(
				command.slice(i),
			);
			if (!match) return null;
			pending.push({ delimiter: match[2] ?? match[3] ?? match[4]!, stripTabs: !!match[1], owner: pieces.length });
			i += match[0].length - 1;
			continue;
		}
		// Process substitution and arithmetic/group syntax outside the supported subshell grammar.
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") return null;
		if (ch === "{" || ch === "}" || ch === "\r") return null;
		const redirect =
			(ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) ||
			(ch === "|" && command[i - 1] === ">");
		if (!redirect && /[\n;&|()]/u.test(ch)) {
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
			const variable = forLoop[1]!;
			// Shell-special variables can retarget executable lookup or alter later parsing.
			if (["path", "fpath", "commands", "functions", "builtins"].includes(variable)) return null;
			const values = parseLiteralShellCommandSegment(`echo ${forLoop[2]}`);
			if (!values || heredocs.has(index)) return null;
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
		const literal = heredocs.has(index) ? null : parseApprovalShellSegment(text);
		segments.push({ text, literal });
		expectCommand = false;
		needsCommand = false;
	}
	if (stack.length > 0 || needsCommand || segments.length === 0) return null;
	return structured || segments.length > 1 || heredocs.size > 0 ? segments : null;
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
