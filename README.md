# TRMNL × Xero — Unpaid Invoices Plugin

Displays unpaid (AUTHORISED) accounts receivable invoices from one or more
Xero organisations on your TRMNL e-ink display. Shows total count, total
amount outstanding, overdue count, and a breakdown per org.

---

## What It Looks Like

**Single org:**
```
Xero · Unpaid Invoices                    Apr 14, 2:30 PM
────────────────────────────────────────────────────
  12                        $24,850.00       3 overdue
  unpaid invoices           total outstanding

  Oldest outstanding
  ──────────────────
  Acme Corp               INV-0042 · Due Apr 2     $8,400
  Beta LLC                INV-0039 · Due Apr 9     $2,200
  Gamma Inc               INV-0051 · Due Apr 12    $1,050
```

**Multi-org:**
```
Xero · Unpaid Invoices                    Apr 14, 2:30 PM
────────────────────────────────────────────────────
  19                        $41,200.00       5 overdue
  unpaid invoices           total outstanding

  Threatt Farms LLC               7    $18,350.00
  Ellis Thomas Properties         8    $14,400.00
  Threatt Rentals LLC             4    $8,450.00
```

---

## Architecture

```
Xero API ──► [ Node.js server (this repo) ] ──► TRMNL
              - OAuth 2.0 auth flow
              - Token refresh
              - Multi-tenant invoice fetch
              - Aggregation
```

TRMNL either **polls** your `/invoices` endpoint on a schedule, or you
**push** to TRMNL's webhook URL (e.g. via a cron or after data changes).

---

## Setup

### 1 · Create a Xero OAuth 2 App

1. Go to [developer.xero.com/myapps](https://developer.xero.com/myapps) → **New app**
2. Choose **Web app**
3. Set redirect URI to:
   - Local dev: `http://localhost:3000/xero/callback`
   - Production: `https://yourdomain.com/xero/callback`
4. Copy **Client ID** and **Client Secret**

Required scopes (the server requests these automatically):
- `openid profile email`
- `accounting.transactions.read`
- `accounting.settings.read`
- `offline_access` ← needed for token refresh

### 2 · Install & Configure the Server

```bash
git clone <this-repo>
cd xero-trmnl-plugin
npm install
cp .env.example .env
```

Edit `.env`:

```env
XERO_CLIENT_ID=your_client_id
XERO_CLIENT_SECRET=your_client_secret
XERO_REDIRECT_URI=http://localhost:3000/xero/callback

# Optional: your TRMNL webhook URL (for push strategy)
TRMNL_WEBHOOK_URL=https://usetrmnl.com/api/custom_plugins/XXXXXXXX

# Optional: comma-separated tenant IDs to limit which orgs show
# Leave blank to show ALL connected orgs
XERO_TENANT_IDS=

PORT=3000
```

### 3 · Authenticate with Xero

```bash
npm start
# → http://localhost:3000
```

Open `http://localhost:3000/xero/auth` in your browser. You'll be redirected
to Xero's login page. After authorising, you'll see a list of connected orgs
and their tenant IDs.

To limit which orgs appear on the display, copy the desired tenant IDs into
`XERO_TENANT_IDS` in `.env` (comma-separated), then restart the server.

### 4 · Configure TRMNL Plugin

#### Option A — Polling (recommended for always-fresh data)

1. In TRMNL, create a **Private Plugin**
2. Strategy: **Polling**
3. Polling URL: `https://yourdomain.com/invoices`
   - For local dev, use a tunnel: `npx localtunnel --port 3000`
4. Polling Verb: **GET**
5. Set your preferred refresh interval
6. Click **Edit Markup** and paste in `trmnl-markup.html`
7. Click **Force Refresh** to pull the first snapshot

#### Option B — Webhook (push on demand)

1. In TRMNL, create a **Private Plugin**
2. Strategy: **Webhook**
3. Copy the webhook URL into `TRMNL_WEBHOOK_URL` in `.env`
4. Paste `trmnl-markup.html` into the Markup editor
5. Trigger a push: `GET http://localhost:3000/xero/push`
   - Add this URL to a cron job or call it after any invoice event

### 5 · Deploy to Production

Any Node.js-compatible host works. Cheap options:

| Host | Free tier | Notes |
|------|-----------|-------|
| Railway | Yes (500 hrs/mo) | Easiest, set env vars in dashboard |
| Render | Yes (spins down) | Use polling strategy to keep awake |
| Fly.io | Yes | Best for always-on |
| PythonAnywhere | No (JS only via node) | — |
| Cloudflare Workers | Yes | Needs rewrite (no file system) |

For Railway/Render: push the repo, set env vars, and your polling URL will be
`https://your-app.railway.app/invoices`.

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /xero/auth` | Start OAuth flow |
| `GET /xero/callback` | OAuth callback (configure in Xero portal) |
| `GET /xero/orgs` | List connected organisations + tenant IDs |
| `GET /invoices` | JSON invoice summary — use as TRMNL Polling URL |
| `GET /xero/push` | Push current data to TRMNL webhook |

### Sample `/invoices` response

```json
{
  "orgs": [
    {
      "name": "Threatt Farms LLC",
      "tenant_id": "abc-123",
      "count": 7,
      "overdue_count": 2,
      "total_owed": 18350.00,
      "oldest_due": [
        {
          "reference": "INV-0042",
          "contact": "Acme Corp",
          "amount_due": 8400.00,
          "due_date": "2026-04-02"
        }
      ]
    }
  ],
  "org_count": 1,
  "grand_invoice_count": 7,
  "grand_overdue_count": 2,
  "grand_total_owed": 18350.00,
  "generated_at": "2026-04-14T14:30:00.000Z",
  "primary_org": "Threatt Farms LLC"
}
```

---

## TRMNL Markup Variables

| Variable | Type | Description |
|----------|------|-------------|
| `grand_invoice_count` | int | Total unpaid invoices across all orgs |
| `grand_overdue_count` | int | Invoices past due date |
| `grand_total_owed` | float | Total $ outstanding |
| `org_count` | int | Number of connected orgs displayed |
| `orgs` | array | Per-org data (see below) |
| `orgs[n].name` | string | Organisation name |
| `orgs[n].count` | int | Unpaid invoice count |
| `orgs[n].overdue_count` | int | Overdue count |
| `orgs[n].total_owed` | float | $ outstanding |
| `orgs[n].oldest_due` | array | Up to 3 oldest unpaid invoices |
| `generated_at` | ISO string | Snapshot timestamp |

---

## Notes & Gotchas

- **Token storage**: Tokens are written to `tokens.json`. Keep this file
  out of version control (it's in `.gitignore`). In production, replace
  `readTokens`/`writeTokens` with a database or secrets manager.

- **Xero rate limits**: The standard app tier allows 60 requests/minute and
  5,000/day. With multiple orgs, each call costs 1 request per org.
  For > 10 orgs, stagger refresh intervals.

- **Invoice status**: Only `AUTHORISED` invoices of type `ACCREC`
  (accounts receivable / sales invoices) are counted. `DRAFT` and `SUBMITTED`
  invoices are excluded. Adjust the `Statuses` query param in `getUnpaidInvoices`
  if you want bills (ACCPAY) or a different status mix.

- **Currency**: All amounts are returned in the org's base currency.
  For multi-currency orgs, `AmountDue` is in the invoice currency, not converted.
  The grand total will be a mixed-currency sum if your invoices span currencies.

- **Re-authentication**: Access tokens last 30 minutes; refresh tokens last
  60 days. If a refresh token expires (user didn't push data for 60 days),
  re-visit `/xero/auth`.
