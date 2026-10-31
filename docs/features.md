# Features

- **SOCKS5 with Password Auth** — Full RFC 1928 (SOCKS5) and RFC 1929 (Username/Password) support. Only CONNECT command; BIND and UDP ASSOCIATE are rejected.
- **Built-in Tunnel Broker Client** — No IPv6 on the host? The proxy brings up a 6in4 tunnel itself and allocates from the routed prefix. A free Hurricane Electric tunnel hands out a `/48` — 2^80 addresses. See [No IPv6 on the Host?](/no-ipv6).
- **Built-in Cloudflare WARP Client** — Free IPv6 with no signup at all. The proxy registers WARP devices itself and brings up a WireGuard link per device; each one is another egress address to rotate across. See [Option 1: Cloudflare WARP](/no-ipv6#option-1-cloudflare-warp-no-signup).
- **Host subnet detection** — Off unless `DETECT_HOST_SUBNETS=true`. A prefix on the host NIC is not used as a pool, so sessions are not sourced from an address the upstream does not route
- **Per-User IPv6 Allocation** — One account, two behaviours chosen by the SOCKS5 username: `alice` / `alice-random` gets a new address per connection; `alice-sticky` reuses one address and `alice-sticky-<key>` keeps an independent address per key (configurable idle expiry, 24 hours by default)
- **CDN Edge Borrowing** — Sites that publish no AAAA record are still reached over IPv6 through their CDN's dual-stack edge fleet, verified by certificate before use. See [Reaching IPv4-Only Names](/ipv4-only).
- **Auto-Binding** — Users are automatically bound to all active subnets on creation
- **Multi-Subnet Management** — Manage multiple `/64` (or any prefix length) subnets, bind any subset to each user
- **REST Management API** — Full CRUD for users, subnets, and bindings; query active sessions, traffic stats, audit logs; manage rate limits.
- **Rate Limiting** — Per-user connection count limit and token-bucket bandwidth throttling.
- **Traffic Accounting** — Per-user, per-day byte counters (bytes in / out).
- **Audit Logging** — All management actions are recorded with timestamps and actor information.
- **Docker Multi-Arch** — `linux/amd64` and `linux/arm64` images published to GHCR.
- **SQLite Persistence** — WAL-mode SQLite database stored on a persistent volume.

---
