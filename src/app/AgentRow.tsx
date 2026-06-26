"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentStatus } from "@/lib/types";

export function AgentRow({
	agent,
	isLive,
	relativeLastSeen,
}: {
	agent: Agent;
	isLive: boolean;
	relativeLastSeen: string;
}) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

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

	return (
		<div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							className={`inline-block h-2 w-2 rounded-full ${
								isLive ? "bg-emerald-500" : "bg-stone-300"
							}`}
							title={isLive ? "live (polled <15s ago)" : "stale"}
						/>
						<span className="font-medium text-slate-900">{agent.hostname}</span>
						<span className="text-xs text-slate-400">{relativeLastSeen}</span>
					</div>
					<div className="mt-1 font-mono text-xs text-slate-500 break-all">
						{agent.fingerprint}
					</div>
					<div className="mt-2 text-sm text-slate-700">
						{agent.printers.length === 0
							? "(no printers detected)"
							: `Printers: ${agent.printers.join(", ")}`}
					</div>
					{agent.agentVersion && (
						<div className="mt-1 text-xs text-slate-400">v{agent.agentVersion}</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-2">
					{agent.status === "unapproved" && (
						<>
							<button
								type="button"
								onClick={() => updateStatus("approved")}
								disabled={pending}
								className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
							>
								Approve
							</button>
							<button
								type="button"
								onClick={() => updateStatus("revoked")}
								disabled={pending}
								className="rounded-md border border-stone-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-stone-100 disabled:opacity-50"
							>
								Block
							</button>
						</>
					)}
					{agent.status === "approved" && (
						<button
							type="button"
							onClick={() => updateStatus("revoked")}
							disabled={pending}
							className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
						>
							Revoke
						</button>
					)}
					{agent.status === "revoked" && (
						<button
							type="button"
							onClick={() => updateStatus("approved")}
							disabled={pending}
							className="rounded-md border border-emerald-300 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
						>
							Re-approve
						</button>
					)}
				</div>
			</div>
			{error && <div className="mt-2 text-xs text-rose-600">{error}</div>}
		</div>
	);
}
