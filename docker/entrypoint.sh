#!/bin/sh
set -e

# Host-network containers share the host's /proc/sys, but it is often mounted
# read-only inside the container. [ -w ] can still report true, so never let a
# failed write abort startup under set -e — set the sysctl on the HOST instead:
#   sysctl -w net.ipv6.ip_nonlocal_bind=1
#   echo net.ipv6.ip_nonlocal_bind=1 | tee /etc/sysctl.d/99-ipv6-proxy.conf
if [ -f /proc/sys/net/ipv6/ip_nonlocal_bind ]; then
  current=$(cat /proc/sys/net/ipv6/ip_nonlocal_bind 2>/dev/null || true)
  if [ "$current" != "1" ]; then
    # Subshell swallows the shell's "can't create … Read-only file system" noise.
    # Must stay inside `if` so a failed write never trips set -e.
    if (echo 1 > /proc/sys/net/ipv6/ip_nonlocal_bind) 2>/dev/null; then
      echo "Enabled net.ipv6.ip_nonlocal_bind"
    else
      echo "warning: could not set net.ipv6.ip_nonlocal_bind=1 (read-only /proc)."
      echo "         Set it on the HOST before starting the container:"
      echo "           sysctl -w net.ipv6.ip_nonlocal_bind=1"
      echo "           echo net.ipv6.ip_nonlocal_bind=1 | tee /etc/sysctl.d/99-ipv6-proxy.conf"
    fi
  fi
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
