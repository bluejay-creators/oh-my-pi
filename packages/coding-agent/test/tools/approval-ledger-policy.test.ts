import { expect, test } from "bun:test";
import {
	evaluateNativeGrant,
	type NativePolicyInput,
	type VerifiedNativeGrant,
} from "../../src/tools/approval-ledger-policy";

function request(): NativePolicyInput & { grant: VerifiedNativeGrant } {
	const grant: VerifiedNativeGrant = {
		subject: { type: "NativeSession", id: "actual-native-owner" },
		scope: "a".repeat(64),
		mode: "enforce",
		tenant: "work",
		delegable: false,
		expiresAt: Date.now() + 60_000,
		uses: 1,
	};
	return {
		sessionId: grant.subject.id,
		requestHash: grant.scope,
		toolName: "bash",
		mode: "enforce",
		nativePending: true,
		resourceCurrent: true,
		baselinePermitted: true,
		legacyImportEnabled: false,
		evidenceKind: "phone-signed",
		grant,
	};
}

test("a verified grant permits only its exact native principal and request", async () => {
	const input = request();
	expect((await evaluateNativeGrant(input)).decision).toBe("allow");
	expect((await evaluateNativeGrant({ ...input, sessionId: "another-native-owner" })).decision).toBe("deny");
	expect((await evaluateNativeGrant({ ...input, requestHash: "b".repeat(64) })).decision).toBe("deny");
});

test("consent cannot override a closed owner, changed resource, or existing native denial", async () => {
	const input = request();
	for (const boundary of ["nativePending", "resourceCurrent", "baselinePermitted"] as const) {
		expect((await evaluateNativeGrant({ ...input, [boundary]: false })).decision).toBe("deny");
	}
});

test("missing, expired, and shadow-only consent cannot become a live permission", async () => {
	const input = request();
	expect((await evaluateNativeGrant({ ...input, grant: undefined })).decision).toBe("deny");
	expect(
		(await evaluateNativeGrant({ ...input, grant: { ...input.grant, expiresAt: Date.now() - 1 } })).decision,
	).toBe("deny");
	expect((await evaluateNativeGrant({ ...input, grant: { ...input.grant, mode: "shadow" } })).decision).toBe("deny");
});

test("coordinator-attested legacy evidence needs its separate explicit delegation", async () => {
	const input = { ...request(), evidenceKind: "coordinator-attested-legacy" };
	expect((await evaluateNativeGrant(input)).decision).toBe("deny");
	expect((await evaluateNativeGrant({ ...input, legacyImportEnabled: true })).decision).toBe("allow");
});
