import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { isAuthorizedEnqueue } from "@/lib/enqueue-auth";

export const runtime = "nodejs";

// Durable settings store for the QuickBooks shipping extension. The extension
// keeps per-user settings (ignored line items, saved box dimensions, shipment
// history, mode toggles, and per-customer billing memory) that must survive a
// reinstall and follow the account across machines. They live here, in Quill's
// Firestore, deliberately isolated from Crowne Vault's own B2B database.
//
// MULTI-TENANT: everything is scoped by `businessId`. Crowne Vault is the first
// business; another drops in under its own id with no code change.
//
// ─────────────────────────────────────────────────────────────────────────────
// STORAGE MODEL — proper Firestore collections (not a value-blob per namespace).
//
// The extension works with each setting as a whole map/array in memory, but we
// store it IDIOMATICALLY: one document per entry in a collection, not one giant
// document holding the whole thing. That means partial updates, real queries, and
// no per-namespace 1MB doc ceiling.
//
//   MAP namespaces  { [key]: itemValue }  → businesses/{bid}/{namespace}/{key}
//     cvIgnoreList, cvDimStore, cvBillingMemory
//     load  = read the collection, rebuild the { [key]: value } map
//     save  = reconcile: set each present key's doc, delete keys no longer present
//
//   ARRAY namespace  [ {id, ...}, ... ]   → businesses/{bid}/{namespace}/{id}
//     cvHistory (each record has an `id`)
//     load  = read the collection → array; save = reconcile by id
//
//   SINGLETON namespaces  { ...config }   → businesses/{bid}/appConfig/{namespace}
//     cvModeToggles, cvBrandingDefaults — a lone config object; ONE doc is the
//     correct idiomatic shape for a singleton (it isn't a keyed collection).
//
// LAZY MIGRATION: earlier data was stored as businesses/{bid}/appSettings/{ns} →
// {value}. On the first load of a MAP/ARRAY namespace whose new collection is
// still empty, if that old blob doc exists we import it into the collection once
// (and leave the old doc as-is; a save fully switches to the collection). So no
// existing settings are lost at cutover, with no manual migration step.
//
// AUTH: server-to-server only (same bearer as buy-and-print). The extension
// reaches this through the tokenless Crowne Vault proxy.
//
// CONTRACT (unchanged from the caller's view — still op/namespace/value):
//   POST /api/ext-settings  Authorization: Bearer <QUILL_ENQUEUE_TOKEN>
//   load: { op:"load", businessId, namespace } → { ok:true, value:<map|array|obj|null> }
//   save: { op:"save", businessId, namespace, value } → { ok:true }
//   400 bad op/businessId/namespace; 401 bad token; 500 on a store error.

interface SettingsRequest {
	op?: "load" | "save";
	businessId?: string;
	namespace?: string;
	value?: unknown;
}

// How each namespace maps to Firestore.
//   "map"       → collection keyed by the map's own keys
//   "array"     → collection keyed by each element's `id`
//   "singleton" → a single config doc under appConfig
type Shape = "map" | "array" | "singleton";
const SHAPES: Record<string, Shape> = {
	cvIgnoreList: "map",
	cvDimStore: "map",
	cvBillingMemory: "map",
	cvHistory: "array",
	cvModeToggles: "singleton",
	cvBrandingDefaults: "singleton",
};

// Firestore doc-id safety: segments become path parts. Reject slashes/empty.
// (Firestore also dislikes ids that are "." / ".." or contain "__" prefixes; we
// sanitize entry keys below, but namespaces/businessIds are internal + validated.)
function isValidSegment(s: unknown): s is string {
	return typeof s === "string" && s.length > 0 && !s.includes("/");
}

// Entry keys come from user-ish data (SKU strings, customer names, ignore keys).
// Firestore doc ids can't contain "/" and can't be "." or "..". Encode to keep a
// stable, reversible id. We store the ORIGINAL key in the doc too so load rebuilds
// the map with the real key regardless of id encoding.
function encodeId(key: string): string {
	return encodeURIComponent(key).replace(/\./g, "%2E") || "_empty_";
}

function businessRef(businessId: string) {
	return db.collection("businesses").doc(businessId);
}
function collectionRef(businessId: string, namespace: string) {
	return businessRef(businessId).collection(namespace);
}
function singletonRef(businessId: string, namespace: string) {
	return businessRef(businessId).collection("appConfig").doc(namespace);
}
function legacyBlobRef(businessId: string, namespace: string) {
	return businessRef(businessId).collection("appSettings").doc(namespace);
}

// ---- load -------------------------------------------------------------------

async function loadSingleton(businessId: string, namespace: string) {
	const snap = await singletonRef(businessId, namespace).get();
	if (snap.exists) return snap.data()?.value ?? null;
	// Migration fallback: old blob doc.
	const legacy = await legacyBlobRef(businessId, namespace).get();
	return legacy.exists ? (legacy.data()?.value ?? null) : null;
}

async function loadMap(businessId: string, namespace: string) {
	const col = await collectionRef(businessId, namespace).get();
	if (!col.empty) {
		const out: Record<string, unknown> = {};
		for (const d of col.docs) {
			const data = d.data();
			// Each entry doc carries { key, value }. Fall back to the doc id if an
			// older entry lacks the stored key.
			const k = typeof data.key === "string" ? data.key : d.id;
			out[k] = data.value;
		}
		return out;
	}
	// Empty collection → one-time import from the legacy blob if present. We DELETE
	// the legacy blob right after importing so "empty collection" reliably means
	// "empty," not "not-yet-migrated." Without this, a user who legitimately CLEARS
	// a setting (empties the collection) would have the stale blob re-imported on
	// the next load — silent data resurrection. Delete = migrate exactly once.
	const legacy = await legacyBlobRef(businessId, namespace).get();
	const blob = legacy.exists ? legacy.data()?.value : null;
	if (blob && typeof blob === "object" && !Array.isArray(blob)) {
		await writeMap(businessId, namespace, blob as Record<string, unknown>);
		await legacyBlobRef(businessId, namespace).delete();
		return blob;
	}
	// Nothing in the collection and no importable blob — but still retire any
	// legacy doc so it can't resurrect later (e.g. a blob that wasn't a plain map).
	if (legacy.exists) await legacyBlobRef(businessId, namespace).delete();
	return {};
}

async function loadArray(businessId: string, namespace: string) {
	const col = await collectionRef(businessId, namespace).get();
	if (!col.empty) {
		return col.docs.map((d) => d.data().value).filter((v) => v != null);
	}
	// Same one-time-and-retire migration as loadMap (see there for why the delete
	// is required — it prevents cleared-history from resurrecting on next load).
	const legacy = await legacyBlobRef(businessId, namespace).get();
	const blob = legacy.exists ? legacy.data()?.value : null;
	if (Array.isArray(blob)) {
		await writeArray(businessId, namespace, blob);
		await legacyBlobRef(businessId, namespace).delete();
		return blob;
	}
	if (legacy.exists) await legacyBlobRef(businessId, namespace).delete();
	return [];
}

// ---- save (reconcile: write present entries, delete absent) -----------------

async function writeMap(
	businessId: string,
	namespace: string,
	map: Record<string, unknown>,
) {
	const col = collectionRef(businessId, namespace);
	const existing = await col.get();
	const wantIds = new Set(Object.keys(map).map(encodeId));
	const batch = db.batch();
	// Upsert present entries.
	for (const [key, value] of Object.entries(map)) {
		batch.set(col.doc(encodeId(key)), { key, value, updatedAt: Date.now() });
	}
	// Delete entries no longer present.
	for (const d of existing.docs) {
		if (!wantIds.has(d.id)) batch.delete(d.ref);
	}
	await batch.commit();
}

async function writeArray(
	businessId: string,
	namespace: string,
	arr: unknown[],
) {
	const col = collectionRef(businessId, namespace);
	const existing = await col.get();
	const items = arr.filter(
		(r): r is { id: string } =>
			!!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string",
	);
	const wantIds = new Set(items.map((r) => encodeId(r.id)));
	const batch = db.batch();
	for (const rec of items) {
		batch.set(col.doc(encodeId(rec.id)), { key: rec.id, value: rec, updatedAt: Date.now() });
	}
	for (const d of existing.docs) {
		if (!wantIds.has(d.id)) batch.delete(d.ref);
	}
	await batch.commit();
}

async function writeSingleton(
	businessId: string,
	namespace: string,
	value: unknown,
) {
	await singletonRef(businessId, namespace).set(
		{ value: value ?? null, updatedAt: Date.now() },
		{ merge: false },
	);
}

// ---- route ------------------------------------------------------------------

export async function POST(request: NextRequest) {
	if (!isAuthorizedEnqueue(request)) {
		return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as SettingsRequest;
	const { op, businessId, namespace } = body;

	if (op !== "load" && op !== "save") {
		return NextResponse.json({ ok: false, error: "op must be 'load' or 'save'" }, { status: 400 });
	}
	if (!isValidSegment(businessId)) {
		return NextResponse.json({ ok: false, error: "businessId required (no slashes)" }, { status: 400 });
	}
	if (!isValidSegment(namespace)) {
		return NextResponse.json({ ok: false, error: "namespace required (no slashes)" }, { status: 400 });
	}

	// Unknown namespaces default to singleton (a plain config doc) — safe and
	// forward-compatible if the extension adds a new setting we haven't classified.
	const shape: Shape = SHAPES[namespace] ?? "singleton";

	try {
		if (op === "load") {
			let value: unknown;
			if (shape === "map") value = await loadMap(businessId, namespace);
			else if (shape === "array") value = await loadArray(businessId, namespace);
			else value = await loadSingleton(businessId, namespace);
			return NextResponse.json({ ok: true, value });
		}

		// save
		const v = body.value;
		if (shape === "map") {
			await writeMap(businessId, namespace, (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>);
		} else if (shape === "array") {
			await writeArray(businessId, namespace, Array.isArray(v) ? v : []);
		} else {
			await writeSingleton(businessId, namespace, v);
		}
		return NextResponse.json({ ok: true });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return NextResponse.json({ ok: false, error: `settings ${op} failed: ${msg}` }, { status: 500 });
	}
}
