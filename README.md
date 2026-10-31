# IPv6 Subnet Proxy

[English](https://kaecho.github.io/ipv6-subnet-proxy/) | [中文](https://kaecho.github.io/ipv6-subnet-proxy/zh/)

SOCKS5 proxy that spreads outbound connections across IPv6 addresses from managed subnets. Built-in free IPv6 via **Cloudflare WARP** (no signup) or a **6in4 tunnel broker**, plus a REST management API, SQLite persistence, per-user rate limits, traffic stats, and audit logs.

**Full docs (EN / 中文):** https://kaecho.github.io/ipv6-subnet-proxy/

---

## Quick start (Docker)

```bash
# On the HOST (required with network_mode: host — container cannot set this)
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

# Optional free IPv6 if the host has none:
#   sudo modprobe wireguard   # for WARP
#   sudo modprobe sit         # for a 6in4 tunnel broker

git clone https://github.com/kaecho/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# Edit docker/docker-compose.yml → set API_KEY (and WARP_ENABLED / HE_* if needed)
docker compose -f docker/docker-compose.yml up -d --build
```

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/api/v1/users \
  -H "X-API-Key: changeme" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

SOCKS5: `localhost:1080`, password `secret123` for all of these usernames:

| Username | Address |
|---|---|
| `alice` or `alice-random` | New random IPv6 per connection |
| `alice-sticky` | Fixed IPv6, switchable with `POST /api/v1/users/:id/refresh` |
| `alice-sticky-<key>` | Fixed IPv6 per key; changing the key changes the address |

Keyed sticky buckets expire after 24 hours without use by default; set `STICKY_TTL_HOURS` to change the window. `alice-sticky` lasts until the refresh API is called. See [SOCKS5 usage](https://kaecho.github.io/ipv6-subnet-proxy/socks5).

> Host networking is required. Compose `sysctls:` do nothing under `network_mode: host` — set `ip_nonlocal_bind` on the **host** as above.

## No IPv6 on the host?

| | Cloudflare WARP | Tunnel broker (6in4) |
|---|---|---|
| Signup | None | Free account at tunnelbroker.net |
| What you get | One address per device | Routed `/48` |
| Kernel | `modprobe wireguard` | `modprobe sit` |
| Env | `WARP_ENABLED=true` | `HE_TUNNEL_ID` + credentials |

Details: [docs → No IPv6](https://kaecho.github.io/ipv6-subnet-proxy/no-ipv6)

## Manual install

```bash
npm install && npm run build
export API_KEY=your-secret-api-key
# export DEFAULT_SUBNET=2001:db8:1::/64   # optional; auto-detects interfaces
npm start
```

Node 20+, Linux, `iproute2`, `net.ipv6.ip_nonlocal_bind=1`.

## Configuration

All config is environment variables. Common ones:

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | _(required)_ | REST API key (`X-API-Key`) |
| `SOCKS5_PORT` | `1080` | Proxy listen port |
| `API_PORT` | `3000` | REST API port |
| `DEFAULT_SUBNET` | — | Register a CIDR on startup |
| `WARP_ENABLED` | `false` | Free IPv6 via Cloudflare WARP |
| `WARP_ACCOUNTS` | `1` | WARP devices (= egress addresses) |
| `HE_TUNNEL_ID` | — | tunnelbroker.net tunnel id |
| `HE_TUNNEL_USERNAME` | — | HE account |
| `HE_TUNNEL_UPDATE_KEY` | — | Per-tunnel update key (preferred over password) |
| `LOG_LEVEL` | `info` | `trace`…`fatal` |

Full list: [docs → Configuration](https://kaecho.github.io/ipv6-subnet-proxy/configuration)

## Docs & development

```bash
npm run docs:dev      # local VitePress
npm run docs:build
npm test
npm run build
```

Image: `ghcr.io/kaecho/ipv6-subnet-proxy` (tag `v*`).

## License

MIT
