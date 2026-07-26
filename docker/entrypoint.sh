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

exec node /app/dist/index.js
