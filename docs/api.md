# REST API Reference

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

Diagnostics for the IPv6 fallback ladder — see [Reaching IPv4-Only Names](/ipv4-only).

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

Status and control for the 6in4 tunnel — see [Option 2: A Tunnel Broker](/no-ipv6#option-2-a-tunnel-broker-a-whole-routed-prefix).

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

Status and control for the Cloudflare WARP links — see [Option 1: Cloudflare WARP](/no-ipv6#option-1-cloudflare-warp-no-signup).

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
