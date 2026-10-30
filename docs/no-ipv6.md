# No IPv6 on the Host?

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

- **Random usernames** (`alice` or `alice-random`) get a different WARP address on every connection.
- **Sticky usernames** (`alice-sticky`) are pinned to one WARP address and keep it across reconnects; `alice-sticky-<key>` pins an independent address per key.

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
