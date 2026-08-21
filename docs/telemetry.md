# Product telemetry

Malloyyo sends a small, fixed set of server-side product-usage events to one
Malloyyo-owned PostHog Cloud US project. This tells the maintainers which product paths
are useful; it is best-effort analytics, not billing or contractual metering. PostHog's
project token is public configuration with no dashboard or administrative access, so
events can be spoofed.

Self-hosted telemetry is on by default. Set `MALLOYYO_TELEMETRY_DISABLED=1` to turn it
off completely. To inspect the sanitized payloads without sending them, set
`MALLOYYO_TELEMETRY_DEBUG=1`; debug mode prints one `telemetry.debug` JSON record per
event. Malloyyo-hosted instances are identified by `MALLOYYO_TENANT_ID` and ignore both
variables. The hosted control plane owns that value and `MALLOYYO_ACCOUNT_ID`.

This product telemetry is separate from `ANALYTICS_ID`, the optional GA4 integration
owned by whoever deploys the instance.

## Identity and privacy

Each self-hosted instance gets a random UUID in its existing `instance_settings` row.
Hosted events use the immutable tenant ID as `instance_id`; self-hosted events use that
UUID. Hosted `account_id` is the opaque registry account that may own several instances.
Signed-in actor IDs are `SHA-256(telemetry_id + ":" + local_user_id)`. Raw local user IDs
never leave the instance, and the hash is intentionally different on another instance.
Anonymous events use the instance ID.

Every event also has `app_version`, `deployment` (`hosted` or `self_hosted`),
`instance_id`, optional `account_id`, and `$process_person_profile: false`. PostHog is
configured with US ingestion and geolocation disabled. There is no browser PostHog SDK,
cookie, autocapture, cross-domain identity, person profile, session replay, query text,
SQL, result data, URL, hostname, email, or raw identifier.

## Event allowlist

| Event | Allowed event-specific properties |
| --- | --- |
| `query ran` | `entrypoint` (`mcp`, `ltool`, `dashboard`), `outcome`, `duration_ms`, `author_kind`, allowlisted `client_family` |
| `page viewed` | normalized `page`, `authenticated` |
| `user signed in` | `auth_mode`, `first_login` |
| `model published` | `method`, `outcome`, `created_dataset`, `source_count`, `file_count`, `dashboard_count` |
| `dataset removed` | none |
| `query saved` | `entrypoint` (`ltool`) |
| `query favorite changed` | resulting `favorited` boolean |
| `mcp tool called` | allowlisted `tool`, `outcome` |

`query ran` is the primary event. It is emitted once after every successful or failed
MCP, ltool, and dashboard execution. MCP validation (`execute=false`) is excluded.
Non-query MCP tool names collapse to an allowlist, with unknown names reported as
`other`. Page paths are reduced to templates such as `/datasets/:id`,
`/datasets/:id/dashboard/:name`, and `/ltool/:slug`; query strings and dynamic values are
discarded.

The TypeScript `TelemetryEvent` union in `src/lib/telemetry.ts` owns this allowlist. Add a
property there, to this document, and to the privacy review together. Do not add row
counts, query text, Malloy, SQL, results, questions, customer names, dataset/model/source
identifiers, URLs, email, hostnames, raw user IDs, or raw user agents.

## Maintainer setup and verification

The official `posthog-node` SDK sends directly to `https://us.i.posthog.com` using the
public project token compiled into the server-only telemetry module. In the PostHog
project, disable IP/geolocation capture, autocapture, session replay, and person
profiles; set a hard monthly billing cap; and do not enable paid Group Analytics. Use
ordinary `instance_id` and `account_id` event properties.

Before release, run the opt-in production-adapter smoke with disposable staging IDs:

```bash
MALLOYYO_TELEMETRY_SMOKE=1 \
MALLOYYO_TENANT_ID=telemetry-smoke-instance \
MALLOYYO_ACCOUNT_ID=telemetry-smoke-account \
npm run smoke:telemetry
```

Confirm in PostHog that the event has only the documented properties, the two staging
IDs, US ingestion, and no IP-derived properties. Initial insights should cover query
count/success/duration/entrypoint, active actors per instance/account, page and
login→publish→query conversion, and publish/MCP/save/favorite use.

Provider references: [Node SDK](https://posthog.com/docs/libraries/node),
[capturing events](https://posthog.com/docs/product-analytics/capture-events), and
[Group Analytics](https://posthog.com/docs/product-analytics/group-analytics).
