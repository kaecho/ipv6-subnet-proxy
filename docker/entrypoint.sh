#!/bin/sh
set -e

if [ -w /proc/sys/net/ipv6/ip_nonlocal_bind ]; then
  echo 1 > /proc/sys/net/ipv6/ip_nonlocal_bind
  echo "Enabled net.ipv6.ip_nonlocal_bind"
fi

# A 6in4 tunnel needs the kernel's sit module. Modules live in the host kernel,
# so a container can only load one when /lib/modules is mounted and it holds
# CAP_SYS_MODULE; otherwise the host has to have loaded it already.
if [ -n "${HE_TUNNEL_SERVER_IPV4:-}${HE_TUNNEL_ID:-}" ] && [ ! -e /sys/class/net/sit0 ]; then
  modprobe sit 2>/dev/null || true
  if [ ! -e /sys/class/net/sit0 ]; then
    echo "warning: the sit (6in4) kernel module is not loaded — the tunnel will fail to come up."
    echo "         Run 'modprobe sit' on the HOST (persist with /etc/modules-load.d/sit.conf)."
  fi
fi

# WARP is WireGuard, which is a kernel module too. There is no always-present
# device to test for the way sit0 exists, so ask the kernel whether it knows the
# link type at all.
case "${WARP_ENABLED:-}" in
  1|true|TRUE|True|yes|YES|on|ON)
    modprobe wireguard 2>/dev/null || true
    if ! ip link add dev warpprobe type wireguard 2>/dev/null; then
      echo "warning: the wireguard kernel module is not available — WARP links will fail to come up."
      echo "         Run 'modprobe wireguard' on the HOST (persist with /etc/modules-load.d/wireguard.conf),"
      echo "         and make sure the container has --cap-add=NET_ADMIN."
    else
      ip link del warpprobe 2>/dev/null || true
    fi
    ;;
esac

exec node /app/dist/index.js
