import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	const snap = await db
		.collection("agents")
		.orderBy("lastSeen", "desc")
		.get();
	const agents = snap.docs.map((d) => d.data() as Agent);
	return NextResponse.json({ agents });
}
