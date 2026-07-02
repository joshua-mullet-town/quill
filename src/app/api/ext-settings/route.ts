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
// Namespaces are now BUSINESS-AGNOSTIC (no "cv" prefix) — the businessId already
// scopes them under businesses/{businessId}/, so hardcoding "cv" into the shared
// collection names was contradictory for a multi-tenant design.
const SHAPES: Record<string, Shape> = {
	ignoreList: "map",
	dimStore: "map",
	billingMemory: "map",
	history: "array",
	modeToggles: "singleton",
	brandingDefaults: "singleton",
};

// The previous (cv-prefixed) collection/doc name for each clean namespace. The
// load-time migration imports from this older collection into the clean one, then
// retires the cv-named source — so existing data carries over on the rename and
// can't resurrect after a later clear (same source-delete discipline that killed
// the earlier resurrection bug).
const LEGACY_CV_NAME: Record<string, string> = {
	ignoreList: "cvIgnoreList",
	dimStore: "cvDimStore",
	billingMemory: "cvBillingMemory",
	history: "cvHistory",
	modeToggles: "cvModeToggles",
	brandingDefaults: "cvBrandingDefaults",
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
// The previous (cv-prefixed) COLLECTION for a namespace — the intermediate storage
// shape (proper collections, but under the old cv-name). null if this namespace
// never had a cv-name (defensive; every current namespace does).
function legacyCvCollectionRef(businessId: string, namespace: string) {
	const cv = LEGACY_CV_NAME[namespace];
	return cv ? businessRef(businessId).collection(cv) : null;
}
function legacyCvSingletonRef(businessId: string, namespace: string) {
	const cv = LEGACY_CV_NAME[namespace];
	return cv ? businessRef(businessId).collection("appConfig").doc(cv) : null;
}

// Read an entry-doc collection into a { [key]: value } map (or [] for arrays).
function docsToMap(docs: FirebaseFirestore.QueryDocumentSnapshot[]) {
	const out: Record<string, unknown> = {};
	for (const d of docs) {
		const data = d.data();
		const k = typeof data.key === "string" ? data.key : d.id;
		out[k] = data.value;
	}
	return out;
}

// ---- load -------------------------------------------------------------------
//
// MIGRATION PRECEDENCE (newest source wins): the clean collection is authoritative.
// If it's empty, import from the next-newest source that has data and RETIRE that
// source (so a later clear can't resurrect from it — the discipline that killed the
// original resurrection bug, now applied on BOTH legacy hops):
//   clean collection  →  cv-named collection (item-6 shape)  →  appSettings blob (oldest)
// Whichever source is imported, all OLDER sources are also retired, so nothing
// stale lingers to clobber or resurrect.

// Retire the legacy singleton sources (cv-named appConfig doc + appSettings blob).
async function retireLegacySingleton(businessId: string, namespace: string) {
	const cvRef = legacyCvSingletonRef(businessId, namespace);
	if (cvRef) {
		const cvSnap = await cvRef.get();
		if (cvSnap.exists) await cvRef.delete();
	}
	const blobSnap = await legacyBlobRef(businessId, namespace).get();
	if (blobSnap.exists) await legacyBlobRef(businessId, namespace).delete();
}

async function loadSingleton(businessId: string, namespace: string) {
	const snap = await singletonRef(businessId, namespace).get();
	if (snap.exists) {
		// Authoritative — but still retire leftover legacy sources so none linger.
		await retireLegacySingleton(businessId, namespace);
		return snap.data()?.value ?? null;
	}

	// Next: the cv-named singleton doc (appConfig/cvModeToggles), then the blob.
	const cvRef = legacyCvSingletonRef(businessId, namespace);
	const cvSnap = cvRef ? await cvRef.get() : null;
	const blobSnap = await legacyBlobRef(businessId, namespace).get();

	let value: unknown = null;
	if (cvSnap?.exists) value = cvSnap.data()?.value ?? null;
	else if (blobSnap.exists) value = blobSnap.data()?.value ?? null;

	if (value !== null) await writeSingleton(businessId, namespace, value);
	await retireLegacySingleton(businessId, namespace);
	return value;
}

// Retire the legacy sources (cv-named collection + appSettings blob) for a
// namespace. Called on EVERY load — unconditionally — so old cv-named collections
// don't linger visibly in Firestore once the clean collection is authoritative.
// (The earlier version only retired them in the import branch, so a cv-collection
// stuck around forever if the clean collection already had data or the namespace
// was never re-loaded.) Idempotent: a no-op once the sources are gone.
async function retireLegacySources(businessId: string, namespace: string) {
	await retireCollection(legacyCvCollectionRef(businessId, namespace));
	const blob = await legacyBlobRef(businessId, namespace).get();
	if (blob.exists) await legacyBlobRef(businessId, namespace).delete();
}

async function loadMap(businessId: string, namespace: string) {
	const col = await collectionRef(businessId, namespace).get();
	if (!col.empty) {
		// Clean collection is authoritative — but still retire any leftover legacy
		// sources so they don't linger in Firestore (they can't resurrect anyway,
		// since we early-return on the clean data, but Josh should not SEE stale
		// cv-named collections sitting around).
		await retireLegacySources(businessId, namespace);
		return docsToMap(col.docs);
	}

	// Empty clean collection → migrate from the newest legacy source with data.
	const cvCol = legacyCvCollectionRef(businessId, namespace);
	const cvSnap = cvCol ? await cvCol.get() : null;
	const blob = await legacyBlobRef(businessId, namespace).get();
	const blobVal = blob.exists ? blob.data()?.value : null;

	let imported: Record<string, unknown> | null = null;
	if (cvSnap && !cvSnap.empty) {
		imported = docsToMap(cvSnap.docs); // cv-collection is newer than the blob
	} else if (blobVal && typeof blobVal === "object" && !Array.isArray(blobVal)) {
		imported = blobVal as Record<string, unknown>;
	}
	if (imported) await writeMap(businessId, namespace, imported);

	// Retire ALL older sources so a later clear can't re-import from either.
	await retireLegacySources(businessId, namespace);
	return imported ?? {};
}

async function loadArray(businessId: string, namespace: string) {
	const col = await collectionRef(businessId, namespace).get();
	if (!col.empty) {
		await retireLegacySources(businessId, namespace);
		return col.docs.map((d) => d.data().value).filter((v) => v != null);
	}

	const cvCol = legacyCvCollectionRef(businessId, namespace);
	const cvSnap = cvCol ? await cvCol.get() : null;
	const blob = await legacyBlobRef(businessId, namespace).get();
	const blobVal = blob.exists ? blob.data()?.value : null;

	let imported: unknown[] | null = null;
	if (cvSnap && !cvSnap.empty) {
		imported = cvSnap.docs.map((d) => d.data().value).filter((v) => v != null);
	} else if (Array.isArray(blobVal)) {
		imported = blobVal;
	}
	if (imported) await writeArray(businessId, namespace, imported);

	await retireLegacySources(businessId, namespace);
	return imported ?? [];
}

// ---- save (reconcile: write present entries, delete absent) -----------------
//
// A reconcile can involve arbitrarily many writes (one set per entry + one delete
// per removed entry). Firestore caps a single batch at 500 operations, so we
// collect every op and commit them in ≤500-op chunks. Without this, a large
// collection (many customers / SKUs) would exceed 500 and the save would throw —
// re-introducing a scale ceiling, which is the exact thing this refactor removes.

type Op =
	| { type: "set"; ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData }
	| { type: "delete"; ref: FirebaseFirestore.DocumentReference };

const MAX_BATCH_OPS = 450; // under Firestore's 500 ceiling, with headroom

async function commitOps(ops: Op[]) {
	for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
		const batch = db.batch();
		for (const op of ops.slice(i, i + MAX_BATCH_OPS)) {
			if (op.type === "set") batch.set(op.ref, op.data);
			else batch.delete(op.ref);
		}
		await batch.commit();
	}
}

// Delete every doc in a legacy collection (used to RETIRE a cv-named collection
// after its data is imported into the clean one). Chunked at ≤450 deletes so a
// large legacy collection doesn't exceed Firestore's batch cap. No-op on null.
async function retireCollection(
	col: FirebaseFirestore.CollectionReference | null,
) {
	if (!col) return;
	const snap = await col.get();
	if (snap.empty) return;
	await commitOps(snap.docs.map((d) => ({ type: "delete" as const, ref: d.ref })));
}

async function writeMap(
	businessId: string,
	namespace: string,
	map: Record<string, unknown>,
) {
	const col = collectionRef(businessId, namespace);
	const existing = await col.get();
	const wantIds = new Set(Object.keys(map).map(encodeId));
	const ops: Op[] = [];
	// Upsert present entries.
	for (const [key, value] of Object.entries(map)) {
		ops.push({ type: "set", ref: col.doc(encodeId(key)), data: { key, value, updatedAt: Date.now() } });
	}
	// Delete entries no longer present.
	for (const d of existing.docs) {
		if (!wantIds.has(d.id)) ops.push({ type: "delete", ref: d.ref });
	}
	await commitOps(ops);
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
	const ops: Op[] = [];
	for (const rec of items) {
		ops.push({ type: "set", ref: col.doc(encodeId(rec.id)), data: { key: rec.id, value: rec, updatedAt: Date.now() } });
	}
	for (const d of existing.docs) {
		if (!wantIds.has(d.id)) ops.push({ type: "delete", ref: d.ref });
	}
	await commitOps(ops);
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
