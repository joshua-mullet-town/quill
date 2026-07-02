// UPS Shipping API — buy a real label in ZPL (thermal) format against the UPS
// SANDBOX (wwwcie.ups.com). Quill's carrier-backend, UPS side (analogous to
// fedex-label.ts).
//
// Ported + adapted from the QB-extension's carrier-core.js UPS label-buy path.
// The ONE meaningful change vs that path: it requested LabelImageFormat GIF (for
// in-browser display); we request "ZPL" + a 4x6 LabelStockSize (raw thermal ZPL
// the Zebra prints directly). For UPS, the ZPL bytes come back as a base64
// GraphicImage; decoded, it's raw ZPL text starting with ^XA.
//
// ⚠️ UPS OAuth differs from FedEx: HTTP BASIC auth — base64(clientId:clientSecret)
// in the Authorization header, body is just `grant_type=client_credentials`.
// ALL numeric fields are STRINGS (UPS contract).
//
// SECURITY (hard): credentials are PASSED IN (never hardcoded, never logged). The
// bearer token and raw label bytes are never logged or returned to a caller that
// would log them. SANDBOX-only — sandbox labels are watermarked, non-billing.

import type { Address, Package, Shipment } from "@/lib/fedex-label";

export interface UpsCreds {
	clientId: string;
	clientSecret: string;
	account?: string;
	oauthUrl?: string;
	shipUrl?: string;
}

export interface UpsLabel {
	carrier: "ups";
	encodedLabel: string; // base64 — NEVER logged
	docType: string; // e.g. "ZPL"
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

function numOrZero(v: number | string): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

// Base64 encode (Node Buffer) for HTTP Basic auth.
function b64(str: string): string {
	if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
	if (typeof btoa !== "undefined") return btoa(str);
	throw new Error("no base64 encoder available");
}

/**
 * Build the UPS Ship request for a ZPL (thermal) label.
 *
 * Differs from the GIF/display variant only in LabelSpecification:
 *   LabelImageFormat.Code: "ZPL" — was "GIF"
 *   LabelStockSize: { Height:"6", Width:"4" } — required for thermal ZPL stock
 * All numerics are strings (UPS contract).
 */
// UPS reference codes whose UPS-DEFINED captions match the branding we want.
// The caption UPS prints next to a reference is driven by its Code, NOT free text:
//   "PM" → UPS prints "Part No.: <value>"
//   "SA" → UPS prints "Salesperson: <value>"
// So we send the BARE value (just "800" / "Crescent Memorial") and let UPS supply
// the caption — which renders exactly the WorldShip-style "Part No.:"/"Salesperson:"
// lines the client wants, with NO generic "Reference No.N:" prefix. (A generic code
// like the old "28" made UPS fall back to "Reference No.1:", which is why the label
// read "Reference No.1: Part Number: 800" before.) Verified on a real UPS sandbox
// label: PM→"Part No.: 800", SA→"Salesperson: Crescent Memorial", no "Reference No."
const UPS_PART_NUMBER_CODE = "PM";
const UPS_SALESPERSON_CODE = "SA";

// Build the UPS Package.ReferenceNumber array from the branding fields. Each is a
// { Code, Value } where the Code selects the printed caption and the Value is the
// bare content. Blank fields are omitted entirely (no empty reference line).
// Returns undefined when nothing to show, so the key is left off the request.
function buildReferenceNumbers(shipment: Shipment) {
	const s = shipment || {};
	const partNumber = (s.partNumber == null ? "" : String(s.partNumber)).trim();
	const salesperson = (s.salesperson == null ? "" : String(s.salesperson)).trim();
	const refs: { Code: string; Value: string }[] = [];
	if (partNumber) {
		refs.push({ Code: UPS_PART_NUMBER_CODE, Value: partNumber });
	}
	if (salesperson) {
		refs.push({ Code: UPS_SALESPERSON_CODE, Value: salesperson });
	}
	return refs.length ? refs : undefined;
}

export function buildUpsZplLabelRequest(shipment: Shipment, serviceCode: string) {
	const s = shipment || {};
	const from = s.shipFrom || DEFAULT_SHIP_FROM;
	const to = s.shipTo || {};
	const pkgs: Package[] = s.packages && s.packages.length ? s.packages : [];
	const shipperContact = from.contact || DEFAULT_SHIPPER_CONTACT;
	const account = s.accountNumber || "";
	const referenceNumbers = buildReferenceNumbers(s);

	const fromAddress = {
		AddressLine: streetLines(from),
		City: from.city || "",
		StateProvinceCode: from.state || "",
		PostalCode: from.zip || "",
		CountryCode: from.country || "US",
	};
	const shipToAddress: Record<string, unknown> = {
		AddressLine: streetLines(to),
		City: to.city || "",
		StateProvinceCode: to.state || "",
		PostalCode: to.zip || "",
		CountryCode: to.country || "US",
	};
	if (to.residential) shipToAddress.ResidentialAddressIndicator = "";

	return {
		ShipmentRequest: {
			Request: {
				SubVersion: "2409",
				RequestOption: "nonvalidate",
				TransactionReference: { CustomerContext: "crowne-vault-shipping" },
			},
			Shipment: {
				Description: "Crowne Vault shipment",
				Shipper: {
					Name: from.name || "Crowne Vault",
					AttentionName: shipperContact.personName || "Crowne Vault Shipping",
					Phone: {
						Number: shipperContact.phoneNumber || DEFAULT_SHIPPER_CONTACT.phoneNumber,
					},
					ShipperNumber: account,
					Address: { ...fromAddress },
				},
				ShipFrom: {
					Name: from.name || "Crowne Vault",
					AttentionName: shipperContact.personName || "Crowne Vault Shipping",
					Phone: {
						Number: shipperContact.phoneNumber || DEFAULT_SHIPPER_CONTACT.phoneNumber,
					},
					Address: { ...fromAddress },
				},
				ShipTo: {
					Name: to.name || "Recipient",
					AttentionName: to.name || "Recipient",
					Phone: { Number: to.phone || DEFAULT_RECIPIENT_PHONE },
					Address: shipToAddress,
				},
				PaymentInformation: {
					ShipmentCharge: {
						Type: "01", // Transportation
						BillShipper: { AccountNumber: account },
					},
				},
				Service: { Code: serviceCode || "03", Description: "Ground" },
				Package: pkgs.map((p) => ({
					Packaging: { Code: "02", Description: "Customer Supplied Package" },
					// Label branding (Cory feedback): part number + salesperson print in
					// the package's reference area. UPS requires ReferenceNumber at the
					// PACKAGE level (not Shipment) for US-domestic shipments — a
					// Shipment-level ReferenceNumber returns error 120541. Key omitted
					// entirely when both branding fields are blank.
					...(referenceNumbers ? { ReferenceNumber: referenceNumbers } : {}),
					Dimensions: {
						UnitOfMeasurement: { Code: "IN", Description: "Inches" },
						Length: String(numOrZero(p.length)),
						Width: String(numOrZero(p.width)),
						Height: String(numOrZero(p.depth)), // our "depth" is UPS "Height"
					},
					PackageWeight: {
						UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
						Weight: String(numOrZero(p.weight)),
					},
				})),
			},
			LabelSpecification: {
				LabelImageFormat: { Code: "ZPL", Description: "ZPL" }, // was GIF
				LabelStockSize: { Height: "6", Width: "4" }, // 4x6 thermal stock
				HTTPUserAgent: "Mozilla/4.5",
			},
		},
	};
}

/**
 * Extract the base64 label from a UPS Ship response (real documented path):
 *   ShipmentResponse.ShipmentResults.PackageResults[0].ShippingLabel.GraphicImage
 * PackageResults may be a single object or array — handle both.
 */
export function extractUpsLabel(response: unknown): UpsLabel | null {
	const r = response as {
		ShipmentResponse?: {
			ShipmentResults?: {
				ShipmentIdentificationNumber?: string;
				PackageResults?:
					| Array<{
							TrackingNumber?: string;
							ShippingLabel?: {
								ImageFormat?: { Code?: string };
								GraphicImage?: string;
							};
					  }>
					| {
							TrackingNumber?: string;
							ShippingLabel?: {
								ImageFormat?: { Code?: string };
								GraphicImage?: string;
							};
					  };
			};
		};
	};
	const results = r?.ShipmentResponse?.ShipmentResults;
	if (!results) return null;
	let pkgs = results.PackageResults;
	if (!pkgs) return null;
	if (!Array.isArray(pkgs)) pkgs = [pkgs];
	const first = pkgs[0];
	const label = first?.ShippingLabel;
	if (!label || !label.GraphicImage) return null;
	return {
		carrier: "ups",
		encodedLabel: label.GraphicImage, // base64 — NEVER logged
		docType: label.ImageFormat?.Code || "ZPL",
		contentType: "LABEL",
		trackingNumber:
			first?.TrackingNumber || results.ShipmentIdentificationNumber || null,
	};
}

/**
 * Buy a real UPS SANDBOX label in ZPL format.
 *   OAuth (HTTP Basic) → bearer → POST /api/shipments/v2409/ship.
 * Returns { ok, label, trackingNumber }. Throws on auth/network/API failure
 * (error text truncated, never includes the token).
 */
export async function buyUpsZplLabel(
	shipment: Shipment,
	serviceCode: string,
	creds: UpsCreds,
	fetchImpl?: typeof fetch
): Promise<{ ok: boolean; label: UpsLabel | null; trackingNumber: string | null }> {
	const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
	if (!fetchFn) throw new Error("no fetch implementation available");
	if (!creds || !creds.clientId || !creds.clientSecret) {
		throw new Error("missing UPS credentials");
	}
	const oauthUrl = creds.oauthUrl || "https://wwwcie.ups.com/security/v1/oauth/token";
	const shipUrl = creds.shipUrl || "https://wwwcie.ups.com/api/shipments/v2409/ship";

	// 1) OAuth client-credentials via HTTP BASIC auth (id:secret in header).
	const basic = b64(creds.clientId + ":" + creds.clientSecret);
	const tokenRes = await fetchFn(oauthUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: "Basic " + basic, // creds in header, NOT body
		},
		body: "grant_type=client_credentials",
	});
	if (!tokenRes.ok) throw new Error("UPS OAuth failed: HTTP " + tokenRes.status);
	const tokenJson = (await tokenRes.json()) as { access_token?: string };
	const bearer = tokenJson && tokenJson.access_token;
	if (!bearer) throw new Error("UPS OAuth returned no access_token");

	// 2) Build the ZPL ship request and POST it.
	const shipmentWithAccount = creds.account
		? { ...shipment, accountNumber: creds.account }
		: shipment;
	const request = buildUpsZplLabelRequest(shipmentWithAccount, serviceCode);
	const shipRes = await fetchFn(shipUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer " + bearer, // token NEVER logged
		},
		body: JSON.stringify(request),
	});
	if (!shipRes.ok) {
		const text = await shipRes.text().catch(() => "");
		throw new Error("UPS ship failed: HTTP " + shipRes.status + " " + text.slice(0, 300));
	}
	const response = await shipRes.json();
	const label = extractUpsLabel(response);
	return {
		ok: !!label,
		label,
		trackingNumber: label ? label.trackingNumber : null,
	};
}

// US-domestic UPS service codes we accept (used by the route to carrier-branch).
export const UPS_SERVICE_CODES = ["01", "02", "03", "12", "13", "59"];
