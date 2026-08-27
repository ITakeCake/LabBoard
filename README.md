# LabBoard: receive-only fleet telemetry for LabLifter

LabBoard is the **telemetry half** of a lab-deployment system: a Cloudflare Worker that
accepts append-only observations from deployment sticks, and a password-gated Cloudflare
Pages dashboard that folds those observations into a live picture of a machine fleet.

The other half, the Windows GUI that actually installs software, the app catalogue, the
room profiles, the hostname decoder and the assignment ledger, lives in the companion
**[LabLifter](https://github.com/ITakeCake/LabLifter)** repo. That half has all the authority. This half has none, on purpose.

```
labboard/
├── api/                     Worker "labboard-api", the ingest API (D1 + optional R2)
│   ├── src/index.js           POST /obs /log /rooms /marks /config /mark-request, GET /health
│   ├── schema.sql             D1 tables: observations, tokens, logs, rooms, marks, config_kv, alerts
│   └── migrations/            incremental DDL applied after the initial schema
├── pages/                   Pages "labboard", the Basic-Auth dashboard
│   ├── functions/_middleware.js   the auth gate + the pause switch
│   ├── functions/api/_fleetfold.js  the pure fold (unit-tested, no D1)
│   ├── functions/api/*.js         read-only JSON endpoints the dashboard calls
│   └── public/index.html          the dashboard itself
├── tests/                   plain `node` unit tests, no cloud, no D1, no network
└── provision-tokens.ps1     mint per-stick tokens, register their hashes, write tokens.json
```

---

## The security model: receive-only

This is the part worth reading. The two planes never touch:

| | Config plane (LabLifter GUI) | Telemetry plane (this repo) |
|---|---|---|
| Carries | app cards, installers, profiles, secrets | observations about the past |
| Travels by | physical USB sync | HTTPS to Cloudflare |
| Authority | total | **none** |

**The server cannot command a client.** There is no route that returns an instruction, a
script, a path, a package, or a config value that any deployment client executes. The
Worker's entire verb set is *append a fact* and *read a fact back*. A total compromise of
this Cloudflare account gets an attacker a **wrong dashboard**: never an install, never
code execution on a lab machine.

Three properties keep that true:

1. **Everything flows up.** Sticks POST observations. Nothing is pushed down to them.
2. **The one downward channel is five words, and it is pulled.** The master polls
   `GET /mark-requests` and receives request-edits whose `state` is one of exactly
   `verified | override | missing | broken | clear`. That is the whole vocabulary, five
   status words describing a machine, enforced by a server-side whitelist
   (`MARK_REQ_STATES`). There is no sixth word to smuggle a payload into, and the master
   asks for them rather than being told.
3. **Config keys are display data.** The master mirrors some of its own config here
   (`CONFIG_KEYS`: `years`, `whitelist`, `buildings`, `needsopen`, `health_excluded`,
   `assignments`). The Worker stores each as an opaque JSON blob and never interprets it;
   the dashboard reads them to decide what to *draw*. Widening that whitelist cannot widen
   what the server can do to a machine, because no client ever reads these back as orders.

Supporting details:

- **Tokens are hashed.** The server stores only `SHA-256(token)`. A token can append and
  read; it cannot delete, and it cannot touch config on the LabLifter side. Revoke with
  `UPDATE tokens SET enabled=0 WHERE stick_id=...`.
- **The dashboard cannot write config.** `functions/_middleware.js` 405s every non-GET
  except `/api/admin/*`, which is behind the same Basic Auth plus an `Origin` check and a
  custom-header CSRF guard. "The site can never push config" is structural, not a policy.
- **Identity on mark-requests is self-reported**, and deliberately so: it is routing, not
  permission. A wrong assertion self-heals the next time a stick actually sees the machine
  (see *newest-sighting-wins*, below).
### newest-sighting-wins

The load-bearing rule, in `pages/functions/api/_fleetfold.js`: a human assertion overrides a
machine's observed colour **only if its timestamp is at or after that machine's newest
observation**. If a stick has seen the machine since somebody marked it, the live evidence
wins. Reality always gets the last word. The fold is a pure function with no D1 dependency
precisely so this rule can be unit-tested, see `tests/test-fleetfold.mjs`.

---

## Deploying it

Requires `wrangler` and an authenticated Cloudflare account. Run from `api/` unless noted.

```powershell
# 1. Create the D1 database
wrangler d1 create labboard
#    Copy the printed database_id and paste it into BOTH files, replacing
#    "REPLACE-AFTER-wrangler-d1-create":
#        api/wrangler.toml       database_id = "..."
#        pages/wrangler.toml     database_id = "..."

# 2. Create the tables in the cloud DB, then apply the migrations in date order
wrangler d1 execute labboard --remote --file=schema.sql
Get-ChildItem migrations\*.sql | Sort-Object Name | ForEach-Object {
    wrangler d1 execute labboard --remote --file=$_.FullName
}

# 3. Deploy the Worker: prints https://labboard-api.<your-subdomain>.workers.dev
wrangler deploy

# 4. Point the clients at it: in the LabLifter repo, edit config\telemetry.json and
#    replace REPLACE in obsUrl / logUrl with the subdomain from step 3.
#    While the URL still says REPLACE, every push is a safe no-op.

# 5. Mint tokens (master + every stick in the ledger) and register their hashes
cd ..
.\provision-tokens.ps1 -LabRoot <path-to-your-LabDeploy-folder>

# 6. SET THE DASHBOARD PASSWORD **BEFORE** THE FIRST DEPLOY (see the warning below)
wrangler pages secret put DASH_PASSWORD --project-name labboard

# 7. Deploy the dashboard
cd pages
wrangler pages deploy public
```

> **Deploy the gate before the content.** Pages keeps every deployment on a permanent
> hash URL forever. Never `wrangler pages deploy` real fleet data before `DASH_PASSWORD`
> is set. If the secret is unset the middleware fails **closed** (503 for everyone) rather
> than open, but a deployment made while it was unset stays reachable at its hash URL.

Optional, for real-time anomaly pings to Discord or Slack:

```powershell
wrangler secret put ALERT_WEBHOOK --name labboard-api
```

Anomalies (NaN/Infinity/out-of-bounds numbers, mostly-invalid batches, rate trips,
oversized logs) are written to the `alerts` table, `console.error`'d, and shown as a red
banner on the dashboard whether or not a webhook is configured.

### Is HTTPS even reachable from a lab machine?

`GET /health` needs no token and returns no data, it exists only to answer that:

```powershell
try { Invoke-RestMethod "https://labboard-api.<your-subdomain>.workers.dev/health" -TimeoutSec 10 }
catch { "FAILED: " + $_.Exception.Message }
```

A timeout, cert error, or proxy error means the network is filtering `workers.dev`. Bind a
custom domain to the same Worker (DNS only, no code change) and update `telemetry.json`.

### Token provisioning

`provision-tokens.ps1` mints one token per stick, registers `SHA-256(token)` in the D1
`tokens` table, and writes the raw tokens into LabLifter's `config\tokens.json` (which is
gitignored on that side and ships to sticks like any other config file). It is idempotent:
an existing real token for a drive is reused and its hash re-registered.

```powershell
.\provision-tokens.ps1 -LabRoot D:\LabLifter                       # master + every stick in the ledger
.\provision-tokens.ps1 -LabRoot D:\LabLifter -LocalOnly            # register in the LOCAL dev D1 instead
.\provision-tokens.ps1 -DriveId <guid> -Label 'LabDeploy-07'       # just one drive
```

Set `LABDEPLOY_ROOT` once as an environment variable and you can drop `-LabRoot`. The
Worker folder defaults to the `api\` directory next to the script, so a fresh clone needs
no editing.

### Local testing, no cloud

```powershell
cd api;   wrangler d1 execute labboard --local --file=schema.sql;  wrangler dev --local
cd pages; wrangler pages dev        # needs a .dev.vars holding DASH_PASSWORD=<anything>
```

`.dev.vars` is deliberately absent from this repo and gitignored, even a dummy value
stays out. The unit tests need none of this:

```bash
node tests/test-fleetfold.mjs
node tests/test-throughput.mjs
```

---

## The pause switch (404 kill-switch)

Both halves carry a `PAUSED` constant, `pages/functions/_middleware.js` and
`api/src/index.js`. Set either to `true` and redeploy, and that service answers a **bare
404** to everyone, before authentication.

A 404 and not a 503, deliberately: a paused site should look like nothing was ever here.
No product name, no "maintenance", no hint that an endpoint exists to come back to.

Nothing is destroyed by pausing. D1, the tokens, the secrets and every past deployment stay
intact; flip the flag back and redeploy to resume. Pausing the two services is independent
- you can take the dashboard dark while the Worker keeps ingesting.

**Pausing is safe on the client side by design.** A failed push never advances a stick's
push cursor, so session logs simply queue locally and backfill on the first successful push
after the Worker comes back. Nothing observed while paused is lost.

---

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | reachability probe, returns no data |
| `POST /obs` | Bearer token | append observations (idempotent by `obs_id`) |
| `POST /log` | Bearer token | store one failed-install log in R2 |
| `GET /log/:id` | Bearer token | fetch a log blob |
| `POST /rooms` | Bearer token | upsert the room roster (master) |
| `POST /marks` | Bearer token | full-replace the tech marks (master) |
| `POST /config` | Bearer token | mirror a whitelisted config key (master) |
| `POST /mark-request` | Bearer token | a whitelisted user asks to set a machine's state |
| `GET /mark-requests` | Bearer token | the master pulls applied request-edits |
| `POST /audit` | none, rate-limited | experimental software-audit form submissions |
| dashboard `/` and `/api/*` | Basic Auth | the human dashboard |

---

## Placing machines: hostname decoding, then the ledger

By default a machine's room and number are read out of its own hostname, leading digits
are the room key, the trailing `-NN` is the machine number. A fleet that doesn't follow a
naming scheme decodes to nothing and would simply never appear on the board.

The fix is the **assignment ledger**: a person places those machines on the master (Rooms &
Rules → Machines), and the master mirrors that ledger here as the config key `assignments`.
A ledger entry beats the decoder, because assignment is a human decision and evidence
should not silently renumber somebody's room.

The master pushes it exactly like any other config key:

```
POST https://labboard-api.<subdomain>.workers.dev/config
Authorization: Bearer <stick-token>
Content-Type: application/json

{ "config": [ { "key": "assignments", "value": {
    "rooms": {
      "LAB-A": { "startAt": 1, "high": 12, "abbr": "ANNEX" }
    },
    "machines": {
      "FRONTDESK-PC":    { "room": "LAB-A", "num": 2,    "assignedAt": "2026-08-20 09:00:00", "retired": false },
      "Lab-Laptop-Blue": { "room": "LAB-A", "num": null, "assignedAt": "2026-08-20 09:02:00", "retired": false }
    } } } ] }
```

That `value` is the master's `config\machine-assignments.json` pushed verbatim, the same
file the GUI already authors, no reshaping needed. How the fold reads it:

- **`room`** places the machine's tile, overriding whatever its hostname would have said.
- **`num`** numbers the tile. Gaps below it stay visible as untouched slots, so a freed
  number never silently collapses the room.
- **`num: null`** (or absent) means unnumbered: the machine is appended *after* the room's
  numbered range, sorted alphabetically by hostname. Those tiles render as `?` rather than
  the position they happen to occupy, because nobody assigned them that number.
- **`retired: true`** is treated as no assignment at all, which drops the machine off the
  board.
- **`rooms.<key>.abbr`** is an optional display label for a room that exists only in the
  ledger and so has no roster row to take a building abbreviation from.

Anything malformed is ignored rather than thrown, a broken ledger degrades to plain
hostname decoding and never takes the dashboard down. `assignments` is the one config blob
that scales with fleet size, so it carries a larger size cap than the small label blobs.

**A machine that is neither decodable nor in the ledger is still not drawn.** That is the
intended behaviour: the ledger is how a machine gets a place, and placing it is a person's
call.

---

## Logging

Every Worker step emits one JSON line, watch it live with `wrangler tail` from `api/`, or
in the Cloudflare Observability tab. On the client side the GUI logs each push step into
the session log: `telemetry.push_start`, `telemetry.file_encoded`, `telemetry.log_pushed`,
`telemetry.deadline_hit`, `telemetry.push_skipped`, `telemetry.cursor_saved`,
`telemetry.anomaly`, `telemetry.post_failed`, `telemetry.push_failed`.

## Licence

MIT, see [LICENSE](LICENSE).
