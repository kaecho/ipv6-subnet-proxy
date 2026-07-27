# Reaching IPv4-Only Names

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
