#!/usr/bin/env bash
# IPv6 reachability check for a list of hostnames.
#
# Answers the question the proxy asks on every connection: can this name be
# reached over IPv6, and if it publishes no AAAA record, does a borrowed CDN
# edge serve it anyway?
#
# For each host it reports:
#   DNS_A6    — the name (or its CNAME chain) publishes AAAA
#   NATIVE    — TCP/443 + TLS certificate verification against its own AAAA
#   DUALSTACK — `dualstack.<cname-hop>` has AAAA and serves the name
#               (Fastly / Akamai / AWS ELB / CloudFront publish this variant)
#   BORROW    — a foreign edge of the same CDN serves the name over TLS+SNI
#
# BORROW=YES on a host with DNS_A6=NO is the case this proxy handles: IPv6 in
# DNS is a customer-side toggle, while the CDN edge fleet is dual-stack and
# dispatches on SNI, so the site is reachable over IPv6 regardless.
#
# Usage:
#   ./scripts/check-ipv6.sh build.nvidia.com api.ngc.nvidia.com
#   HOSTS="a.example.com b.example.com" ./scripts/check-ipv6.sh
#   EDGE_IP6=2600:9000:2015::1 ./scripts/check-ipv6.sh example.com
#   RESOLVERS="1.1.1.1 8.8.8.8" ./scripts/check-ipv6.sh example.com
#
# Needs: dig, python3 (stdlib only). Do not use ping — ICMP is often blocked.
set -eu

HOSTS=${HOSTS:-"$*"}
if [ -z "${HOSTS// }" ]; then
  echo "Usage: $0 <host> [host...]   (or set HOSTS=\"...\")" >&2
  exit 1
fi

RESOLVERS=${RESOLVERS:-"1.1.1.1 8.8.8.8 9.9.9.9"}

# Dual-stack names used only to harvest a working edge address per CDN.
# Keep in sync with src/core/cdn-providers.ts.
EDGE_SEEDS=${EDGE_SEEDS:-"
d2wy8f7a9ursnm.cloudfront.net
docs.aws.amazon.com
www.fastly.com
www.cloudflare.com
www.akamai.com
"}

# Set to skip seed discovery and pin one edge.
EDGE_IP6=${EDGE_IP6:-}

dig_aaaa() {
  local host=$1 r out all=""
  for r in $RESOLVERS; do
    out=$(dig +short +time=2 +tries=1 AAAA "$host" @"$r" 2>/dev/null \
      | grep -E '^[0-9a-fA-F:]+$' || true)
    [ -n "$out" ] && all+="$out"$'\n'
  done
  printf '%s' "$all" | awk 'NF && !seen[$0]++'
}

cname_chain() {
  local cur=$1 depth=0 next resolver
  resolver=$(printf '%s\n' $RESOLVERS | head -1)
  while [ $depth -lt 8 ]; do
    next=$(dig +short +time=2 +tries=1 CNAME "$cur" @"$resolver" 2>/dev/null \
      | head -1 | sed 's/\.$//')
    [ -z "$next" ] && break
    printf '%s\n' "$next"
    cur=$next
    depth=$((depth + 1))
  done
}

discover_edge_ip6() {
  if [ -n "$EDGE_IP6" ]; then
    printf '%s\n' "$EDGE_IP6"
    return 0
  fi
  local seed ip
  for seed in $EDGE_SEEDS; do
    [ -z "${seed// }" ] && continue
    ip=$(dig_aaaa "$seed" | awk 'NF{print; exit}')
    if [ -n "$ip" ]; then
      echo "  (harvested from $seed)" >&2
      printf '%s\n' "$ip"
      return 0
    fi
  done
  return 1
}

# TLS+TCP probe: connect to [ip]:443 with SNI=$host and verify the certificate.
# Prints: ok | tcp:ERR | ssl:ERR
tls_probe() {
  local host=$1 ip=$2
  python3 - "$host" "$ip" <<'PY'
import socket, ssl, sys

host, ip = sys.argv[1], sys.argv[2]
ctx = ssl.create_default_context()
try:
    raw = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    raw.settimeout(5.0)
    raw.connect((ip, 443, 0, 0))
except Exception as e:
    print(f"tcp:{type(e).__name__}")
    raise SystemExit(2)
try:
    ctx.wrap_socket(raw, server_hostname=host).close()
except ssl.SSLCertVerificationError:
    # A certificate exists but does not cover this name — the edge does not
    # serve it. This is the borrow-not-possible signal.
    print("ssl:cert_name_mismatch")
    raise SystemExit(3)
except Exception as e:
    print(f"ssl:{type(e).__name__}")
    raise SystemExit(3)
finally:
    try:
        raw.close()
    except Exception:
        pass
print("ok")
PY
}

# Probe up to 3 addresses; print "YES <ip>" on the first success.
probe_ips() {
  local host=$1
  shift
  local ip out tried=0 last="none"
  for ip in "$@"; do
    [ -z "$ip" ] && continue
    tried=$((tried + 1))
    [ "$tried" -gt 3 ] && break
    if out=$(tls_probe "$host" "$ip" 2>&1); then
      printf 'YES %s\n' "$ip"
      return 0
    fi
    last=$out
  done
  printf 'NO %s\n' "$last"
  return 1
}

echo "Harvesting a CDN edge address for borrow tests..."
if EDGE=$(discover_edge_ip6); then
  echo "Edge: $EDGE"
else
  EDGE=""
  echo "WARNING: no edge AAAA harvested; set EDGE_IP6=... to test borrowing." >&2
fi
echo

printf '%-46s %-7s %-7s %-10s %-7s %s\n' HOST DNS_A6 NATIVE DUALSTACK BORROW DETAIL
printf '%.0s-' {1..126}; echo

for h in $HOSTS; do
  [ -z "${h// }" ] && continue

  chain=$(cname_chain "$h" || true)
  addrs=$(dig_aaaa "$h")
  n=$(printf '%s\n' "$addrs" | awk 'NF' | wc -l | tr -d ' ')

  detail=""
  [ -n "$chain" ] && detail="cname:$(echo $chain | tr ' ' '>')"

  dns=NO; native='-'; dualstack='-'; borrow='-'

  if [ "$n" -gt 0 ]; then
    dns=YES
    # shellcheck disable=SC2086
    result=$(probe_ips "$h" $addrs || true)
    if [ "${result%% *}" = YES ]; then
      native=YES
      detail="${detail:+$detail; }native=${result#* } (${n} AAAA)"
    else
      native=NO
      detail="${detail:+$detail; }native_fail:${result#* }"
    fi
  else
    detail="${detail:+$detail; }no AAAA on name or CNAME chain"

    # Rung 2: the dual-stack view of the same CDN mapping.
    for hop in $h $chain; do
      case $hop in dualstack.*) continue ;; esac
      ds_addrs=$(dig_aaaa "dualstack.$hop")
      [ -z "$ds_addrs" ] && continue
      # shellcheck disable=SC2086
      ds_result=$(probe_ips "$h" $ds_addrs || true)
      if [ "${ds_result%% *}" = YES ]; then
        dualstack=YES
        detail="$detail; dualstack.$hop=${ds_result#* }"
        break
      fi
      dualstack=NO
    done
  fi

  # Rung 3: borrow a foreign edge of the same CDN.
  if [ -n "$EDGE" ] && [ "$dualstack" != YES ]; then
    if out=$(tls_probe "$h" "$EDGE" 2>&1); then
      borrow=YES
      detail="$detail; borrow_ok=$EDGE"
    else
      borrow=NO
      detail="$detail; borrow_fail:$out"
    fi
  fi

  printf '%-46s %-7s %-7s %-10s %-7s %s\n' "$h" "$dns" "$native" "$dualstack" "$borrow" "$detail"
done

cat <<'NOTE'

判读 / How to read this:
  DNS_A6=YES + NATIVE=YES        → 有真实 AAAA，直连可用（代理走 native 路径）
  DNS_A6=NO  + DUALSTACK=YES     → 无 AAAA，但同一 CDN 的 dualstack 映射可用
                                   （代理走 dualstack 路径，保真度最高）
  DNS_A6=NO  + BORROW=YES        → 无 AAAA，借用同 CDN 的其他边缘节点可用
                                   （代理走 cdn-borrow 路径）
  BORROW=NO (cert_name_mismatch) → 该边缘节点不服务此域名，不能借用
  全部为 NO                       → 纯 IPv6 无法到达；需要 NAT64_PREFIX 或 IPv4 出口

The proxy performs exactly these checks at connect time and caches the result;
`GET /api/v1/resolver/check?host=<host>` reports what it decided.

Do not use ping — ICMP is frequently blocked and proves nothing here.
NOTE
