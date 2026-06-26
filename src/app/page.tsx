import { db } from "@/lib/firebase-admin";
import type { Agent } from "@/lib/types";
import { AgentCard } from "./AgentCard";

export const dynamic = "force-dynamic";

const QUILL_ENDPOINT = "https://quill--quill-print.us-central1.hosted.app/api/poll";

async function getAgents(): Promise<Agent[]> {
	const snap = await db.collection("agents").orderBy("lastSeen", "desc").get();
	return snap.docs.map((d) => d.data() as Agent);
}

function isLive(ts: number): boolean {
	return Date.now() - ts < 15_000;
}

export default async function Home() {
	const agents = await getAgents();
	const pending = agents.filter((a) => a.status === "unapproved");
	const approved = agents.filter((a) => a.status === "approved");
	const revoked = agents.filter((a) => a.status === "revoked");
	const liveCount = agents.filter((a) => isLive(a.lastSeen)).length;

	return (
		<main className="min-h-screen bg-slate-100">
			<div className="border-b border-slate-200 bg-white">
				<div className="mx-auto max-w-6xl px-6 py-6">
					<div className="flex items-baseline justify-between">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight text-slate-900">Quill</h1>
							<p className="mt-0.5 text-sm text-slate-500">
								Shipping print agent control plane
							</p>
						</div>
						<div className="hidden text-right sm:block">
							<div className="font-mono text-xs text-slate-400">poll endpoint</div>
							<div className="font-mono text-xs text-slate-600 break-all">{QUILL_ENDPOINT}</div>
						</div>
					</div>

					<div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
						<StatTile label="Live now" value={liveCount} hint="polled <15s ago" tone="emerald" />
						<StatTile
							label="Pending approval"
							value={pending.length}
							hint="waiting on you"
							tone={pending.length > 0 ? "amber" : "slate"}
						/>
						<StatTile label="Approved" value={approved.length} hint="active agents" tone="slate" />
						<StatTile label="Revoked" value={revoked.length} hint="blocked" tone="slate" />
					</div>
				</div>
			</div>

			<div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
				{pending.length > 0 && (
					<Section
						title="Pending approval"
						subtitle="These machines phoned home but haven't been approved yet. Approve to let them receive print jobs."
						accent="amber"
						count={pending.length}
					>
						<div className="grid gap-3 md:grid-cols-2">
							{pending.map((a) => (
								<AgentCard key={a.fingerprint} agent={a} live={isLive(a.lastSeen)} />
							))}
						</div>
					</Section>
				)}

				{approved.length > 0 && (
					<Section
						title="Approved"
						subtitle="These machines are connected and will receive print jobs when work is dispatched."
						accent="emerald"
						count={approved.length}
					>
						<div className="grid gap-3 md:grid-cols-2">
							{approved.map((a) => (
								<AgentCard key={a.fingerprint} agent={a} live={isLive(a.lastSeen)} />
							))}
						</div>
					</Section>
				)}

				{revoked.length > 0 && (
					<Section
						title="Revoked"
						subtitle="These machines are blocked. They can still phone home, but they get nothing back."
						accent="slate"
						count={revoked.length}
					>
						<div className="grid gap-3 md:grid-cols-2">
							{revoked.map((a) => (
								<AgentCard key={a.fingerprint} agent={a} live={isLive(a.lastSeen)} />
							))}
						</div>
					</Section>
				)}

				{agents.length === 0 && (
					<div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center">
						<div className="text-slate-700 font-medium">No agents yet</div>
						<div className="mt-1 text-sm text-slate-500">
							When someone runs the Crowne Vault Shipping Agent .exe, they'll appear here for
							approval.
						</div>
					</div>
				)}
			</div>

			<footer className="mx-auto max-w-6xl px-6 pb-8 text-xs text-slate-400">
				Live status reflects the last <span className="font-mono">/api/poll</span> from each agent.
				Refresh the page to update.
			</footer>
		</main>
	);
}

function StatTile({
	label,
	value,
	hint,
	tone,
}: {
	label: string;
	value: number;
	hint: string;
	tone: "emerald" | "amber" | "slate";
}) {
	const toneClasses = {
		emerald: "text-emerald-700",
		amber: "text-amber-700",
		slate: "text-slate-700",
	}[tone];

	return (
		<div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
			<div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
			<div className={`mt-1 text-2xl font-semibold ${toneClasses}`}>{value}</div>
			<div className="text-xs text-slate-400">{hint}</div>
		</div>
	);
}

function Section({
	title,
	subtitle,
	accent,
	count,
	children,
}: {
	title: string;
	subtitle: string;
	accent: "amber" | "emerald" | "slate";
	count: number;
	children: React.ReactNode;
}) {
	const dotClass = {
		amber: "bg-amber-500",
		emerald: "bg-emerald-500",
		slate: "bg-slate-400",
	}[accent];

	return (
		<section>
			<div className="mb-3 flex items-baseline gap-3">
				<span className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`} />
				<h2 className="text-base font-semibold text-slate-900">{title}</h2>
				<span className="text-sm text-slate-400">{count}</span>
			</div>
			<p className="mb-4 text-sm text-slate-500">{subtitle}</p>
			{children}
		</section>
	);
}
