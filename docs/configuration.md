# Configuration

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
| `DETECT_HOST_SUBNETS` | `false` | Register IPv6 prefixes found on host interfaces. Off, those prefixes are removed from the pool so sessions are not sourced from an address the upstream does not route |
| `BCRYPT_ROUNDS` | `10` | bcrypt hash rounds for password hashing |
| `LOG_LEVEL` | `info` | Logging level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `STICKY_TTL_HOURS` | `24` | Hours an unused keyed sticky bucket is kept (1-87600). The plain `-sticky` default bucket never expires |

### Cloudflare WARP

Free IPv6 with no signup — see [Option 1: Cloudflare WARP](/no-ipv6#option-1-cloudflare-warp-no-signup). Off unless `WARP_ENABLED=true`; everything else has a working default.

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

Bring up a tunnelled IPv6 prefix on a host that has none of its own — see [Option 2: A Tunnel Broker](/no-ipv6#option-2-a-tunnel-broker-a-whole-routed-prefix). Tunnel support switches itself on as soon as either the credentials or the manual endpoint settings are present.

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
| `HE_TUNNEL_REGISTER_SUBNETS` | `true` | Register the routed prefixes as allocation subnets on startup. Prefixes no longer in this list are removed, with their sticky bindings |
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

These control how the proxy reaches names that publish no AAAA record. Defaults are sensible; most deployments need none of them. See [Reaching IPv4-Only Names](/ipv4-only).

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
