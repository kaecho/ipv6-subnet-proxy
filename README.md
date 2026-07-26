# IPv6 Subnet Proxy

[English](README.md) | [中文](README_zh.md)

A Node.js TypeScript SOCKS5 proxy that distributes outbound connections across different IPv6 addresses from managed `/64` subnets. Includes a REST management API, SQLite-backed persistence, per-user rate limiting, traffic accounting, and audit logging.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [No IPv6 on the Host?](#no-ipv6-on-the-host)
  - [Option 1: Cloudflare WARP](#option-1-cloudflare-warp-no-signup)
  - [Option 2: A Tunnel Broker](#option-2-a-tunnel-broker-a-whole-routed-prefix)
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
  - [Tunnel](#tunnel)
  - [WARP](#warp)
- [Data Model](#data-model)
- [Rate Limiting](#rate-limiting)
- [Development](#development)
- [Docker](#docker)
- [CI/CD](#cicd)

---

## Features

- **SOCKS5 with Password Auth** — Full RFC 1928 (SOCKS5) and RFC 1929 (Username/Password) support. Only CONNECT command; BIND and UDP ASSOCIATE are rejected.
- **Built-in Tunnel Broker Client** — No IPv6 on the host? The proxy brings up a 6in4 tunnel itself and allocates from the routed prefix. A free Hurricane Electric tunnel hands out a `/48` — 2^80 addresses. See [No IPv6 on the Host?](#no-ipv6-on-the-host).
- **Built-in Cloudflare WARP Client** — Free IPv6 with no signup at all. The proxy registers WARP devices itself and brings up a WireGuard link per device; each one is another egress address to rotate across. See [Option 1: Cloudflare WARP](#option-1-cloudflare-warp-no-signup).
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

- Linux with `net.ipv6.ip_nonlocal_bind=1` and `iproute2` installed
- IPv6 connectivity — either native, or free from [Cloudflare WARP or a tunnel broker](#no-ipv6-on-the-host), both of which need only IPv4 on the host
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

## No IPv6 on the Host?

A proxy that spreads connections across a subnet needs a subnet to spread them across. Most cheap VPSes hand out a single `/128`, or no IPv6 at all. There are two ways out, both free, and the proxy sets up either one itself — no `wg-quick`, no `ip tunnel`, no systemd units:

| | Cloudflare WARP | Tunnel broker (6in4) |
|---|---|---|
| Signup | None at all | Free account at tunnelbroker.net |
| What you get | One address per registered device | A routed `/48` — 2^80 addresses |
| Carried over | WireGuard (UDP 2408) | 6in4 (IP protocol 41) |
| Kernel needs | `wireguard` module | `sit` module |
| Address diversity | As many as you register | Effectively unlimited |
| Best when | You want IPv6 in one env var | You want a real prefix to spread across |

They are independent — a host can run both, and the egress pool is simply the union. If you just want it working, start with WARP.

---

### Option 1: Cloudflare WARP (no signup)

[Cloudflare WARP](https://1.1.1.1) hands out a globally routable IPv6 address over WireGuard, for free, to anyone who asks — no account, no email, no payment. Registering a device is a single unauthenticated API call, and the proxy makes it for you.

```bash
export WARP_ENABLED=true
```

That is the whole configuration. On startup the proxy registers a WARP device, brings up a WireGuard link to Cloudflare, and registers the assigned address as an allocation subnet:

```
info: Registered a Cloudflare WARP device { slot: 0, address: "2606:4700:110:8921:bf06:c4d7:40b7:8afd", accountType: "free" }
info: WARP link is up { device: "warp0", endpoint: "162.159.192.1:2408", table: 51820, mtu: 1280 }
info: WARP verified: reached [2606:4700:4700::1111]:53
info: Registered IPv6 subnet { cidr: "2606:4700:110:8921:bf06:c4d7:40b7:8afd/128", source: "warp", boundUsers: 1 }
```

#### One account is one address

This is the thing to understand about WARP, and the one real difference from a tunnel broker: **Cloudflare assigns a single `/128`, not a prefix.** One registration is one egress IP forever. For a proxy whose whole purpose is spreading connections across addresses, one is rarely enough.

So register more:

```bash
export WARP_ENABLED=true
export WARP_ACCOUNTS=8
```

Each account becomes its own WireGuard interface (`warp0`…`warp7`) with its own address, and each address is registered as a one-address subnet. From there the proxy's existing per-user subnet selection does the rotation with no extra machinery:

- **`random` users** get a different WARP address on every connection.
- **`sticky` users** are pinned to one WARP address and keep it across reconnects.

Registrations are stored in the database and reused, so restarts keep the same addresses instead of burning through Cloudflare's registration quota. To deliberately rotate to a fresh set, start once with `WARP_RESET=true`; the addresses they replace are dropped from the pool automatically.

#### WARP+ (optional)

A WARP+ licence key raises Cloudflare's quota. It changes nothing about the addressing — the free tier already gives you the IPv6 address.

```bash
export WARP_LICENSE=xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxx
```

#### Docker

```yaml
services:
  ipv6-proxy:
    image: ghcr.io/<your-username>/ipv6-subnet-proxy:latest
    environment:
      - API_KEY=changeme
      - WARP_ENABLED=true
      - WARP_ACCOUNTS=8
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

One host-side requirement — WireGuard is a kernel module, and containers cannot load host modules themselves:

```bash
sudo modprobe wireguard
echo wireguard | sudo tee /etc/modules-load.d/wireguard.conf
```

`network_mode: host` and `cap_add: NET_ADMIN` are both required: the links are built in the host's network namespace. The image ships `wireguard-tools`, so `wg` itself does not need installing.

#### What it configures, per link

| Step | Why |
|---|---|
| WireGuard device to Cloudflare's anycast endpoint | Carries IPv6 inside UDP to `engage.cloudflareclient.com:2408` |
| The assigned `/128` on that device | This is the egress address, and the link's entire allocation pool |
| Policy rule + route table | Traffic **sourced from** that address leaves through that link |

Nothing is written to the main routing table. WARP here is an egress pool for the proxy, not a VPN for the whole box: the host's own traffic, and any native IPv6 it already has, are untouched. The rules sit at priority 1520 and up, ahead of the main table at 32766, so WARP-sourced traffic wins even on a host that has its own IPv6 default route.

Bring-up is idempotent — each link tears its own device down first, so restarts and crashes leave nothing to clean up by hand.

#### Checking it

```bash
curl -s http://localhost:3000/api/v1/warp -H "X-API-Key: $API_KEY" | jq
```

`links[].up` reports whether each device was built, `links[].probe` whether traffic actually passed over it, and `warnings` collects anything that degraded. `GET /api/v1/warp/accounts` lists the registered devices and their addresses without their keys. `POST /api/v1/warp/reconnect` rebuilds the links, `POST /api/v1/warp/verify` re-probes.

If a link is up but its probe failed, the interface exists and the packets are being dropped in between — almost always UDP to port 2408 being blocked, or the `wireguard` module missing.

#### Limits worth knowing

WARP addresses come out of Cloudflare's own space and are widely shared, so sites that score IP reputation will treat them as VPN traffic. A tunnel broker's `/48` is yours alone and looks quite different to a target. Pick accordingly, or run both and bind users to the pool that suits them.

---

### Option 2: A Tunnel Broker (a whole routed prefix)

Where WARP gives one address per registration, a tunnel broker gives a whole prefix.

[Hurricane Electric](https://tunnelbroker.net) gives away, for free, a routed `/48`: 1,208,925,819,614,629,174,706,176 addresses, delivered over a 6in4 tunnel that needs nothing from the host but IPv4 and the `sit` kernel module. **The host itself never has to have IPv6.**

The proxy sets that tunnel up on its own. Create the tunnel on tunnelbroker.net, hand over the credentials, and it does the rest — no `ip tunnel` commands, no `/etc/network/interfaces`, no separate `he-ipv6.service`.

### Option A: credentials (recommended)

Register at [tunnelbroker.net](https://tunnelbroker.net), create a regular tunnel, click **Assign /48** on its page, then:

```bash
export HE_TUNNEL_ID=1033580          # "Tunnel ID" on the tunnel page
export HE_TUNNEL_USERNAME=your-account
export HE_TUNNEL_PASSWORD=your-password
```

On startup the proxy reads the tunnel's endpoints and routed prefixes from the [tunnelbroker API](https://forums.he.net/index.php?topic=3153.0), points the tunnel at this host's current public IPv4, builds the `sit` device, and registers the routed prefixes as allocation subnets. The log tells the whole story:

```
info: Fetched tunnel details from tunnelbroker.net { tunnelId: "1033580", routed48: "2001:470:ecf2::/48" }
info: Tunnel endpoint set to 203.0.113.9
info: 6in4 tunnel is up { device: "he-ipv6", routed: ["2001:470:ecf2::/48"], mtu: 1480 }
info: Tunnel verified: reached [2001:470:20::2]:53
info: Registered tunnel-routed IPv6 subnet { cidr: "2001:470:ecf2::/48" }
```

> If the tunnel has an **Update Key** set (its *Advanced* tab), HE requires that key rather than the account password: put it in `HE_TUNNEL_UPDATE_KEY`. It is the safer thing to deploy — it only grants control of that one tunnel.

### Option B: paste the tunnel details

No account credentials on the server. Copy four values off the tunnel page:

| Tunnel page | Environment variable |
|---|---|
| Server IPv4 Address | `HE_TUNNEL_SERVER_IPV4` |
| Client IPv6 Address | `HE_TUNNEL_CLIENT_IPV6` |
| Routed /48 (and/or Routed /64) | `HE_TUNNEL_ROUTED_PREFIXES` |
| Server IPv6 Address _(optional)_ | `HE_TUNNEL_SERVER_IPV6` |

```bash
export HE_TUNNEL_SERVER_IPV4=216.218.221.42
export HE_TUNNEL_CLIENT_IPV6=2001:470:1f04:17b::2/64
export HE_TUNNEL_ROUTED_PREFIXES=2001:470:8123::/48,2001:470:1f05:17b::/64
```

These describe a plain RFC 4213 6in4 tunnel, so Option B works with any tunnel broker, not just HE. Only the API and endpoint-update features are HE-specific.

Set both and the environment wins — useful for overriding one field without giving up the API.

### Docker

```yaml
services:
  ipv6-proxy:
    image: ghcr.io/<your-username>/ipv6-subnet-proxy:latest
    environment:
      - API_KEY=changeme
      - HE_TUNNEL_ID=1033580
      - HE_TUNNEL_USERNAME=your-account
      - HE_TUNNEL_UPDATE_KEY=your-update-key
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

Two host-side requirements, because kernel state is not namespaced away from you here:

```bash
# 1. The 6in4 module. Containers cannot load host modules themselves.
sudo modprobe sit
echo sit | sudo tee /etc/modules-load.d/sit.conf

# 2. Binding to addresses that are not configured on an interface.
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf
```

`network_mode: host` and `cap_add: NET_ADMIN` are both required: the tunnel is built in the host's network namespace.

### What it configures

| Step | Why |
|---|---|
| `sit` device to the broker's IPv4 endpoint | Carries IPv6 inside IPv4 packets (protocol 41) |
| Client address on the tunnel link | Our end of the point-to-point link |
| Policy rule + route table for each routed prefix | Traffic **sourced from** the tunnel's prefixes leaves through the tunnel |
| `local` route for each routed prefix | Lets any address in the `/48` answer without being configured first |
| Default route in the main table | Only when the host has none of its own — see `HE_TUNNEL_DEFAULT_ROUTE` |

The policy-routing split is what makes this safe to enable on a host that *already* has native IPv6: its own traffic keeps using the native path, and only addresses out of the tunnelled prefixes ride the tunnel. Bring-up is idempotent — it tears down its own device first, so restarts and crashes leave nothing behind to clean up by hand.

### Dynamic IP addresses

A 6in4 tunnel only carries traffic while the broker's *Client IPv4* matches the host's actual public address. With credentials configured, the proxy re-checks its public IPv4 every 15 minutes (`HE_TUNNEL_UPDATE_INTERVAL_MS`) and, when it changes, updates the tunnel and rebuilds the device. Home connections and re-created VPSes survive on their own.

### Behind NAT

The tunnel still works: anchor it to the LAN address and forward IP protocol 41 (not a TCP or UDP port — protocol 41 itself) from the router to the host.

```bash
export HE_TUNNEL_LOCAL_IPV4=192.168.1.20
```

Left unset, the proxy detects it and logs a warning naming the address it chose.

### Checking it

```bash
curl -s http://localhost:3000/api/v1/tunnel -H "X-API-Key: $API_KEY" | jq
```

`up` reports whether the device was built, `probes` whether traffic actually passed over it, and `warnings` collects anything that degraded — a missing sysctl, a rejected credential, a kernel without policy routing. `POST /api/v1/tunnel/reconnect` rebuilds it, `POST /api/v1/tunnel/verify` re-probes.

If `up` is true but every probe failed, the tunnel exists locally and the packets are being dropped in between. In order of likelihood: the broker's Client IPv4 does not match this host, protocol 41 is filtered by the provider or a NAT in front, or the `sit` module is missing.

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

### Cloudflare WARP

Free IPv6 with no signup — see [Option 1: Cloudflare WARP](#option-1-cloudflare-warp-no-signup). Off unless `WARP_ENABLED=true`; everything else has a working default.

| Variable | Default | Description |
|---|---|---|
| `WARP_ENABLED` | `false` | Register WARP devices and bring up a WireGuard link for each |
| `WARP_ACCOUNTS` | `1` | Devices to register (1-64). **Each one is one more egress address** — raise this to get a pool to rotate across |
| `WARP_LICENSE` | — | WARP+ licence key. Optional; the free tier already provides the address |
| `WARP_RESET` | `false` | Discard the stored registrations and register new devices. Rotates every WARP address; the old ones are dropped from the pool |
| `WARP_REGISTER_SUBNETS` | `true` | Register each assigned address as a one-address (`/128`) allocation subnet |
| `WARP_DEVICE_PREFIX` | `warp` | Interface names are this plus the slot number: `warp0`, `warp1`, … |
| `WARP_MTU` | `1280` | Link MTU. 1280 is the IPv6 minimum and what WARP clients use |
| `WARP_ROUTE_TABLE` | `51820` | First routing table; slot N uses this plus N |
| `WARP_RULE_PRIORITY` | `1520` | First rule priority; slot N uses this plus N. Must stay below 32766 so the rules are consulted before the main table |
| `WARP_KEEPALIVE` | `25` | WireGuard persistent-keepalive, in seconds. Keeps the NAT mapping open |
| `WARP_ENDPOINT` | `engage.cloudflareclient.com:2408` | Cloudflare's WireGuard endpoint, used when the API names none. Set a literal address if DNS is unreliable |
| `WARP_VERIFY` | `true` | Probe each link after bring-up and report the result |
| `WARP_VERIFY_HOST` | `2606:4700:4700::1111` | Probe target (Cloudflare's resolver, which answers on TCP) |
| `WARP_VERIFY_PORT` | `53` | Probe port |
| `WARP_TEARDOWN_ON_EXIT` | `true` | Remove the devices, routes and rules on shutdown |
| `WARP_REGISTER_DELAY_MS` | `1500` | Pause between registrations. Cloudflare rate-limits bursts |
| `WARP_API_URL` | `https://api.cloudflareclient.com/v0a2158/reg` | Device registration API |
| `WARP_CLIENT_VERSION` | `a-6.10-2158` | `CF-Client-Version` header sent with registrations |
| `WARP_USER_AGENT` | `okhttp/3.12.1` | User agent sent with registrations |
| `WARP_REQUEST_TIMEOUT_MS` | `15000` | Timeout for the API calls above |

### Tunnel Broker (6in4)

Bring up a tunnelled IPv6 prefix on a host that has none of its own — see [Option 2: A Tunnel Broker](#option-2-a-tunnel-broker-a-whole-routed-prefix). Tunnel support switches itself on as soon as either the credentials or the manual endpoint settings are present.

| Variable | Default | Description |
|---|---|---|
| `HE_TUNNEL_ENABLED` | _(auto)_ | On when credentials or manual endpoint settings are configured. Set `false` to keep them configured but unused |
| `HE_TUNNEL_ID` | — | Tunnel ID from the tunnelbroker.net tunnel page |
| `HE_TUNNEL_USERNAME` | — | tunnelbroker.net account name |
| `HE_TUNNEL_PASSWORD` | — | Account password. Not used when an Update Key is set on the tunnel |
| `HE_TUNNEL_UPDATE_KEY` | — | Per-tunnel Update Key (tunnel → *Advanced*). Required instead of the password when set, and safer to deploy |
| `HE_TUNNEL_SERVER_IPV4` | _(from API)_ | Broker-side IPv4 endpoint — "Server IPv4 Address" |
| `HE_TUNNEL_SERVER_IPV6` | _(from API)_ | Broker-side IPv6 address — "Server IPv6 Address" |
| `HE_TUNNEL_CLIENT_IPV6` | _(from API)_ | This host's address on the tunnel link, e.g. `2001:470:1f04:17b::2/64` |
| `HE_TUNNEL_ROUTED_PREFIXES` | _(from API)_ | Comma-separated prefixes routed to the tunnel. These become the allocation subnets |
| `HE_TUNNEL_LOCAL_IPV4` | _(detected)_ | Local IPv4 to anchor the tunnel to. Set to the LAN address when behind NAT |
| `HE_TUNNEL_DEVICE` | `he-ipv6` | Name of the `sit` device to create |
| `HE_TUNNEL_MTU` | `1480` | Tunnel MTU. 1480 is what 6in4 leaves of a 1500-byte path |
| `HE_TUNNEL_TTL` | `255` | TTL of the outer IPv4 packets |
| `HE_TUNNEL_ROUTE_TABLE` | `1470` | Routing table for tunnel-sourced traffic, and the rule priority |
| `HE_TUNNEL_DEFAULT_ROUTE` | `auto` | `auto` adds a default route only if the host has none; `always` adds it regardless; `never` leaves the main table untouched |
| `HE_TUNNEL_FORWARDING` | `false` | Enable `net.ipv6.conf.all.forwarding`. Only needed to route the prefix onward to other hosts |
| `HE_TUNNEL_REGISTER_SUBNETS` | `true` | Register the routed prefixes as allocation subnets on startup |
| `HE_TUNNEL_UPDATE_ENDPOINT` | _(on with credentials)_ | Point the tunnel at this host's public IPv4 during startup |
| `HE_TUNNEL_UPDATE_INTERVAL_MS` | `900000` | Re-check the public IPv4 this often and update on change. `0` disables. Clamped to a 60 s minimum |
| `HE_TUNNEL_VERIFY` | `true` | Probe the tunnel after bring-up and report the result |
| `HE_TUNNEL_VERIFY_HOST` | `2001:470:20::2` | Probe target (HE's anycast resolver, which answers on TCP) |
| `HE_TUNNEL_VERIFY_PORT` | `53` | Probe port |
| `HE_TUNNEL_TEARDOWN_ON_EXIT` | `true` | Remove the device, routes and rules on shutdown |
| `HE_TUNNEL_PUBLIC_IPV4_URL` | `https://checkip.amazonaws.com` | Where to look up this host's public IPv4 |
| `HE_TUNNEL_API_URL` | `https://tunnelbroker.net/tunnelInfo.php` | Tunnel info API |
| `HE_TUNNEL_UPDATE_URL` | `https://ipv4.tunnelbroker.net/nic/update` | Endpoint update API (dyndns protocol) |
| `HE_TUNNEL_REQUEST_TIMEOUT_MS` | `10000` | Timeout for the API calls above |

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
- `tunnel.endpoint_updated`, `tunnel.reconnected`
- `warp.reconnected`

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

### Tunnel

Status and control for the 6in4 tunnel — see [Option 2: A Tunnel Broker](#option-2-a-tunnel-broker-a-whole-routed-prefix).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/tunnel` | Tunnel state: device, spec, probes, warnings |
| `POST` | `/api/v1/tunnel/verify` | Re-probe that traffic passes over the tunnel |
| `POST` | `/api/v1/tunnel/endpoint` | Point the tunnel at this host's current public IPv4 |
| `POST` | `/api/v1/tunnel/reconnect` | Rebuild the tunnel from current settings |

**GET /api/v1/tunnel**

```json
{
  "enabled": true,
  "device": "he-ipv6",
  "up": true,
  "spec": {
    "serverIpv4": "216.218.221.42",
    "clientIpv6": "2001:470:1f04:17b::2",
    "linkPrefix": "2001:470:1f04:17b::/64",
    "localIpv4": "192.168.1.20",
    "routedPrefixes": ["2001:470:8123::/48"],
    "mtu": 1480
  },
  "natted": true,
  "publicIpv4": "203.0.113.9",
  "endpointUpdate": { "ok": true, "code": "nochg", "ip": "203.0.113.9", "at": "2026-07-26T12:00:00.000Z" },
  "probes": [
    { "source": "2001:470:1f04:17b::2", "ok": true, "detail": "reached [2001:470:20::2]:53" },
    { "source": "2001:0470:8123:6c1a:...", "ok": true, "detail": "reached [2001:470:20::2]:53" }
  ],
  "warnings": []
}
```

Credentials are never echoed back; `config.credentials` reports only `configured` or `none`.

### WARP

Status and control for the Cloudflare WARP links — see [Option 1: Cloudflare WARP](#option-1-cloudflare-warp-no-signup).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/warp` | WARP state: every link, its address, probe result and warnings |
| `GET` | `/api/v1/warp/accounts` | The registered devices and their addresses, without their keys |
| `POST` | `/api/v1/warp/verify` | Re-probe that traffic passes over each link |
| `POST` | `/api/v1/warp/reconnect` | Rebuild the links from the stored registrations |

**GET /api/v1/warp**

```json
{
  "enabled": true,
  "up": true,
  "links": [
    {
      "slot": 0,
      "device": "warp0",
      "address": "2606:4700:110:8921:bf06:c4d7:40b7:8afd",
      "cidr": "2606:4700:110:8921:bf06:c4d7:40b7:8afd/128",
      "endpoint": "162.159.192.1:2408",
      "table": 51820,
      "accountType": "free",
      "up": true,
      "error": null,
      "probe": { "source": "2606:4700:110:8921:bf06:c4d7:40b7:8afd", "ok": true, "detail": "reached [2606:4700:4700::1111]:53" }
    }
  ],
  "cidrs": ["2606:4700:110:8921:bf06:c4d7:40b7:8afd/128"],
  "startedAt": "2026-07-26T12:00:00.000Z",
  "warnings": []
}
```

WireGuard private keys and device tokens are never echoed back.

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
│   ├── tunnel.ts               # 6in4 tunnel bring-up, routing, verification
│   ├── tunnelbroker.ts         # tunnelbroker.net API + endpoint updates
│   ├── warp.ts                 # WARP WireGuard links, routing, verification
│   ├── warp-api.ts             # Cloudflare WARP device registration
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
│       ├── resolver.ts         # IPv6 fallback diagnostics
│       ├── tunnel.ts           # Tunnel status and control
│       └── warp.ts             # WARP status and control
└── utils/
    ├── ipv6.ts                 # IPv6 address utilities
    └── logger.ts               # Pino logger

test/
├── target-resolver.test.ts     # Fallback ladder tests (node:test)
├── tunnel.test.ts              # Tunnel parsing, spec resolution, ip command plans
└── warp.test.ts                # WARP keys, registration parsing, ip/wg command plans

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

> **Note:** `network_mode: host` is required for IPv6 binding to work correctly in Docker. When using host networking, the port mappings are advisory and the container directly uses the host's network stack. It also means `net.ipv6.ip_nonlocal_bind=1` must be set on the *host* — the `sysctls:` entry above cannot apply to a namespace the container does not own.

To bring up free IPv6 from inside the container, the host must have the matching kernel module loaded: `modprobe sit` for a [tunnel broker](#option-2-a-tunnel-broker-a-whole-routed-prefix), `modprobe wireguard` for [WARP](#option-1-cloudflare-warp-no-signup). The image ships `iproute2` (BusyBox's `ip` cannot create tunnel devices) and `wireguard-tools`.

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
