import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { revalidatePath } from "next/cache";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";

const TEST_LABEL_ZPL = `^XA
^CF0,40
^FO50,50^FDQuill test label^FS
^CF0,25
^FO50,110^FDSent from Quill admin^FS
^FO50,150^FDIf you can read this, the^FS
^FO50,185^FDend-to-end print path works.^FS
^CF0,20
^FO50,260^FD${new Date().toISOString()}^FS
^XZ
`;

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ fingerprint: string }> }
) {
	const { fingerprint } = await params;
	const body = await request.json().catch(() => ({}));
	const printer = typeof body.printer === "string" ? body.printer : null;

	if (!printer) {
		return NextResponse.json({ error: "printer required" }, { status: 400 });
	}

	const ref = db.collection("agents").doc(fingerprint);
	const snap = await ref.get();
	if (!snap.exists) {
		return NextResponse.json({ error: "agent not found" }, { status: 404 });
	}

	const agent = snap.data() as Agent;
	if (agent.status !== "approved") {
		return NextResponse.json(
			{ error: "agent must be approved to receive test prints" },
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
		zpl: TEST_LABEL_ZPL,
		status: "queued",
		queuedAt: now,
		source: "quill-admin-test-print",
	});

	await ref.update({
		lastTestPrint: {
			printer,
			queuedAt: now,
			jobId: jobRef.id,
		},
	});

	revalidatePath("/");
	return NextResponse.json({
		ok: true,
		jobId: jobRef.id,
		printer,
		queuedAt: now,
	});
}
