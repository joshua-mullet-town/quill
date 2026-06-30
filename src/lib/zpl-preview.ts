// Render ZPL to a PNG preview via Labelary (api.labelary.com) — a free, public
// ZPL-rendering service. Used by /api/buy-and-print to return a faithful preview
// of the EXACT label that was sent to the printer, from a SINGLE carrier buy (no
// double-buy: we render the same ZPL we print).
//
// This is a BACKEND-only outbound call — no secret exposure, the extension never
// sees ZPL. It DEGRADES CLEANLY: if Labelary is unreachable or errors, the print
// is unaffected (the caller still enqueues the ZPL); only the preview is omitted.

export interface ZplPreview {
	/** data:image/png;base64,... — present only when the render succeeded. */
	previewImage: string | null;
	/** True when Labelary rendered a PNG; false on any failure (print unaffected). */
	ok: boolean;
}

// 8dpmm (203 dpi — the GX420d's native density), 4x6 label, first label only.
const LABELARY_URL = "https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/";
const RENDER_TIMEOUT_MS = 6000;

/**
 * Render raw ZPL to a base64 PNG data-URI. Never throws — returns
 * { ok:false, previewImage:null } on any error so a Labelary outage degrades the
 * preview without breaking the print path.
 */
export async function renderZplPreview(
	zpl: string,
	fetchImpl?: typeof fetch
): Promise<ZplPreview> {
	const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
	if (!fetchFn || !zpl) return { ok: false, previewImage: null };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
	try {
		const res = await fetchFn(LABELARY_URL, {
			method: "POST",
			headers: {
				Accept: "image/png",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: zpl,
			signal: controller.signal,
		});
		if (!res.ok) return { ok: false, previewImage: null };
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) return { ok: false, previewImage: null };
		return {
			ok: true,
			previewImage: `data:image/png;base64,${buf.toString("base64")}`,
		};
	} catch {
		// Network error, timeout/abort, etc. — preview degrades, print is fine.
		return { ok: false, previewImage: null };
	} finally {
		clearTimeout(timer);
	}
}
