# IPv6 Subnet Proxy

[English](README.md) | [中文](README_zh.md)

A Node.js TypeScript SOCKS5 proxy that distributes outbound connections across different IPv6 addresses from managed `/64` subnets. Includes a REST management API, SQLite-backed persistence, per-user rate limiting, traffic accounting, and audit logging.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [SOCKS5 Proxy Usage](#socks5-proxy-usage)
- [Reaching IPv4-Only Names](#reaching-ipv4-only-names)
- [REST API Reference](#rest-api-reference)
  - [Health](#health)
  - [Users](#users)
  - [Subnets](#subnets)
  - [Bindings](#bindings)
  - [Sessions](#sessions)
  - [Traffic](#traffic)
  - [Rate Limits](#rate-limits)
  - [Audit Logs](#audit-logs)
  - [Resolver](#resolver)
- [Data Model](#data-model)
- [Rate Limiting](#rate-limiting)
- [Development](#development)
- [Docker](#docker)
- [CI/CD](#cicd)

---

## Features

- **SOCKS5 with Password Auth** — Full RFC 1928 (SOCKS5) and RFC 1929 (Username/Password) support. Only CONNECT command; BIND and UDP ASSOCIATE are rejected.
- **Auto-Detect Subnets** — IPv6 subnets are automatically detected from host network interfaces on startup; no manual configuration needed
- **Per-User IPv6 Allocation** — Two modes: `sticky` (same IPv6 address is reused for each user+subnet pair) and `random` (new address per connection, default)
- **CDN Edge Borrowing** — Sites that publish no AAAA record are still reached over IPv6 through their CDN's dual-stack edge fleet, verified by certificate before use. See [Reaching IPv4-Only Names](#reaching-ipv4-only-names).
- **Auto-Binding** — Users are automatically bound to all active subnets on creation
- **Multi-Subnet Management** — Manage multiple `/64` (or any prefix length) subnets, bind any subset to each user
- **REST Management API** — Full CRUD for users, subnets, and bindings; query active sessions, traffic stats, audit logs; manage rate limits.
- **Rate Limiting** — Per-user connection count limit and token-bucket bandwidth throttling.
- **Traffic Accounting** — Per-user, per-day byte counters (bytes in / out).
- **Audit Logging** — All management actions are recorded with timestamps and actor information.
- **Docker Multi-Arch** — `linux/amd64` and `linux/arm64` images published to GHCR.
- **SQLite Persistence** — WAL-mode SQLite database stored on a persistent volume.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   IPv6 Subnet Proxy                       │
│                                                           │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  SOCKS5   │    │         Fastify API (port 3000)   │    │
│  │  Server   │    │  ┌─────┐ ┌──────┐ ┌──────────┐  │    │
│  │ (port 1080)│    │  │Users│ │Subnet│ │Sessions  │  │    │
│  │           │    │  │Route│ │Route │ │Route     │  │    │
│  │  Auth     │    │  └─────┘ └──────┘ └──────────┘  │    │
│  │  (RFC1929)│    │  ┌──────┐ ┌──────┐ ┌────────┐  │    │
│  │           │    │  │Traffic│ │Limits│ │Audit   │  │    │
│  │  Connect  │    │  │Route │ │Route │ │Route   │  │    │
│  │  Handler  │    │  └──────┘ └──────┘ └────────┘  │    │
│  └─────┬─────┘    └──────────────────────────────────┘    │
│        │                        │                          │
│        └──────────┬─────────────┘                          │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │    Core Modules      │                             │
│        │  ┌──────────────┐   │                             │
│        │  │ IP Allocator │   │                             │
│        │  │  (sticky/    │   │                             │
│        │  │   random)    │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  UserManager │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ SubnetManager│   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  RateLimiter │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ TrafficStats │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ AuditLogger  │   │                             │
│        │  └──────────────┘   │                             │
│        └──────────┬──────────┘                             │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │   SQLite (WAL mode) │                             │
│        │   /data/proxy.db    │                             │
│        └─────────────────────┘                             │
└──────────────────────────────────────────────────────────┘

         ┌──────┐     SOCKS5        ┌────────────┐
         │Client│◄─────────────────►│  Target    │
         │      │   (IPv6 bind)     │  Server    │
         └──────┘                   └────────────┘
```

The application is a single process hosting two servers:

- **SOCKS5 server** on port `1080` — accepts client connections, authenticates via username/password, allocates an IPv6 address from the user's bound subnets, and relays traffic.
- **REST API server** on port `3000` — Fastify-based HTTP API for management. All endpoints (except `/health`) require `X-API-Key` header authentication.

Both servers share the same core modules and SQLite database.

---

## Quick Start

### Prerequisites

- Linux with IPv6 enabled and `net.ipv6.ip_nonlocal_bind=1`
- Node.js 20+ (for manual deployment)
- Docker (for container deployment)

### Docker (recommended)

```bash
# Clone the repository
git clone https://github.com/your-username/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# Edit docker-compose.yml to set API_KEY and DEFAULT_SUBNET
# Then start
docker compose -f docker/docker-compose.yml up -d
```

### Manual

```bash
# Clone and install
git clone https://github.com/your-username/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy
npm install
npm run build

# Set required API key (subnets are auto-detected from host interfaces)
export API_KEY=your-secret-api-key

# Optional: manually specify a subnet if auto-detection fails
export DEFAULT_SUBNET=2001:db8:1::/64

# Start
npm start
```

On startup, the program auto-detects IPv6 subnets from the host's network interfaces. You'll see log lines like:
```
info: Auto-registered detected IPv6 subnet { cidr: "2001:db8:1::/64" }
```

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Create a user — all active subnets are automatically bound
curl -X POST http://localhost:3000/api/v1/users \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret123"}'
```

Users are automatically bound to all registered subnets on creation — no manual binding needed. You can still manage subnets and bindings via the API for advanced use cases.

# Add a subnet
curl -X POST http://localhost:3000/api/v1/subnets \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"cidr": "2001:db8:1::/64"}'

# Bind user to subnet
curl -X POST http://localhost:3000/api/v1/users/<USER_ID>/bindings \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"subnet_id": "<SUBNET_ID>"}'
```

Now use SOCKS5 proxy at `localhost:1080` with username `alice` and password `secret123`.

---

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | _(required)_ | API key for REST API authentication |
| `SOCKS5_PORT` | `1080` | SOCKS5 proxy listen port |
| `API_PORT` | `3000` | REST API listen port |
| `API_HOST` | `0.0.0.0` | REST API bind address |
| `DB_PATH` | `/data/proxy.db` | SQLite database file path |
| `DEFAULT_SUBNET` | — | Automatically register a subnet on startup (CIDR notation) |
| `DEFAULT_SUBNET_GATEWAY` | — | Gateway address for the default subnet |
| `BCRYPT_ROUNDS` | `10` | bcrypt hash rounds for password hashing |
| `LOG_LEVEL` | `info` | Logging level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

### IPv6 Fallback

These control how the proxy reaches names that publish no AAAA record. Defaults are sensible; most deployments need none of them. See [Reaching IPv4-Only Names](#reaching-ipv4-only-names).

| Variable | Default | Description |
|---|---|---|
| `CDN_FALLBACK_ENABLED` | `true` | Enable the fallback ladder. When `false`, names without AAAA simply fail |
| `CDN_FALLBACK_VERIFY` | `true` | Verify a borrowed edge with a TLS handshake before using it. Turning this off is faster but can surface certificate errors to clients |
| `CDN_FALLBACK_PORTS` | `80,443` | Ports on which borrowing is allowed. CDN edges do not listen on arbitrary ports |
| `CDN_FALLBACK_EDGES` | — | Pin known-good edges: `cloudfront=2600:9000::1,2600:9000::2;fastly=2a04:4e42::1`. A bare comma-separated list is used for any provider |
| `CDN_FALLBACK_RESOLVERS` | _(system)_ | DNS servers for fallback lookups, e.g. `1.1.1.1,8.8.8.8`. Useful when the local resolver strips AAAA records |
| `CDN_FALLBACK_PROBE_ALL` | `true` | When the CDN cannot be identified, probe edges from every known pool |
| `CDN_FALLBACK_LEARN` | `true` | Remember edge addresses observed on dual-stack hosts of a known CDN, keeping the borrow pool fresh from real traffic |
| `CDN_FALLBACK_MAX_PROBES` | `6` | Upper bound on verification probes per target |
| `CDN_FALLBACK_PROBE_TIMEOUT_MS` | `5000` | Per-probe timeout |
| `CDN_FALLBACK_DNS_TIMEOUT_MS` | `3000` | Per-query DNS timeout |
| `CDN_FALLBACK_TTL_MS` | `600000` | How long a successful route is cached (10 min) |
| `CDN_FALLBACK_NEGATIVE_TTL_MS` | `60000` | How long a failure is cached (1 min) |
| `CDN_FALLBACK_EDGE_TTL_MS` | `1800000` | How long a harvested edge pool stays valid (30 min) |
| `CDN_FALLBACK_CACHE_MAX` | `4096` | Maximum cached routes |
| `NAT64_PREFIX` | — | Opt-in NAT64 `/96` prefix (e.g. `64:ff9b::/96`) for IPv4-only targets. Requires a reachable NAT64 gateway |

---

## SOCKS5 Proxy Usage

Configure any SOCKS5 client with:

- **Address**: proxy server IP or hostname
- **Port**: `1080` (or custom `SOCKS5_PORT`)
- **Protocol**: SOCKS5
- **Authentication**: Username / Password
- **Username**: the username of a created user
- **Password**: the corresponding password

The proxy only supports TCP CONNECT. BIND and UDP ASSOCIATE requests are rejected with `0x07` (Command not supported).

### Per-User Address Modes

Users operate in one of two IPv6 allocation modes:

- **random** (default): Each connection receives a new random IPv6 address from the assigned subnet.
- **sticky**: Each user+subnet pair receives a fixed IPv6 address. The address persists across reconnections until explicitly refreshed via `POST /users/:id/refresh`.
- **random**: A new random IPv6 address from the subnet is generated for every connection.

### IPv6 Kernel Requirement

The host must have `net.ipv6.ip_nonlocal_bind=1` to allow binding to IPv6 addresses that are not assigned to any local interface:

```bash
sysctl -w net.ipv6.ip_nonlocal_bind=1
```

To make this permanent, add `net.ipv6.ip_nonlocal_bind=1` to `/etc/sysctl.conf` or `/etc/sysctl.d/99-ipv6.conf`.

---

## Reaching IPv4-Only Names

An IPv6-only egress can normally only reach names that publish an AAAA record. That rules out a large part of the web — but far less of it than DNS suggests.

Most of those sites sit behind an anycast CDN. A CDN edge is dual-stack and picks the origin from the TLS SNI or the HTTP `Host` header, not from the destination IP, so **it will serve a site over IPv6 whether or not that site publishes an AAAA record**. Publishing IPv6 in DNS is a per-customer toggle; being reachable over IPv6 is a property of the edge fleet. The proxy exploits that gap.

Because a SOCKS5 relay is transparent at the TCP layer, the client's own SNI and `Host` header pass through untouched. Only the destination address changes.

### The ladder

On every CONNECT the target is resolved through these rungs, and the first that works wins:

| Rung | How it works |
|---|---|
| `native` | The name publishes its own AAAA records. Used directly, no probing. |
| `dualstack` | `dualstack.<cname-hop>` has AAAA. Fastly, Akamai, AWS ELB and CloudFront all publish this variant — same CDN, same mapping, just its IPv6 view. Highest fidelity borrow. |
| `cdn-borrow` | The CDN is identified from the CNAME chain, or from the PTR record of the target's IPv4 address, and a borrowed edge of that same CDN is used. |
| `nat64` | An address synthesized from `NAT64_PREFIX`. Off unless configured. |

### Verification

A borrow is never used on trust. Before committing to an edge, the proxy completes a TLS handshake against it with SNI set to the target name and full certificate validation. An edge that does not serve the name fails the check and is discarded, so a wrong guess turns into a clean connection failure rather than a certificate error in the user's browser.

On port 80, where there is no certificate to check, the edge is first verified over TLS on 443; only then does an HTTP `Host` probe act as the fallback proof.

Verified routes are cached for 10 minutes and failures for 1 minute, so the probe cost is paid once per host, not once per connection. If every address for a cached route later fails to connect, the entry is dropped and the ladder runs again on the next attempt.

### Where the borrowed edges come from

In priority order: addresses pinned by the operator via `CDN_FALLBACK_EDGES`, then addresses **learned from live traffic** (any dual-stack host of a known CDN is itself a sample of that CDN's edge fleet), then a built-in list of seed hostnames per provider. The learned pool means the feature does not depend on the built-in seeds staying dual-stack forever.

### Checking a host

`scripts/check-ipv6.sh` runs the same checks offline:

```bash
./scripts/check-ipv6.sh support.apple.com build.nvidia.com
```

```
HOST                  DNS_A6  NATIVE  DUALSTACK  BORROW  DETAIL
support.apple.com     NO      -       -          YES     cname:prod-support.apple-support.akadns.net; borrow_ok=2600:1413:...
www.akamai.com        YES     YES     -          YES     native=2600:1413:5000:35::173d:ca51 (2 AAAA)
```

Against a running proxy, `GET /api/v1/resolver/check?host=<host>` reports what it actually decided, including the CNAME chain, the detected CDN, and whether the chosen address was verified.

### Limits

Borrowing only helps for sites that are genuinely behind a supported CDN. A name served from a single IPv4-only origin has no IPv6 path at all — for those, either configure `NAT64_PREFIX` with a reachable NAT64 gateway, or provide an IPv4 egress. The proxy reports `0x04` (host unreachable) rather than hanging.

---

## REST API Reference

All API endpoints are prefixed with `/api/v1`. Authentication is via the `X-API-Key` header, except for health endpoints.

### Health

| Method | Path | Description | Auth |
|---|---|---|---|
| `GET` | `/health` | Basic health check (uptime) | No |
| `GET` | `/health/ready` | Readiness check (verifies DB connectivity) | No |

### Users

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/users` | Create a user |
| `GET` | `/api/v1/users` | List all users |
| `GET` | `/api/v1/users/:id` | Get a user by ID |
| `PATCH` | `/api/v1/users/:id` | Update user (password, mode, status) |
| `DELETE` | `/api/v1/users/:id` | Delete a user |
| `POST` | `/api/v1/users/:id/refresh` | Refresh sticky IPv6 bindings |
| `GET` | `/api/v1/users/:id/current-ip` | Get current sticky addresses |

**POST /api/v1/users**

```json
{
  "username": "alice",
  "password": "secret123",
  "mode": "random"
}
```

**PATCH /api/v1/users/:id**

```json
{
  "password": "newpass",
  "mode": "random",
  "status": "disabled"
}
```

### Subnets

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/subnets` | Add a subnet |
| `GET` | `/api/v1/subnets` | List all subnets |
| `GET` | `/api/v1/subnets/:id` | Get a subnet by ID |
| `DELETE` | `/api/v1/subnets/:id` | Remove a subnet |
| `POST` | `/api/v1/subnets/:id/health` | Check subnet health (attempts IPv6 bind) |

**POST /api/v1/subnets**

```json
{
  "cidr": "2001:db8:1::/64",
  "gateway": "2001:db8:1::1"
}
```

### Bindings

Bind users to subnets. A user must be bound to at least one subnet to use the SOCKS5 proxy.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/users/:id/bindings` | Bind user to a subnet |
| `GET` | `/api/v1/users/:id/bindings` | List user's subnet bindings |
| `DELETE` | `/api/v1/users/:id/bindings/:bindingId` | Remove a binding |

**POST /api/v1/users/:id/bindings**

```json
{
  "subnet_id": "<subnet-uuid>"
}
```

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/sessions` | List active SOCKS5 sessions (optional `?user_id=` filter) |
| `DELETE` | `/api/v1/sessions/:sessionId` | Force-disconnect a session |

### Traffic

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/traffic` | Query traffic stats |

**Query parameters:** `user_id`, `start` (ISO date), `end` (ISO date), `limit`, `offset`

### Rate Limits

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/users/:id/limits` | Get rate limit rules + current connection count |
| `PUT` | `/api/v1/users/:id/limits` | Set rate limit rules |

**PUT /api/v1/users/:id/limits**

```json
{
  "max_connections": 10,
  "max_bandwidth": 1048576
}
```

- `max_connections`: Maximum concurrent SOCKS5 connections (`null` for unlimited)
- `max_bandwidth`: Maximum bandwidth in bytes/sec (`null` for unlimited)

### Audit Logs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/audit-logs` | Query audit logs |

**Query parameters:** `user_id`, `action`, `start` (ISO datetime), `end` (ISO datetime), `limit`, `offset`

**Audit actions recorded:**
- `user.created`, `user.updated`, `user.deleted`
- `subnet.created`, `subnet.deleted`
- `binding.created`, `binding.deleted`
- `ip.refreshed`
- `rate_limits.updated`

### Resolver

Diagnostics for the IPv6 fallback ladder — see [Reaching IPv4-Only Names](#reaching-ipv4-only-names).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/resolver/check` | Diagnose how a hostname is reached over IPv6 |
| `GET` | `/api/v1/resolver/cache` | Inspect cached routes, edge pools and learned edges |
| `DELETE` | `/api/v1/resolver/cache` | Clear the route cache |

**GET /api/v1/resolver/check**

**Query parameters:** `host` (required), `port` (default `443`)

```json
{
  "host": "support.apple.com",
  "port": 443,
  "cnameChain": ["prod-support.apple-support.akadns.net"],
  "aaaa": [],
  "a": ["23.44.51.100"],
  "provider": "akamai",
  "route": {
    "kind": "cdn-borrow",
    "addresses": ["2600:1413:1::6011:b42a"],
    "provider": "akamai",
    "via": "akamai edge",
    "verified": true
  },
  "error": null
}
```

`route` is `null` and `error` is set when no IPv6 path exists.

---

## Data Model

### Users

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `username` | TEXT | Unique username |
| `password` | TEXT | bcrypt hash |
| `mode` | TEXT | `sticky` or `random` |
| `status` | TEXT | `active` or `disabled` |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

### Subnets

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `cidr` | TEXT | Unique CIDR notation (e.g., `2001:db8:1::/64`) |
| `gateway` | TEXT | Gateway address (optional) |
| `status` | TEXT | `active` or `disabled` |
| `created_at` | TEXT | ISO 8601 timestamp |

### Sticky Bindings

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id) |
| `subnet_id` | TEXT | References subnets(id) |
| `ipv6_addr` | TEXT | Allocated IPv6 address (full expanded form) |
| `bound_at` | TEXT | ISO 8601 timestamp |

### Traffic Stats

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id) |
| `date` | TEXT | Date in `YYYY-MM-DD` format |
| `bytes_in` | INTEGER | Bytes received from target |
| `bytes_out` | INTEGER | Bytes sent to target |

### Audit Logs

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id), nullable |
| `actor` | TEXT | Who performed the action (`system` or username) |
| `action` | TEXT | Action identifier |
| `detail` | TEXT | JSON string with action details |
| `created_at` | TEXT | ISO 8601 timestamp |

### Rate Limits

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | Unique, references users(id) |
| `max_connections` | INTEGER | Max concurrent connections (nullable) |
| `max_bandwidth` | INTEGER | Max bytes/sec (nullable) |

---

## Rate Limiting

Rate limiting operates at two levels per user:

1. **Connection limit** — Hard limit on the number of concurrent SOCKS5 sessions. Enforced at connection time. Default: unlimited.
2. **Bandwidth throttling** — Token bucket algorithm. Each user gets a bucket that refills at `max_bandwidth` bytes per second. If the bucket is empty, data is delayed. Default: unlimited.

Rate limits are optional — set values to `null` (or omit in the JSON body) to disable.

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Tests (node:test, no network access required)
npm test

# Build
npm run build
```

### Project Structure

```
src/
├── index.ts                    # Entry point
├── config.ts                   # Environment configuration
├── database/
│   ├── connection.ts           # SQLite singleton
│   └── migrations.ts           # Schema migrations
├── core/
│   ├── ip-allocator.ts         # IPv6 address allocation
│   ├── users.ts                # User management
│   ├── subnets.ts              # Subnet management
│   ├── sessions.ts             # Session tracking
│   ├── traffic.ts              # Traffic accounting
│   ├── rate-limiter.ts         # Rate limiting
│   ├── target-resolver.ts      # IPv6 fallback ladder + edge verification
│   ├── cdn-providers.ts        # Known anycast CDN fingerprints and seeds
│   └── audit.ts                # Audit logging
├── socks5/
│   └── server.ts               # SOCKS5 protocol implementation
├── api/
│   ├── server.ts               # Fastify server setup
│   ├── middleware/
│   │   └── auth.ts             # API key authentication
│   └── routes/
│       ├── health.ts           # Health check endpoints
│       ├── users.ts            # User CRUD endpoints
│       ├── subnets.ts          # Subnet CRUD endpoints
│       ├── bindings.ts         # User-subnet binding endpoints
│       ├── sessions.ts         # Session management endpoints
│       ├── traffic.ts          # Traffic stats endpoints
│       ├── limits.ts           # Rate limit endpoints
│       ├── audit.ts            # Audit log endpoints
│       └── resolver.ts         # IPv6 fallback diagnostics
└── utils/
    ├── ipv6.ts                 # IPv6 address utilities
    └── logger.ts               # Pino logger

test/
└── target-resolver.test.ts     # Fallback ladder tests (node:test)

scripts/
└── check-ipv6.sh               # Offline IPv6 reachability check
```

---

## Docker

### Building

```bash
docker build -f docker/Dockerfile -t ipv6-subnet-proxy .
```

### docker-compose

```yaml
services:
  ipv6-proxy:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "1080:1080"
      - "3000:3000"
    environment:
      - API_KEY=changeme
      - DEFAULT_SUBNET=2001:db8:1::/64
      - LOG_LEVEL=info
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv6.ip_nonlocal_bind=1
    restart: unless-stopped
    network_mode: host
```

> **Note:** `network_mode: host` is required for IPv6 binding to work correctly in Docker. When using host networking, the port mappings are advisory and the container directly uses the host's network stack.

---

## CI/CD

Docker images are automatically built and published to GitHub Container Registry (GHCR) when a tag matching `v*` is pushed.

The GitHub Actions workflow:

1. Checks out the repository
2. Generates Docker metadata tags (semver + `latest`)
3. Sets up QEMU for multi-architecture builds
4. Logs into GHCR
5. Builds and pushes images for `linux/amd64` and `linux/arm64`

**Usage:**

```bash
git tag v1.0.0
git push origin v1.0.0
```

The image will be published to `ghcr.io/<your-username>/ipv6-subnet-proxy`.

---

## License

MIT
