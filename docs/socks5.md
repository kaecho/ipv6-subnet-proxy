# SOCKS5 Proxy Usage

Configure any SOCKS5 client with:

- **Address**: proxy server IP or hostname
- **Port**: `1080` (or custom `SOCKS5_PORT`)
- **Protocol**: SOCKS5
- **Authentication**: Username / Password
- **Username**: a suffix of a created user's username (see below)
- **Password**: the created user's password

The proxy only supports TCP CONNECT. BIND and UDP ASSOCIATE requests are rejected with `0x07` (Command not supported).

### Username-Selected Address Mode

The account itself has no mode setting. Every account can use both behaviours; the SOCKS5 username chooses one:

| SOCKS5 username | IPv6 allocation |
|---|---|
| `alice` | Random address on every connection |
| `alice-random` | Random address on every connection |
| `alice-sticky` | Sticky address from the account's `default` bucket |
| `alice-sticky-<key>` | Sticky address from an independent bucket named `<key>` |

The password is always the password of the base account (`alice`). The suffix is not part of the account and cannot be managed as a separate user.

Examples using an account created as `alice` / `secret123`:

```text
alice                    secret123   # random
alice-random             secret123   # random
alice-sticky             secret123   # sticky, default bucket
alice-sticky-8d3f...     secret123   # sticky, bucket 8d3f...
```

#### Sticky buckets

- Switching the key switches the address. Two connections using `alice-sticky-a` and `alice-sticky-b` normally receive different addresses.
- With several bound subnets, a bucket gets one address per subnet. The first connection picks one of the bound subnets and later connections reuse that subnet's address.
- A keyed bucket (`alice-sticky-<key>`) that has not been used for **`STICKY_TTL_HOURS`** (24 by default) is deleted. The next connection using that key gets a fresh address. Reuse refreshes the timer.
- The plain `default` bucket (`alice-sticky`) does not expire. It keeps its address until `POST /api/v1/users/:id/refresh` clears it.
- `POST /api/v1/users/:id/refresh` clears every sticky bucket for the account, including keyed buckets. This is the same switch-IP API as before.
- `GET /api/v1/users/:id/current-ip` lists the current buckets and their addresses.

Set the idle window in the container environment; for example, 10 days:

```yaml
environment:
  - STICKY_TTL_HOURS=240
```

Keys are case-insensitive and limited to 1-64 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`. A UUID works as a key. If a subnet is a single `/128` (for example one WARP device), there is only one possible address, so every key on that subnet shares it.

An account literally named `alice-sticky` is only used when no account named `alice` exists; otherwise the suffix form takes precedence. Avoid creating base accounts that end in `-random` or `-sticky` if variants are needed.

### IPv6 Kernel Requirement

The host must have `net.ipv6.ip_nonlocal_bind=1` to allow binding to IPv6 addresses that are not assigned to any local interface:

```bash
sysctl -w net.ipv6.ip_nonlocal_bind=1
```

To make it permanent, add `net.ipv6.ip_nonlocal_bind=1` to `/etc/sysctl.conf` or `/etc/sysctl.d/99-ipv6.conf`.

When the kernel has a `local` route for the whole prefix (as the built-in 6in4 tunnel sets up), the proxy does not add each session's `/128` to an interface; `ip_nonlocal_bind=1` is enough to bind it. Native subnets that depend on NDP (bridged or LXC setups) are still registered per address.

### Handshake Timeout

A client has 30 seconds to complete the SOCKS5 method selection, authentication, and CONNECT request. Connections that stay silent are closed so they cannot hold a slot indefinitely. Idle relayed connections are not subject to this timer.
