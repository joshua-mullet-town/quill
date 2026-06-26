import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import type { Agent, PollRequest, PollResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	let body: PollRequest;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
	}

	const { fingerprint, hostname, printers, agentVersion } = body;
	if (!fingerprint || !hostname || !Array.isArray(printers)) {
		return NextResponse.json(
			{ error: "fingerprint, hostname, printers required" },
			{ status: 400 }
		);
	}

	const now = Date.now();
	const ref = db.collection("agents").doc(fingerprint);
	const snap = await ref.get();

	if (!snap.exists) {
		const agent: Agent = {
			fingerprint,
			hostname,
			status: "unapproved",
			firstSeen: now,
			lastSeen: now,
			printers,
			agentVersion,
		};
		await ref.set(agent);
		const res: PollResponse = { status: "unapproved" };
		return NextResponse.json(res);
	}

	const existing = snap.data() as Agent;
	await ref.update({
		hostname,
		lastSeen: now,
		printers,
		agentVersion: agentVersion ?? existing.agentVersion ?? null,
	});

	if (existing.status !== "approved") {
		const res: PollResponse = { status: "unapproved" };
		return NextResponse.json(res);
	}

	const jobsSnap = await db
		.collection("agents")
		.doc(fingerprint)
		.collection("jobs")
		.where("status", "==", "queued")
		.orderBy("queuedAt", "asc")
		.limit(10)
		.get();

	const jobs = jobsSnap.docs.map((d) => {
		const data = d.data();
		return { id: d.id, printer: data.printer, zpl: data.zpl };
	});

	if (jobs.length > 0) {
		const batch = db.batch();
		for (const d of jobsSnap.docs) {
			batch.update(d.ref, { status: "dispatched", dispatchedAt: now });
		}
		await batch.commit();
	}

	const res: PollResponse = { status: "approved", jobs };
	return NextResponse.json(res);
}
