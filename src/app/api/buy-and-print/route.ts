import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { revalidatePath } from "next/cache";
import { isAuthorizedEnqueue } from "@/lib/enqueue-auth";
import { buyFedExZplLabel, type Shipment } from "@/lib/fedex-label";
import { buyUpsZplLabel, UPS_SERVICE_CODES } from "@/lib/ups-label";
import { renderZplPreview } from "@/lib/zpl-preview";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";

// Quill carrier-backend path: buy a REAL SANDBOX label in ZPL format for FedEx
// OR UPS, branched by serviceType. Both carriers' sandbox labels are watermarked
// (FedEx "TEST LABEL - DO NOT SHIP", UPS "SAMPLE") — free, non-billing.
//
// CARRIER branch (by serviceType): UPS numeric service codes (01/02/03/12/13/59)
// → UPS (OAuth Basic → /api/shipments/v2409/ship, ZPL label). Everything else
// (FEDEX_*) → FedEx (OAuth form → /ship/v1/shipments, ZPLII label). Both yield
// raw ZPL the Zebra prints, and the SAME Labelary path renders the preview.
//
// Two modes, set by body.mode (default "dispatch"):
//   "dispatch" — buy + enqueue the ZPL for a target agent/printer (the print
//                path). Requires fingerprint + a printer the agent reported.
//   "display"  — buy + render a preview ONLY; NOTHING is enqueued, nothing goes
//                to any printer. For the extension's "just show the label" mode.
//                fingerprint/printer are optional (no agent is touched).
//
// CONTRACT:
//   POST /api/buy-and-print
//   Authorization: Bearer <QUILL_ENQUEUE_TOKEN>
//   Body: {
//     mode?: "dispatch" | "display",  // default "dispatch"
//     fingerprint?: string,   // required in dispatch mode; ignored in display
//     printer?: string,       // required in dispatch mode; must be reported by the agent
//     serviceType?: string,   // default "FEDEX_GROUND"; UPS codes 01/02/03/12/13/59 → UPS
//     shipTo?: { name, street, city, state, zip, country, residential, phone },
//     packages?: [{ length, width, depth, weight }]
//   }
//   200 (dispatch) → { ok, mode:"dispatch", carrier, dispatched:true, jobId, printer,
//                      queuedAt, trackingNumber, docType, previewOk, previewImage }
//   200 (display)  → { ok, mode:"display", carrier, dispatched:false, jobId:null,
//                      printer:null, queuedAt:null, trackingNumber, docType,
//                      previewOk, previewImage }
//   Errors mirror /enqueue (401/404/400) plus 502 on carrier failure, 500 if creds unset.
//
// Credentials come from env (FEDEX_SANDBOX_*) — never in the request, never logged.
//
// PREVIEW: the 200 carries previewImage — a data:image/png render of the EXACT
// ZPL bought (rendered server-side via Labelary, from the SAME single buy, no
// double-buy). The extension shows that image; it never handles ZPL. The preview
// DEGRADES CLEANLY: if Labelary is down, previewOk is false and previewImage is
// null — in dispatch mode the job was already enqueued so the print still fired.

const DEFAULT_SHIP_TO = {
	name: "Quill Print Proof",
	street: "456 Oak Ave",
	city: "Chicago",
	state: "IL",
	zip: "60601",
	country: "US",
	residential: false,
};
const DEFAULT_PACKAGES = [
	{ length: "12", width: "10", depth: "8", weight: "10.5" },
];

function todayStamp(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

export async function POST(request: NextRequest) {
	if (!isAuthorizedEnqueue(request)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const body = await request.json().catch(() => ({}));
	const mode = body.mode === "display" ? "display" : "dispatch";
	const dispatch = mode === "dispatch";
	const fingerprint =
		typeof body.fingerprint === "string" ? body.fingerprint : null;
	const printer = typeof body.printer === "string" ? body.printer : null;
	const serviceType =
		typeof body.serviceType === "string" ? body.serviceType : "FEDEX_GROUND";

	// In dispatch mode we need a valid target agent + printer (we're enqueuing a
	// real print job). In display mode nothing is enqueued, so we skip all of that
	// — no agent is touched.
	let ref: FirebaseFirestore.DocumentReference | null = null;
	if (dispatch) {
		if (!fingerprint) {
			return NextResponse.json(
				{ error: "fingerprint required" },
				{ status: 400 }
			);
		}
		if (!printer) {
			return NextResponse.json({ error: "printer required" }, { status: 400 });
		}

		// Validate the agent BEFORE buying a label (don't spend a carrier call on a
		// target we can't enqueue to).
		ref = db.collection("agents").doc(fingerprint);
		const snap = await ref.get();
		if (!snap.exists) {
			return NextResponse.json({ error: "agent not found" }, { status: 404 });
		}
		const agent = snap.data() as Agent;
		if (agent.status !== "approved") {
			return NextResponse.json(
				{ error: "agent must be approved to receive print jobs" },
				{ status: 400 }
			);
		}
		if (!agent.printers.includes(printer)) {
			return NextResponse.json(
				{ error: `printer "${printer}" not reported by this agent` },
				{ status: 400 }
			);
		}
	}

	// Carrier-branch on serviceType: UPS numeric service codes → UPS; everything
	// else (FEDEX_*) → FedEx. Both paths buy a real SANDBOX label in ZPL.
	const carrier = UPS_SERVICE_CODES.includes(serviceType) ? "ups" : "fedex";

	const shipment: Shipment = {
		shipTo: body.shipTo || DEFAULT_SHIP_TO,
		packages: body.packages || DEFAULT_PACKAGES,
		// Label branding (Cory feedback): part number + salesperson print in the
		// UPS label's reference area. Forwarded from the extension; blank/absent
		// values are omitted from the label by the UPS builder. UPS-only today.
		...(typeof body.partNumber === "string" ? { partNumber: body.partNumber } : {}),
		...(typeof body.salesperson === "string" ? { salesperson: body.salesperson } : {}),
	};

	// Buy the label (sandbox, ZPL). The raw label bytes never get logged.
	let label, trackingNumber;
	try {
		let result;
		if (carrier === "ups") {
			const upsCreds = {
				clientId: process.env.UPS_SANDBOX_CLIENT_ID || "",
				clientSecret: process.env.UPS_SANDBOX_CLIENT_SECRET || "",
				account: process.env.UPS_SANDBOX_ACCOUNT || "",
				oauthUrl: process.env.UPS_SANDBOX_OAUTH_URL || "",
				shipUrl: process.env.UPS_SANDBOX_SHIP_URL || "",
			};
			if (!upsCreds.clientId || !upsCreds.clientSecret) {
				return NextResponse.json(
					{ error: "UPS sandbox credentials not configured on server" },
					{ status: 500 }
				);
			}
			result = await buyUpsZplLabel(shipment, serviceType, upsCreds);
		} else {
			const fedexCreds = {
				apiKey: process.env.FEDEX_SANDBOX_API_KEY || "",
				secret: process.env.FEDEX_SANDBOX_SECRET || "",
				account: process.env.FEDEX_SANDBOX_ACCOUNT || "",
				oauthUrl: process.env.FEDEX_SANDBOX_OAUTH_URL || "",
				shipUrl: process.env.FEDEX_SANDBOX_SHIP_URL || "",
			};
			if (!fedexCreds.apiKey || !fedexCreds.secret) {
				return NextResponse.json(
					{ error: "FedEx sandbox credentials not configured on server" },
					{ status: 500 }
				);
			}
			result = await buyFedExZplLabel(
				shipment,
				serviceType,
				fedexCreds,
				todayStamp()
			);
		}
		if (!result.ok || !result.label) {
			return NextResponse.json(
				{ error: "carrier returned no label" },
				{ status: 502 }
			);
		}
		label = result.label;
		trackingNumber = result.trackingNumber;
	} catch (e) {
		const msg = e instanceof Error ? e.message : "carrier error";
		return NextResponse.json({ error: msg }, { status: 502 });
	}

	// The decoded base64 IS the raw ZPL the Zebra prints.
	const zpl = Buffer.from(label.encodedLabel, "base64").toString("utf8");
	if (!zpl.includes("^XA")) {
		return NextResponse.json(
			{ error: "carrier label is not ZPL (missing ^XA)" },
			{ status: 502 }
		);
	}

	// DISPLAY mode: render the preview and return WITHOUT enqueuing anything —
	// nothing reaches any printer. The response is honest that nothing dispatched.
	if (!dispatch) {
		const preview = await renderZplPreview(zpl);
		return NextResponse.json({
			ok: true,
			mode: "display",
			carrier,
			dispatched: false,
			jobId: null,
			printer: null,
			queuedAt: null,
			trackingNumber,
			docType: label.docType,
			previewOk: preview.ok,
			previewImage: preview.previewImage,
		});
	}

	// DISPATCH mode: enqueue the ZPL for the target printer, then render the
	// preview. The enqueue happens BEFORE the render so a Labelary outage never
	// affects the print — it only omits the preview.
	const now = Date.now();
	const jobRef = ref!.collection("jobs").doc();
	await jobRef.set({
		printer,
		zpl,
		status: "queued",
		queuedAt: now,
		source: `${carrier}-sandbox-zpl`,
		...(trackingNumber ? { trackingNumber } : {}),
	});

	const preview = await renderZplPreview(zpl);

	revalidatePath("/");
	return NextResponse.json({
		ok: true,
		mode: "dispatch",
		carrier,
		dispatched: true,
		jobId: jobRef.id,
		printer,
		queuedAt: now,
		trackingNumber,
		docType: label.docType,
		previewOk: preview.ok,
		previewImage: preview.previewImage,
	});
}
