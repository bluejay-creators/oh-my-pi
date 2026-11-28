import * as path from "node:path";

/** Unwraps literal env syntax, not authorization; callers must prove both executables and the payload. */
export function unwrapOrdinaryApprovalEnv(
	argv: readonly string[],
	unknown: readonly number[] = [],
): { argv: readonly string[]; unknown: readonly number[]; assignments: readonly string[] } | undefined {
	if (!argv[0] || path.basename(argv[0]) !== "env") return undefined;

	let payloadIndex = 1;
	for (; payloadIndex < argv.length; payloadIndex++) {
		const word = argv[payloadIndex]!;
		if (!word || word.startsWith("-")) return undefined;
		const equals = word.indexOf("=");
		if (equals === -1) break;
		const name = word.slice(0, equals);
		// Only presentation/locale metadata is inert enough to ignore during approval.
		if (
			!/^(?:NO_COLOR|FORCE_COLOR|CLICOLOR[A-Za-z0-9_]*|TERM|COLUMNS|LINES|CI|LANG|LC_[A-Za-z0-9_]*|TZ|BLUEJAY_PUSH_APPROVED)$/u.test(name) &&
			word !== "GIT_TERMINAL_PROMPT=0"
		) return undefined;
	}

	// An unknown executable cannot establish where env's assignment list ends.
	if (payloadIndex === argv.length || unknown.some(index => index <= payloadIndex)) return undefined;
	return {
		argv: argv.slice(payloadIndex),
		unknown: unknown.map(index => index - payloadIndex),
		assignments: argv.slice(1, payloadIndex),
	};
}
