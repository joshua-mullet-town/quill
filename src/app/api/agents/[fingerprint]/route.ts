import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { revalidatePath } from "next/cache";
import type { AgentStatus } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ fingerprint: string }> }
) {
	const { fingerprint } = await params;
	const body = await request.json();
	const status = body.status as AgentStatus;
	if (!["approved", "revoked", "unapproved"].includes(status)) {
		return NextResponse.json({ error: "invalid status" }, { status: 400 });
	}

	const ref = db.collection("agents").doc(fingerprint);
	const snap = await ref.get();
	if (!snap.exists) {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}

	await ref.update({ status });
	revalidatePath("/");
	return NextResponse.json({ ok: true, fingerprint, status });
}
