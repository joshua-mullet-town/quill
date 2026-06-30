// Bearer-token auth for external label-enqueue callers (the QB extension, the
// Quill carrier backend's own buy-and-enqueue path). The admin UI routes are
// same-origin and unauthed; this is the ONE seam an external caller hits, so it
// carries a shared secret.
//
// The token lives in QUILL_ENQUEUE_TOKEN (App Hosting env / .env.local) — never
// committed. A request authenticates with `Authorization: Bearer <token>`.

import type { NextRequest } from "next/server";

/**
 * Returns true when the request carries the correct bearer token.
 * Returns false on any mismatch, missing header, or unconfigured server.
 *
 * Fails CLOSED: if QUILL_ENQUEUE_TOKEN is not set on the server, NO request
 * authenticates (we never want an accidentally-open enqueue endpoint in prod).
 */
export function isAuthorizedEnqueue(request: NextRequest): boolean {
	const expected = process.env.QUILL_ENQUEUE_TOKEN;
	if (!expected) return false;

	const header = request.headers.get("authorization") || "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;

	const presented = match[1].trim();
	// Constant-time-ish compare: lengths must match, then char-by-char.
	if (presented.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < presented.length; i++) {
		diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return diff === 0;
}
