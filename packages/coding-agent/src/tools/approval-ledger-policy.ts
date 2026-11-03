import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/web";
import { embeddedCedarWasmPath } from "./approval-ledger-assets";

const POLICIES = Object.freeze({
	"native-exact-grant-v1": `permit(principal, action == Action::"release-native-prompt", resource)
when {
	principal == context.grantee && resource == context.scope &&
	context.consentVerified && context.nativePending && context.resourceCurrent &&
	context.baselinePermitted && context.tenant == "work" && context.grantMode == context.mode &&
	context.delegable == false && context.uses == 1 && context.now < context.expiresAt &&
	(context.evidenceKind == "phone-signed" ||
	 (context.evidenceKind == "coordinator-attested-legacy" && context.legacyImportEnabled))
};`,
	"native-existing-boundary-v1": `forbid(principal, action, resource)
when { !context.nativePending || !context.resourceCurrent || !context.baselinePermitted };`,
});

/** Only the pinned helper's independently verified exact-request result supplies this grant. */
export interface VerifiedNativeGrant {
	readonly subject: { readonly type: "NativeSession"; readonly id: string };
	readonly scope: string;
	readonly delegable: false;
	readonly tenant: "work";
	readonly expiresAt: number;
	readonly uses: 1;
	readonly mode: "shadow" | "enforce";
}

export interface NativePolicyInput {
	readonly sessionId: string;
	readonly requestHash: string;
	readonly toolName: string;
	readonly mode: "shadow" | "enforce";
	readonly nativePending: boolean;
	readonly resourceCurrent: boolean;
	readonly baselinePermitted: boolean;
	readonly legacyImportEnabled: boolean;
	readonly evidenceKind: string;
	readonly grant?: VerifiedNativeGrant;
}

let runtime: Promise<typeof import("@cedar-policy/cedar-wasm/web")> | undefined;

async function cedarRuntime(): Promise<typeof import("@cedar-policy/cedar-wasm/web")> {
	runtime ??= (async () => {
		const cedar = await import("@cedar-policy/cedar-wasm/web");
		const wasmPath =
			embeddedCedarWasmPath ?? new URL("./cedar_wasm_bg.wasm", import.meta.resolve("@cedar-policy/cedar-wasm/web"));
		cedar.initSync({ module: await Bun.file(wasmPath).arrayBuffer() });
		if (cedar.getCedarVersion() !== "4.14.0") throw new Error("Unexpected Cedar policy runtime version");
		return cedar;
	})();
	return runtime;
}

/** Cedar authorizes admission, never execution or a successful effect. Existing native denials remain outside this seam. */
export async function evaluateNativeGrant(input: NativePolicyInput) {
	const grant = input.grant;
	const request = {
		subject: { type: "NativeSession", id: input.sessionId },
		action: { name: "release-native-prompt", tool: input.toolName },
		resource: { type: "NativePermission", id: input.requestHash },
		context: {
			nativeRequestHash: input.requestHash,
			grantee: { __entity: { type: "NativeSession", id: grant?.subject.id ?? "missing-grant" } },
			scope: { __entity: { type: "NativePermission", id: grant?.scope ?? "missing-grant" } },
			consentVerified: grant !== undefined,
			nativePending: input.nativePending,
			resourceCurrent: input.resourceCurrent,
			baselinePermitted: input.baselinePermitted,
			legacyImportEnabled: input.legacyImportEnabled,
			evidenceKind: input.evidenceKind,
			tenant: grant?.tenant ?? "unknown",
			mode: input.mode,
			grantMode: grant?.mode ?? "missing",
			delegable: grant?.delegable ?? true,
			uses: grant?.uses ?? 0,
			expiresAt: grant?.expiresAt ?? 0,
			now: Date.now(),
		},
	};
	const call: AuthorizationCall = {
		principal: request.subject,
		action: { type: "Action", id: request.action.name },
		resource: request.resource,
		context: request.context,
		entities: [],
		policies: { staticPolicies: POLICIES },
	};
	const answer = (await cedarRuntime()).isAuthorized(call);
	const success = answer.type === "success";
	const diagnostics = success ? answer.response.diagnostics : undefined;
	const decision =
		success && diagnostics?.errors.length === 0 && answer.response.decision === "allow" ? "allow" : "deny";
	return {
		schema: "firstmate.approval-evaluation.v1" as const,
		mode: input.mode,
		request,
		decision,
		reasons: [
			!success || diagnostics?.errors.length
				? "cedar-evaluation-error"
				: decision === "allow"
					? "exact-grant-permitted"
					: "no-applicable-grant",
		],
		policy_ids: diagnostics?.reason ?? [],
	};
}
