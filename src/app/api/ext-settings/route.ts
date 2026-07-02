import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { isAuthorizedEnqueue } from "@/lib/enqueue-auth";

export const runtime = "nodejs";

// Durable settings store for the QuickBooks shipping extension. The extension
// keeps per-user settings (ignored line items, saved box dimensions, shipment
// history, mode toggles, and per-customer billing memory) that must survive a
// reinstall and follow the account across machines — chrome.storage.local can't
// do that (it's per-install and wiped on extension-remove). So they live here, in
// Quill's Firestore, deliberately isolated from Crowne Vault's own B2B database.
//
// MULTI-TENANT: everything is scoped by `businessId`. Crowne Vault is the first
// business; another business drops in later under its own id with no code change:
//   businesses/{businessId}/appSettings/{namespace} → { value, updatedAt }
// `namespace` is the per-store key the extension uses (e.g. "cvIgnoreList",
// "cvDimStore", "cvModeToggles", "cvHistory", "cvBillingMemory").
//
// AUTH: server-to-server only, same bearer token as /api/buy-and-print
// (QUILL_ENQUEUE_TOKEN). The extension never calls this directly — it can't hold
// the token — it goes through the tokenless Crowne Vault proxy, which forwards
// here with the token. So no CORS here (this is not a browser-facing route).
//
// CONTRACT:
//   POST /api/ext-settings
//   Authorization: Bearer <QUILL_ENQUEUE_TOKEN>
//   Body (load): { op: "load", businessId, namespace }
//     200 → { ok: true, value: <stored value | null> }
//   Body (save): { op: "save", businessId, namespace, value }
//     200 → { ok: true }
//   400 on a bad/missing op, businessId, or namespace. 401 on a bad token.
//
// `value` is stored verbatim (an object/array/scalar) under a wrapper doc so we
// can carry `updatedAt` alongside it. A load of a never-written namespace returns
// value:null (a legitimate empty, NOT an error) — the extension treats null as
// "nothing stored yet" and keeps whatever it has locally.

interface SettingsRequest {
	op?: "load" | "save";
	businessId?: string;
	namespace?: string;
	value?: unknown;
}

// Firestore doc-id safety: businessId/namespace become path segments, so reject
// anything with a slash or the empty string. Keep it strict — these are internal
// keys the extension controls, not free user input.
function isValidSegment(s: unknown): s is string {
	return typeof s === "string" && s.length > 0 && !s.includes("/");
}

function settingsDoc(businessId: string, namespace: string) {
	return db
		.collection("businesses")
		.doc(businessId)
		.collection("appSettings")
		.doc(namespace);
}

export async function POST(request: NextRequest) {
	if (!isAuthorizedEnqueue(request)) {
		return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as SettingsRequest;
	const { op, businessId, namespace } = body;

	if (op !== "load" && op !== "save") {
		return NextResponse.json(
			{ ok: false, error: "op must be 'load' or 'save'" },
			{ status: 400 },
		);
	}
	if (!isValidSegment(businessId)) {
		return NextResponse.json(
			{ ok: false, error: "businessId required (no slashes)" },
			{ status: 400 },
		);
	}
	if (!isValidSegment(namespace)) {
		return NextResponse.json(
			{ ok: false, error: "namespace required (no slashes)" },
			{ status: 400 },
		);
	}

	const ref = settingsDoc(businessId, namespace);

	try {
		if (op === "load") {
			const snap = await ref.get();
			// Never-written namespace → value:null (a legitimate empty, not a failure).
			const value = snap.exists ? (snap.data()?.value ?? null) : null;
			return NextResponse.json({ ok: true, value });
		}

		// op === "save": store the value verbatim under a wrapper with a timestamp.
		await ref.set(
			{ value: body.value ?? null, updatedAt: Date.now() },
			{ merge: false },
		);
		return NextResponse.json({ ok: true });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return NextResponse.json(
			{ ok: false, error: `settings ${op} failed: ${msg}` },
			{ status: 500 },
		);
	}
}
