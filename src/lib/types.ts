export type AgentStatus = "unapproved" | "approved" | "revoked";

export interface Agent {
	fingerprint: string;
	hostname: string;
	status: AgentStatus;
	firstSeen: number;
	lastSeen: number;
	printers: string[];
	agentVersion?: string;
}

export interface PollRequest {
	fingerprint: string;
	hostname: string;
	printers: string[];
	agentVersion?: string;
}

export interface PrintJob {
	id: string;
	printer: string;
	zpl: string;
}

export type PollResponse =
	| { status: "unapproved" }
	| { status: "approved"; jobs: PrintJob[] };
