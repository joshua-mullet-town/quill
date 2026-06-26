"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentStatus } from "@/lib/types";

function formatRelative(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 10) return "just now";
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

function formatAbsolute(ts: number): string {
	return new Date(ts).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function AgentCard({ agent, live }: { agent: Agent; live: boolean }) {
	const router = useRouter();
	const [busy, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	async function updateStatus(status: AgentStatus) {
		setError(null);
		const res = await fetch(`/api/agents/${agent.fingerprint}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			setError(body.error ?? "update failed");
			return;
		}
		startTransition(() => router.refresh());
	}

	function copyFingerprint() {
		navigator.clipboard.writeText(agent.fingerprint).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	const statusPill = {
		unapproved: (
			<span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
				Pending
			</span>
		),
		approved: (
			<span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
				Approved
			</span>
		),
		revoked: (
			<span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
				Revoked
			</span>
		),
	}[agent.status];

	return (
		<div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
			<div className="border-b border-slate-100 px-4 py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span
								className={`inline-block h-2 w-2 rounded-full ${
									live ? "bg-emerald-500" : "bg-slate-300"
								}`}
								title={live ? "live (polled <15s ago)" : "stale (no recent poll)"}
							/>
							<span className="truncate font-semibold text-slate-900">{agent.hostname}</span>
							{statusPill}
						</div>
						<div className="mt-0.5 text-xs text-slate-500">
							{live ? "Connected" : `Last seen ${formatRelative(agent.lastSeen)}`}
						</div>
					</div>
				</div>
			</div>

			<dl className="divide-y divide-slate-100">
				<Row label="Printers">
					{agent.printers.length === 0 ? (
						<span className="text-sm text-slate-400 italic">none detected</span>
					) : (
						<div className="flex flex-wrap gap-1.5">
							{agent.printers.map((p) => (
								<span
									key={p}
									className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
								>
									{p}
								</span>
							))}
						</div>
					)}
				</Row>

				<Row label="Machine ID">
					<button
						type="button"
						onClick={copyFingerprint}
						className="group inline-flex items-center gap-1.5 text-left font-mono text-xs text-slate-500 hover:text-slate-700"
						title="Click to copy"
					>
						<span className="break-all">{agent.fingerprint}</span>
						<span className="text-[10px] uppercase tracking-wide text-slate-400 group-hover:text-slate-600">
							{copied ? "copied" : "copy"}
						</span>
					</button>
				</Row>

				<Row label="First seen">
					<span className="text-sm text-slate-700">{formatAbsolute(agent.firstSeen)}</span>
				</Row>

				<Row label="Last poll">
					<span className="text-sm text-slate-700">{formatAbsolute(agent.lastSeen)}</span>
				</Row>

				{agent.agentVersion && (
					<Row label="Agent version">
						<span className="font-mono text-xs text-slate-600">v{agent.agentVersion}</span>
					</Row>
				)}
			</dl>

			<div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
				{agent.status === "unapproved" && (
					<>
						<button
							type="button"
							onClick={() => updateStatus("revoked")}
							disabled={busy}
							className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
						>
							Block
						</button>
						<button
							type="button"
							onClick={() => updateStatus("approved")}
							disabled={busy}
							className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
						>
							Approve
						</button>
					</>
				)}
				{agent.status === "approved" && (
					<button
						type="button"
						onClick={() => updateStatus("revoked")}
						disabled={busy}
						className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
					>
						Revoke
					</button>
				)}
				{agent.status === "revoked" && (
					<button
						type="button"
						onClick={() => updateStatus("approved")}
						disabled={busy}
						className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
					>
						Re-approve
					</button>
				)}
			</div>

			{error && (
				<div className="border-t border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700">
					{error}
				</div>
			)}
		</div>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[7rem_1fr] gap-3 px-4 py-2.5">
			<dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</div>
	);
}
