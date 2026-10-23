# SOCKS5 Proxy Usage

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

When the kernel has a `local` route for the whole prefix (as the built-in 6in4 tunnel sets up), the proxy does not add each session's `/128` to an interface; `ip_nonlocal_bind=1` is enough to bind it. Native subnets that depend on NDP (bridged or LXC setups) are still registered per address.

### Handshake Timeout

A client has 30 seconds to complete the SOCKS5 method selection, authentication, and CONNECT request. Connections that stay silent are closed so they cannot hold a slot indefinitely. Idle relayed connections are not subject to this timer.

---
