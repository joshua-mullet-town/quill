// FedEx Ship API — buy a real label in ZPLII (thermal) format against the FedEx
// SANDBOX. This is Quill's carrier-backend slice (locked Option-B architecture:
// Quill holds the carrier keys, buys labels, dispatches print).
//
// Ported + adapted from the QB-extension's carrier-core.js label-buy path. The
// ONE meaningful change vs that path: it requested imageType "PNG" (for in-browser
// display); we request "ZPLII" (raw thermal ZPL the Zebra prints directly). The
// decoded base64 of a ZPLII label is raw ZPL text starting with ^XA.
//
// SECURITY (hard): credentials are PASSED IN (never hardcoded, never logged).
// The bearer token and the raw label bytes are never logged or returned to any
// caller that would print them to a log. SANDBOX-only — sandbox labels are
// watermarked "TEST LABEL - DO NOT SHIP" and are non-billing by design.

export interface FedexCreds {
	apiKey: string;
	secret: string;
	account?: string;
	oauthUrl?: string;
	shipUrl?: string;
}

export interface Address {
	name?: string;
	street?: string;
	city?: string;
	state?: string;
	zip?: string;
	country?: string;
	residential?: boolean;
	phone?: string;
	contact?: { personName?: string; phoneNumber?: string };
}

export interface Package {
	length: number | string;
	width: number | string;
	depth: number | string;
	weight: number | string;
}

export interface Shipment {
	shipFrom?: Address;
	shipTo?: Address;
	accountNumber?: string;
	packages?: Package[];
	// Label branding (Cory feedback): the distributor's part number and
	// salesperson name print on the UPS label's reference area, replicating what
	// their existing WorldShip workflow produces. Both optional; a blank value is
	// omitted from the label. Only wired for UPS today (their live carrier) — see
	// ups-label.ts. FedEx label buys ignore these (FedEx branding is not in scope).
	partNumber?: string;
	salesperson?: string;
}

export interface FedexLabel {
	carrier: "fedex";
	encodedLabel: string; // base64 — NEVER logged
	docType: string; // e.g. "ZPLII" / "ZPL"
	contentType: string;
	trackingNumber: string | null;
}

const DEFAULT_SHIP_FROM: Address = {
	name: "Crowne Vault",
	street: "1 Vault Way",
	city: "Indianapolis",
	state: "IN",
	zip: "46201",
	country: "US",
};

const DEFAULT_SHIPPER_CONTACT = {
	personName: "Crowne Vault Shipping",
	phoneNumber: "3175551000",
};
const DEFAULT_RECIPIENT_PHONE = "0000000000";

function streetLines(addr?: Address): string[] {
	const s = addr && addr.street ? String(addr.street).trim() : "";
	return s ? [s] : [];
}

function fedexInt(v: number | string): number {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && n > 0 ? n : 1;
}

function numOrZero(v: number | string): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function totalWeight(pkgs: Package[]): number {
	return (pkgs || []).reduce((sum, p) => sum + numOrZero(p.weight), 0);
}

/**
 * Build the FedEx Ship request for a ZPLII (thermal) label.
 *
 * Differs from the PNG/display variant only in labelSpecification:
 *   imageType: "ZPLII" (raw ZPL) — was "PNG"
 *   labelStockType: "STOCK_4X6" (thermal continuous stock) — was "PAPER_4X6"
 * labelFormatType stays COMMON2D.
 *
 * shipDatestamp is INJECTED (YYYY-MM-DD) so this stays deterministic/testable.
 */
export function buildFedExZplLabelRequest(
	shipment: Shipment,
	serviceType: string,
	shipDatestamp: string
) {
	const s = shipment || {};
	const from = s.shipFrom || DEFAULT_SHIP_FROM;
	const to = s.shipTo || {};
	const pkgs = s.packages && s.packages.length ? s.packages : [];
	const shipperContact = from.contact || DEFAULT_SHIPPER_CONTACT;
	const account = s.accountNumber || "";

	return {
		labelResponseOptions: "LABEL",
		accountNumber: { value: account },
		requestedShipment: {
			shipper: {
				contact: {
					personName:
						shipperContact.personName || DEFAULT_SHIPPER_CONTACT.personName,
					phoneNumber:
						shipperContact.phoneNumber || DEFAULT_SHIPPER_CONTACT.phoneNumber,
				},
				address: {
					streetLines: streetLines(from),
					city: from.city || "",
					stateOrProvinceCode: from.state || "",
					postalCode: from.zip || "",
					countryCode: from.country || "US",
				},
			},
			recipients: [
				{
					contact: {
						personName: to.name || "Recipient",
						phoneNumber: to.phone || DEFAULT_RECIPIENT_PHONE,
					},
					address: {
						streetLines: streetLines(to),
						city: to.city || "",
						stateOrProvinceCode: to.state || "",
						postalCode: to.zip || "",
						countryCode: to.country || "US",
						residential: !!to.residential,
					},
				},
			],
			shipDatestamp: shipDatestamp || "",
			serviceType: serviceType || "FEDEX_GROUND",
			packagingType: "YOUR_PACKAGING",
			pickupType: "USE_SCHEDULED_PICKUP",
			shippingChargesPayment: {
				paymentType: "SENDER",
				payor: {
					responsibleParty: { accountNumber: { value: account } },
				},
			},
			labelSpecification: {
				imageType: "ZPLII", // raw thermal ZPL (was PNG for display)
				labelStockType: "STOCK_4X6", // thermal stock (was PAPER_4X6)
				labelFormatType: "COMMON2D",
			},
			totalWeight: totalWeight(pkgs),
			requestedPackageLineItems: pkgs.map((p) => ({
				weight: { units: "LB", value: numOrZero(p.weight) },
				dimensions: {
					length: fedexInt(p.length),
					width: fedexInt(p.width),
					height: fedexInt(p.depth), // our "depth" is FedEx "height"
					units: "IN",
				},
			})),
		},
	};
}

/**
 * Extract the base64 label from a FedEx Ship response (real documented path):
 *   output.transactionShipments[0].pieceResponses[0].packageDocuments[0].encodedLabel
 */
export function extractFedExLabel(response: unknown): FedexLabel | null {
	const r = response as {
		output?: {
			transactionShipments?: Array<{
				masterTrackingNumber?: string;
				pieceResponses?: Array<{
					trackingNumber?: string;
					packageDocuments?: Array<{
						contentType?: string;
						docType?: string;
						encodedLabel?: string;
					}>;
				}>;
			}>;
		};
	};
	const ts = r?.output?.transactionShipments?.[0];
	const piece = ts?.pieceResponses?.[0];
	const doc = piece?.packageDocuments?.[0];
	if (!doc || !doc.encodedLabel) return null;
	return {
		carrier: "fedex",
		encodedLabel: doc.encodedLabel, // base64 — NEVER logged
		docType: doc.docType || "ZPLII",
		contentType: doc.contentType || "LABEL",
		trackingNumber: ts?.masterTrackingNumber || piece?.trackingNumber || null,
	};
}

/**
 * Buy a real FedEx SANDBOX label in ZPLII format.
 *   OAuth (client-credentials, form body) → bearer → POST /ship/v1/shipments.
 * Returns { ok, label, trackingNumber } — the raw label base64 is on label.encodedLabel.
 * Throws on auth/network/API failure (error text truncated, never includes the token).
 */
export async function buyFedExZplLabel(
	shipment: Shipment,
	serviceType: string,
	creds: FedexCreds,
	shipDatestamp: string,
	fetchImpl?: typeof fetch
): Promise<{ ok: boolean; label: FedexLabel | null; trackingNumber: string | null }> {
	const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
	if (!fetchFn) throw new Error("no fetch implementation available");
	if (!creds || !creds.apiKey || !creds.secret) {
		throw new Error("missing FedEx credentials");
	}
	const oauthUrl = creds.oauthUrl || "https://apis-sandbox.fedex.com/oauth/token";
	const shipUrl = creds.shipUrl || "https://apis-sandbox.fedex.com/ship/v1/shipments";

	// 1) OAuth client-credentials → bearer (form-urlencoded body).
	const tokenRes = await fetchFn(oauthUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body:
			"grant_type=client_credentials" +
			"&client_id=" +
			encodeURIComponent(creds.apiKey) +
			"&client_secret=" +
			encodeURIComponent(creds.secret),
	});
	if (!tokenRes.ok) throw new Error("FedEx OAuth failed: HTTP " + tokenRes.status);
	const tokenJson = (await tokenRes.json()) as { access_token?: string };
	const bearer = tokenJson && tokenJson.access_token;
	if (!bearer) throw new Error("FedEx OAuth returned no access_token");

	// 2) Build the ZPLII ship request and POST it.
	const shipmentWithAccount = creds.account
		? { ...shipment, accountNumber: creds.account }
		: shipment;
	const request = buildFedExZplLabelRequest(
		shipmentWithAccount,
		serviceType,
		shipDatestamp
	);
	const shipRes = await fetchFn(shipUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer " + bearer, // token NEVER logged
			"X-locale": "en_US",
		},
		body: JSON.stringify(request),
	});
	if (!shipRes.ok) {
		const text = await shipRes.text().catch(() => "");
		throw new Error("FedEx ship failed: HTTP " + shipRes.status + " " + text.slice(0, 300));
	}
	const response = await shipRes.json();
	const label = extractFedExLabel(response);
	return {
		ok: !!label,
		label,
		trackingNumber: label ? label.trackingNumber : null,
	};
}
