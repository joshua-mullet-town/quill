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

Buy a real **FedEx sandbox** label in ZPLII (thermal) format and enqueue it in
one shot. Sandbox labels are watermarked **"TEST LABEL - DO NOT SHIP"** — a free,
non-billing proof of the full path.

Body:

| field         | type              | notes                                          |
|---------------|-------------------|------------------------------------------------|
| `fingerprint` | string (required) | target agent                                   |
| `printer`     | string (required) | must be a printer the agent reported           |
| `serviceType` | string (optional) | default `FEDEX_GROUND`                          |
| `shipTo`      | object (optional) | `{ name, street, city, state, zip, country, residential, phone }` — sane default if omitted |
| `packages`    | array (optional)  | `[{ length, width, depth, weight }]` — sane default if omitted |

Responses:

- `200` → `{ ok, jobId, printer, queuedAt, trackingNumber, docType }`
- `401` / `404` / `400` as above; `500` if FedEx sandbox creds aren't configured;
  `502` on a carrier failure.

FedEx credentials come from env (`FEDEX_SANDBOX_API_KEY`, `FEDEX_SANDBOX_SECRET`,
`FEDEX_SANDBOX_ACCOUNT`, optional `FEDEX_SANDBOX_OAUTH_URL` / `FEDEX_SANDBOX_SHIP_URL`)
— never in the request, never logged.

## The job shape (what the agent polls for)

Both endpoints write to `agents/{fingerprint}/jobs`:

```json
{ "printer": "...", "zpl": "<raw ZPL ^XA...^XZ>", "status": "queued",
  "queuedAt": 0, "source": "...", "trackingNumber": "..." }
```

`/api/poll` returns queued jobs to the agent and flips them to `dispatched`.
