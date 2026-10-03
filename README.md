# GA4 MCP Server

The GA4 MCP Server is an implementation of the Model Context Protocol (MCP) that enables Large Language Models (LLMs) — specifically ClickUp Brain — to read Google Analytics 4 data directly. This implementation runs on Cloudflare Workers, providing a serverless, globally distributed MCP server.

> **Note**: This project was developed by [ContractorScale](https://contractorscale.com), mirroring the structure of the sibling `google-ads-mcp-cs` and `gsc-mcp-server` Workers so the whole Google-marketing-stack MCP fleet (Ads, Search Console, Analytics) shares one pattern.

Built for OPERATIONS-12867 — Brain had no way to pull GA4 baselines directly (Elmer had to log into GA4 manually for the JRA quiz widget deploy). This Worker closes that gap the same way Google Ads and Search Console already are: a dedicated MCP server registered as a custom connection in ClickUp Brain's App Center, not a built-in ClickUp connector (ClickUp has none for GA4).

## Features

- **GA4 Data API + Admin API integration**: read-only — properties, metadata, and reports. No mutate path exists.
- **Cloudflare Workers**: serverless deployment with global edge network.
- **SSE Support**: real-time communication with MCP clients via Server-Sent Events.
- **Streamable HTTP (MCP)**: direct `POST /mcp` endpoint for MCP clients that use HTTP transport.
- **Multi-client property resolution**: resolve a property by `url`, `domain`, or `clientSlug` against `master_clients.ga_property_id` in Supabase — the same resolver `skills/ga4-analytics` already uses in `contractor-scale-os`, so callers don't need to know raw GA4 property IDs.
- **TypeScript**: full type safety.

## Tools

| Tool | Purpose |
|---|---|
| `list_properties` | Enumerate every GA4 account/property the team principal can see |
| `get_metadata` | Valid dimensions/metrics for one property |
| `run_report` | Run one GA4 Data API report (raw `runReport` body passthrough) |
| `batch_run_reports` | Run several reports against one property in one call |
| `smoke_test` | Bounded 28-day channel/session check — confirms auth + resolution + API access |

## Getting Started

### 1. Prerequisites

- Node.js 18+ and npm
- A Cloudflare account (for deployment)
- The TEAM Google OAuth client + `GOOGLE_MARKETING_REFRESH_TOKEN` already minted for `contractor-scale-os` (see `skills/ga4-analytics/SKILL.md` there — same credential family, do not mint a separate one)
- A Supabase service-role key (read access to `master_clients`)

### 2. Clone and Install

```bash
git clone https://github.com/isaganiesteron/ga4-mcp-cs.git
cd ga4-mcp-cs
npm install
```

### 3. Configure Environment Variables

Set up credentials as Cloudflare Workers secrets:

```bash
wrangler secret put GOOGLE_CLIENT_ID_TEAM
wrangler secret put GOOGLE_CLIENT_SECRET_TEAM
wrangler secret put GOOGLE_MARKETING_REFRESH_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put API_KEY
```

Or for local development, copy `.dev.vars.example` to `.dev.vars` and fill in values.

### 4. Test Locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787
```

List tools:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Smoke test a client:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"smoke_test","arguments":{"clientSlug":"JRA Construction"}}}'
```

### 5. Deploy to Cloudflare Workers

```bash
npm run deploy
```

### 6. Register with ClickUp Brain

In ClickUp's App Center, add a custom MCP connection pointing at the deployed Worker's `/mcp` URL, authenticated with the `API_KEY` secret set above — the same way `google-ads-mcp`, `gsc-mcp-server`, and the others are registered. This step is UI-only (ClickUp's App Center / Skills Hub has no public API) and has to be done by hand.

## Credential notes

The GA4 Data API requires the `analytics.readonly` OAuth scope. Of the Google refresh tokens already in this estate's Doppler project (`cs-shared`), **only `GOOGLE_MARKETING_REFRESH_TOKEN` carries it** — `GOOGLE_REFRESH_TOKEN` (webmasters + calendar) and `GOOGLE_TEAM_REFRESH_TOKEN` (Gmail) will both 403. See `skills/ga4-analytics/SKILL.md` in `contractor-scale-os` for the full credential-pairing table and how to re-mint the token if it's ever rotated.

## Relationship to other skills

- Read-only. There is no mutate path, unlike `google-ads-mcp-cs`.
- For ad spend/clicks/conversions, use `google-ads-mcp`. For search impressions, use `gsc-mcp-server`.
- Shares its property-resolution logic and credential family with `contractor-scale-os`'s `skills/ga4-analytics` CLI script — keep both in sync if either changes.
