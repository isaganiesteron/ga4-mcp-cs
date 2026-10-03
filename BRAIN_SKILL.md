# GA4 MCP — Brain Skill

## Your Role

You have access to a Google Analytics 4 (GA4) MCP server. Use it to answer traffic, channel, conversion, and landing-page questions for Contractor Scale's clients — read-only, no mutate path exists.

---

## Critical Conventions

| Rule | Detail |
|---|---|
| **Resolve the property first** | Pass exactly one of `url`, `domain`, `clientSlug`, or `property` on every tool except `list_properties`. |
| **`keyEvents`, not `conversions`** | GA4 renamed the `conversions` metric to `keyEvents`. Using `conversions` fails on most properties. |
| **Dates** | `YYYY-MM-DD`, or GA4's relative forms: `today`, `NdaysAgo`. |
| **`report` is a passthrough** | `run_report`'s `report` argument is the literal GA4 Data API `runReport` body — dateRanges, dimensions, metrics, orderBys, limit, dimensionFilter. Build it the way you'd build any GA4 Data API request. |
| **Zero sessions ≠ zero traffic** | A report returning all zeros is more often a tracking break than a real decline. Run `smoke_test` or check `list_properties` before reporting a drop. |
| **Only ~1/3 of clients have a property mapped** | A resolution failure usually means `master_clients.ga_property_id` is empty for that client, not that the client lacks GA4. Report it as a data gap — don't guess a property ID. |

---

## Workflow Patterns

### Before anything else
If you don't know the client's exact name as stored in `master_clients`, or the property resolution keeps failing, run `list_properties` to see what's actually visible.

### Diagnosing a reported GA4 problem
1. `smoke_test` with the client's selector — confirms auth, resolution, and API access all work.
2. If it returns zero sessions, check `get_metadata` for the property before concluding there's a tracking break — a dimension/metric typo can also zero out a report.

### Building a channel performance report
```json
{
  "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
  "dimensions": [{"name": "sessionDefaultChannelGroup"}],
  "metrics": [
    {"name": "sessions"},
    {"name": "totalUsers"},
    {"name": "engagedSessions"},
    {"name": "keyEvents"}
  ],
  "orderBys": [{"metric": {"metricName": "sessions"}, "desc": true}]
}
```

### Month-over-month comparison
Two date ranges in one request — GA4 returns a `dateRange` dimension automatically:
```json
{
  "dateRanges": [
    {"startDate": "30daysAgo", "endDate": "today", "name": "current"},
    {"startDate": "60daysAgo", "endDate": "31daysAgo", "name": "previous"}
  ],
  "dimensions": [{"name": "sessionDefaultChannelGroup"}],
  "metrics": [{"name": "sessions"}, {"name": "keyEvents"}]
}
```

### Top landing pages
```json
{
  "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
  "dimensions": [{"name": "landingPagePlusQueryString"}],
  "metrics": [{"name": "sessions"}, {"name": "engagementRate"}, {"name": "keyEvents"}],
  "orderBys": [{"metric": {"metricName": "sessions"}, "desc": true}],
  "limit": "50"
}
```

---

## Tools Quick Reference

| Tool | When to use |
|---|---|
| `list_properties` | Find a property when selector resolution fails, or audit what's visible |
| `get_metadata` | Check valid dimensions/metrics before building an unfamiliar report |
| `run_report` | Single report — the default for most questions |
| `batch_run_reports` | Several reports against the same property in one call |
| `smoke_test` | Verify a property works before trusting a bigger report, or diagnose a reported failure |

---

## Gotchas

- **One property, one client** — don't mix two clients' data in a single report; resolve per-client each time.
- **No write path** — if asked to change GA4 configuration (goals, key events, data retention), say so; this server can't do it.
- **403 with "insufficient scopes"** — this is a credential problem on our side, not a per-property access problem. Report it rather than retrying.
- **403 "access"** — this means team@contractorscale.com genuinely lacks Viewer/Analyst on that specific property. Different fix (grant access in GA4 Admin), different owner.
