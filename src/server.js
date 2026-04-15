/**
 * TRMNL × Xero — Unpaid Invoices Plugin
 * 
 * This server handles:
 *  1. Xero OAuth 2.0 authorization flow
 *  2. Token refresh + persistence
 *  3. A /invoices endpoint that TRMNL polls (Webhook strategy)
 *     or you can call manually to push data via webhook
 *  4. Multi-org support via stored tenant list
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const {
  XERO_CLIENT_ID,
  XERO_CLIENT_SECRET,
  XERO_REDIRECT_URI,   // e.g. https://yourdomain.com/xero/callback
  TRMNL_WEBHOOK_URL,   // your TRMNL private plugin webhook URL
  PORT = 3000,
  TOKEN_FILE = "./tokens.json",
} = process.env;

const XERO_AUTH_URL  = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/api.xro/2.0";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.invoices.read",
  "accounting.settings.read",
  "offline_access",
].join(" ");

// ── Token Store ───────────────────────────────────────────────────────────────
// Simple file-based store.  Swap for a DB/KV store in production.
function readTokens() {
  try {
    const t = process.env.XERO_TOKENS;
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

async function writeTokens(tokens) {
  // Persist to Railway via their API
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const apiToken = process.env.RAILWAY_API_TOKEN;

  if (apiToken && projectId && serviceId && environmentId) {
    const mutation = `
      mutation {
        variableUpsert(input: {
          projectId: "${projectId}"
          serviceId: "${serviceId}"
          environmentId: "${environmentId}"
          name: "XERO_TOKENS"
          value: ${JSON.stringify(JSON.stringify(tokens))}
        })
      }
    `;
    await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ query: mutation }),
    });
  }
}

// ── OAuth Helpers ─────────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const creds = Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  return res.json();
}

async function getValidAccessToken() {
  const tokens = readTokens();
  if (!tokens.access_token) throw new Error("Not authenticated. Visit /xero/auth to connect Xero.");

  const expiresAt = tokens.expires_at || 0;
  if (Date.now() >= expiresAt - 60_000) {
    // Refresh
    console.log("Access token expired — refreshing...");
    const fresh = await refreshAccessToken(tokens.refresh_token);
    const updated = {
      ...tokens,
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + fresh.expires_in * 1000,
    };
    writeTokens(updated);
    return updated.access_token;
  }
  return tokens.access_token;
}

async function getConnections(accessToken) {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Connections fetch failed: ${await res.text()}`);
  return res.json(); // array of { tenantId, tenantName, tenantType, ... }
}

// ── Xero API ──────────────────────────────────────────────────────────────────
async function getUnpaidInvoices(accessToken, tenantId) {
  // Status=AUTHORISED covers approved invoices awaiting payment (AR)
  // Type=ACCREC = accounts receivable (sales invoices)
  const url = `${XERO_API_BASE}/Invoices?Statuses=AUTHORISED&Type=ACCREC&summaryOnly=true`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });

  if (res.status === 403) {
    return { error: "Insufficient scopes or org access denied" };
  }
  if (!res.ok) throw new Error(`Invoice fetch failed for ${tenantId}: ${await res.text()}`);

  const data = await res.json();
  const invoices = data.Invoices || [];

  const totalOwed = invoices.reduce((sum, inv) => sum + (inv.AmountDue || 0), 0);
  const overdue   = invoices.filter(inv => inv.AmountDue > 0 && new Date(inv.DueDateString) < new Date());

  return {
    count: invoices.length,
    overdue_count: overdue.length,
    total_owed: totalOwed,
    oldest_due: invoices
      .filter(inv => inv.DueDateString)
      .sort((a, b) => new Date(a.DueDateString) - new Date(b.DueDateString))
      .slice(0, 3)
      .map(inv => ({
        reference: inv.InvoiceNumber || inv.Reference || "—",
        contact: inv.Contact?.Name || "Unknown",
        amount_due: inv.AmountDue,
        due_date: inv.DueDateString,
      })),
  };
}

// ── Build TRMNL Payload ───────────────────────────────────────────────────────
async function buildPayload(selectedTenantIds = null) {
  const accessToken = await getValidAccessToken();
  const allConnections = await getConnections(accessToken);

  // Filter to requested orgs (or use all if none specified)
  const connections = selectedTenantIds
    ? allConnections.filter(c => selectedTenantIds.includes(c.tenantId))
    : allConnections.filter(c => c.tenantType === "ORGANISATION");

  if (connections.length === 0) throw new Error("No matching Xero organisations found.");

  const orgs = await Promise.all(
    connections.map(async conn => {
      const data = await getUnpaidInvoices(accessToken, conn.tenantId);
      return {
        name: conn.tenantName,
        tenant_id: conn.tenantId,
        ...data,
      };
    })
  );

  const grandTotal        = orgs.reduce((s, o) => s + (o.total_owed || 0), 0);
  const grandCount        = orgs.reduce((s, o) => s + (o.count || 0), 0);
  const grandOverdue      = orgs.reduce((s, o) => s + (o.overdue_count || 0), 0);

  return {
    orgs,
    org_count: orgs.length,
    grand_total_owed: grandTotal,
    grand_invoice_count: grandCount,
    grand_overdue_count: grandOverdue,
    generated_at: new Date().toISOString(),
    // Convenience for single-org display
    primary_org: orgs[0]?.name || "",
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// 1. Start OAuth flow
app.get("/xero/auth", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  // Persist state for CSRF check
  const tokens = readTokens();
  writeTokens({ ...tokens, oauth_state: state });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: XERO_CLIENT_ID,
    redirect_uri: XERO_REDIRECT_URI,
    scope: SCOPES,
    state,
  });

  res.redirect(`${XERO_AUTH_URL}?${params}`);
});

// 2. OAuth callback
app.get("/xero/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Xero auth error: ${error}`);

  const tokens = readTokens();
  if (state !== tokens.oauth_state) return res.status(400).send("Invalid state — possible CSRF");

  const creds = Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: XERO_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return res.status(500).send(`Token exchange failed: ${await tokenRes.text()}`);
  }

  const fresh = await tokenRes.json();
  writeTokens({
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
    oauth_state: null,
  });

  // Show connected orgs
  const connections = await getConnections(fresh.access_token);
  const orgList = connections
    .filter(c => c.tenantType === "ORGANISATION")
    .map(c => `<li><strong>${c.tenantName}</strong> — ${c.tenantId}</li>`)
    .join("");

  res.send(`
    <h2>✅ Xero connected!</h2>
    <p>Connected organisations:</p>
    <ul>${orgList}</ul>
    <p>Copy the tenant IDs above into your <code>.env</code> as <code>XERO_TENANT_IDS</code> (comma-separated) if you want to limit which orgs appear on the display.</p>
    <p>Now visit <a href="/xero/push">/xero/push</a> to send your first snapshot to TRMNL, or configure TRMNL to poll <code>/invoices</code>.</p>
  `);
});

// 3. JSON endpoint — use this as your TRMNL Polling URL
//    TRMNL will GET /invoices and merge the JSON into your markup variables
app.get("/invoices", async (req, res) => {
  try {
    const selectedIds = process.env.XERO_TENANT_IDS
      ? process.env.XERO_TENANT_IDS.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const payload = await buildPayload(selectedIds);
    res.json(payload);
  } catch (err) {
    console.error("GET /invoices error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Push to TRMNL webhook manually (or call from a cron)
app.get("/xero/push", async (req, res) => {
  if (!TRMNL_WEBHOOK_URL) {
    return res.status(400).json({ error: "TRMNL_WEBHOOK_URL not set in .env" });
  }

  try {
    const selectedIds = process.env.XERO_TENANT_IDS
      ? process.env.XERO_TENANT_IDS.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const payload = await buildPayload(selectedIds);
    const trmnlRes = await fetch(TRMNL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merge_variables: payload }),
    });

    const body = await trmnlRes.text();
    res.json({ status: trmnlRes.status, trmnl_response: body, payload });
  } catch (err) {
    console.error("Push error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. List connected tenants (useful for setup)
app.get("/xero/orgs", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const connections = await getConnections(token);
    res.json(connections.filter(c => c.tenantType === "ORGANISATION"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Xero TRMNL server running on http://localhost:${PORT}`);
  console.log(`    Authenticate:  http://localhost:${PORT}/xero/auth`);
  console.log(`    Invoice data:  http://localhost:${PORT}/invoices`);
  console.log(`    Push to TRMNL: http://localhost:${PORT}/xero/push\n`);
});
