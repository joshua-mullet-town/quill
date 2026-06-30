import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { revalidatePath } from "next/cache";
import { isAuthorizedEnqueue } from "@/lib/enqueue-auth";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";

// Real label-enqueue endpoint. Generalizes the admin test-print route: an
// EXTERNAL caller (the QB extension, or Quill's own carrier-buy path) POSTs
// arbitrary base64-or-raw ZPL for a target printer on a target agent, and we
// drop a job into agents/{fingerprint}/jobs — the SAME shape the agent already
// polls for via /api/poll. Unlike test-print (same-origin admin UI, no auth),
// this is authed with a bearer token because the caller is off-origin.
//
// CONTRACT (locked — shared with the QB-extension Worker):
//   POST /api/agents/{fingerprint}/enqueue
//   Authorization: Bearer <QUILL_ENQUEUE_TOKEN>
//   Body: { printer: string, zpl: string, source?: string, encoding?: "base64" | "raw" }
//     - zpl: the label payload. If encoding="base64" (default), it's base64 and
//       we decode to the raw ZPL text the agent prints. If encoding="raw", it's
//       already raw ZPL (starts with ^XA) and stored verbatim.
//     - source: free-form provenance tag stored on the job (default "external-enqueue").
//   200 → { ok: true, jobId, printer, queuedAt }
//   400 → bad input / agent not approved / printer not reported
//   401 → missing/invalid bearer token
//   404 → agent not found

const MAX_ZPL_BYTES = 512 * 1024; // 512 KB ceiling — a real 4x6 ZPL label is a few KB.

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ fingerprint: string }> }
) {
	if (!isAuthorizedEnqueue(request)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const { fingerprint } = await params;
	const body = await request.json().catch(() => ({}));

	const printer = typeof body.printer === "string" ? body.printer : null;
	const rawZpl = typeof body.zpl === "string" ? body.zpl : null;
	const encoding = body.encoding === "raw" ? "raw" : "base64";
	const source =
		typeof body.source === "string" && body.source.trim()
			? body.source.trim().slice(0, 120)
			: "external-enqueue";

	if (!printer) {
		return NextResponse.json({ error: "printer required" }, { status: 400 });
	}
	if (!rawZpl) {
		return NextResponse.json({ error: "zpl required" }, { status: 400 });
	}

	// Decode to the raw ZPL text the agent sends to the printer.
	let zpl: string;
	if (encoding === "base64") {
		try {
			zpl = Buffer.from(rawZpl, "base64").toString("utf8");
		} catch {
			return NextResponse.json(
				{ error: "zpl is not valid base64" },
				{ status: 400 }
			);
		}
	} else {
		zpl = rawZpl;
	}

	if (!zpl || Buffer.byteLength(zpl, "utf8") > MAX_ZPL_BYTES) {
		return NextResponse.json(
			{ error: "zpl empty or exceeds size limit" },
			{ status: 400 }
		);
	}
	if (!zpl.includes("^XA")) {
		return NextResponse.json(
			{ error: "zpl does not look like a ZPL label (missing ^XA)" },
			{ status: 400 }
		);
	}

	const ref = db.collection("agents").doc(fingerprint);
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

	const now = Date.now();
	const jobRef = ref.collection("jobs").doc();
	await jobRef.set({
		printer,
		zpl,
		status: "queued",
		queuedAt: now,
		source,
	});

	revalidatePath("/");
	return NextResponse.json({
		ok: true,
		jobId: jobRef.id,
		printer,
		queuedAt: now,
	});
}
