# Print-enqueue API (real label dispatch)

Quill's carrier-backend slice: accept a real ZPL label (or buy one), and enqueue
it as a print job for an approved agent's printer. The agent polls `/api/poll`
and prints whatever is queued — same job shape the admin test-print already uses.

## Auth

External callers (the QB extension, off-origin scripts) authenticate with a
bearer token:

```
Authorization: Bearer <QUILL_ENQUEUE_TOKEN>
```

`QUILL_ENQUEUE_TOKEN` is server-side env only (`.env.local` locally, App Hosting
env in prod) — never committed. Auth **fails closed**: if the token isn't
configured on the server, no request authenticates.

The same-origin admin UI routes (`/api/agents`, `/api/agents/{fp}/test-print`,
status PATCH) stay unauthed — this token guards only the external enqueue paths.

## `POST /api/agents/{fingerprint}/enqueue`

Enqueue arbitrary ZPL for a target printer.

Body:

| field      | type                  | notes                                                        |
|------------|-----------------------|--------------------------------------------------------------|
| `printer`  | string (required)     | must be a printer the agent reported                         |
| `zpl`      | string (required)     | the label payload                                            |
| `encoding` | `"base64"` \| `"raw"` | default `"base64"` (decoded server-side); `"raw"` = literal ZPL starting with `^XA` |
| `source`   | string (optional)     | provenance tag stored on the job (default `external-enqueue`) |

Responses:

- `200` → `{ ok, jobId, printer, queuedAt }`
- `401` → missing / invalid bearer token
- `404` → agent not found
- `400` → bad input, agent not approved, printer not reported, or not valid ZPL

## `POST /api/buy-and-print`

Buy a real **sandbox** label in **ZPL** (thermal) format for **FedEx or UPS**,
and either enqueue it for printing or just preview it. Sandbox labels are
watermarked (FedEx **"TEST LABEL - DO NOT SHIP"**, UPS **"SAMPLE"**) — free,
non-billing.

**Carrier** is chosen by `serviceType`:

- UPS numeric service codes `01` / `02` / `03` / `12` / `13` / `59` → **UPS**
  (OAuth Basic → `/api/shipments/v2409/ship`, ZPL label).
- Anything else, e.g. `FEDEX_GROUND` / `FEDEX_*` → **FedEx** (OAuth form →
  `/ship/v1/shipments`, ZPLII label).

Both yield raw ZPL the Zebra prints, and both render the preview through the same
Labelary path.

Two **modes**, set by `mode` (default `"dispatch"`):

- `"dispatch"` — buy + enqueue the label for a target agent/printer (the print
  path). Requires `fingerprint` + a `printer` the agent reported.
- `"display"` — buy + render a **preview only**; **nothing is enqueued, nothing
  reaches any printer**. For the extension's "just show the label" mode.
  `fingerprint` / `printer` are ignored (no agent is touched).

Body:

| field         | type                         | notes                                          |
|---------------|------------------------------|------------------------------------------------|
| `mode`        | `"dispatch"` \| `"display"`  | default `"dispatch"`                           |
| `fingerprint` | string                       | required in **dispatch** mode; ignored in display |
| `printer`     | string                       | required in **dispatch** mode; must be a printer the agent reported |
| `serviceType` | string (optional)            | default `FEDEX_GROUND`; UPS codes `01/02/03/12/13/59` route to UPS |
| `shipTo`      | object (optional)            | `{ name, street, city, state, zip, country, residential, phone }` — sane default if omitted |
| `packages`    | array (optional)             | `[{ length, width, depth, weight }]` — sane default if omitted |

Responses:

- `200` (dispatch) → `{ ok, mode:"dispatch", carrier, dispatched:true, jobId, printer, queuedAt, trackingNumber, docType, previewOk, previewImage }`
- `200` (display) → `{ ok, mode:"display", carrier, dispatched:false, jobId:null, printer:null, queuedAt:null, trackingNumber, docType, previewOk, previewImage }`
  - `carrier` is `"fedex"` or `"ups"`.
  - `previewImage` is a `data:image/png;base64,…` render of the **exact ZPL** that
    was bought (rendered server-side via Labelary from the same single buy — no
    second carrier call). The extension shows this image; it never handles ZPL.
  - `previewOk` is `false` and `previewImage` is `null` if the render service was
    unreachable. In dispatch mode the **print still fired** — only the preview degrades.
- `401` (any mode, bad/no token); in **dispatch** mode also `404` (agent not found)
  / `400` (missing fingerprint or printer, agent not approved, printer not reported);
  `500` if the chosen carrier's sandbox creds aren't configured; `502` on a carrier failure.

Credentials come from env, never in the request, never logged:

- FedEx: `FEDEX_SANDBOX_API_KEY`, `FEDEX_SANDBOX_SECRET`, `FEDEX_SANDBOX_ACCOUNT`,
  optional `FEDEX_SANDBOX_OAUTH_URL` / `FEDEX_SANDBOX_SHIP_URL`.
- UPS: `UPS_SANDBOX_CLIENT_ID`, `UPS_SANDBOX_CLIENT_SECRET`, `UPS_SANDBOX_ACCOUNT`,
  optional `UPS_SANDBOX_OAUTH_URL` / `UPS_SANDBOX_SHIP_URL`.

## The job shape (what the agent polls for)

Both endpoints write to `agents/{fingerprint}/jobs`:

```json
{ "printer": "...", "zpl": "<raw ZPL ^XA...^XZ>", "status": "queued",
  "queuedAt": 0, "source": "...", "trackingNumber": "..." }
```

`/api/poll` returns queued jobs to the agent and flips them to `dispatched`.
