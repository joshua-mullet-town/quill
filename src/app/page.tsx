import { db } from "@/lib/firebase-admin";
import type { Agent } from "@/lib/types";
import { AgentRow } from "./AgentRow";

export const dynamic = "force-dynamic";

async function getAgents(): Promise<Agent[]> {
	const snap = await db.collection("agents").orderBy("lastSeen", "desc").get();
	return snap.docs.map((d) => d.data() as Agent);
}

function formatRelative(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 10) return "just now";
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

function isLive(ts: number): boolean {
	return Date.now() - ts < 15_000;
}

export default async function Home() {
	const agents = await getAgents();
	const pending = agents.filter((a) => a.status === "unapproved");
	const approved = agents.filter((a) => a.status === "approved");
	const revoked = agents.filter((a) => a.status === "revoked");

	return (
		<main className="min-h-screen bg-stone-50 p-8">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<h1 className="text-3xl font-semibold text-slate-900">Quill</h1>
					<p className="text-sm text-slate-500">Shipping print agent control plane</p>
				</header>

				{pending.length > 0 && (
					<section className="mb-8">
						<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-700">
							Pending approval ({pending.length})
						</h2>
						<div className="space-y-2">
							{pending.map((a) => (
								<AgentRow
									key={a.fingerprint}
									agent={a}
									isLive={isLive(a.lastSeen)}
									relativeLastSeen={formatRelative(a.lastSeen)}
								/>
							))}
						</div>
					</section>
				)}

				{approved.length > 0 && (
					<section className="mb-8">
						<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-emerald-700">
							Approved ({approved.length})
						</h2>
						<div className="space-y-2">
							{approved.map((a) => (
								<AgentRow
									key={a.fingerprint}
									agent={a}
									isLive={isLive(a.lastSeen)}
									relativeLastSeen={formatRelative(a.lastSeen)}
								/>
							))}
						</div>
					</section>
				)}

				{revoked.length > 0 && (
					<section className="mb-8">
						<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-rose-700">
							Revoked ({revoked.length})
						</h2>
						<div className="space-y-2">
							{revoked.map((a) => (
								<AgentRow
									key={a.fingerprint}
									agent={a}
									isLive={isLive(a.lastSeen)}
									relativeLastSeen={formatRelative(a.lastSeen)}
								/>
							))}
						</div>
					</section>
				)}

				{agents.length === 0 && (
					<div className="rounded-lg border border-dashed border-stone-300 p-12 text-center text-slate-500">
						No agents have phoned home yet.
					</div>
				)}

				<footer className="mt-12 text-xs text-slate-400">
					Page polls every 5s when active. Refresh to update.
				</footer>
			</div>
		</main>
	);
}
