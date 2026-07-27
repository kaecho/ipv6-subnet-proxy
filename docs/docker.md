# Docker

### Building

```bash
docker build -f docker/Dockerfile -t ipv6-subnet-proxy .
```

### docker-compose

```yaml
services:
  ipv6-proxy:
    build:
      context: .
      dockerfile: docker/Dockerfile
    environment:
      - API_KEY=changeme
      - LOG_LEVEL=info
      # - WARP_ENABLED=true
      # - WARP_ACCOUNTS=8
      # - HE_TUNNEL_ID=...
      # - HE_TUNNEL_USERNAME=...
      # - HE_TUNNEL_UPDATE_KEY=...
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

Host prerequisites (set **on the host**, not in compose):

```bash
# Required: bind to addresses not assigned to any interface
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

# Only if bringing up free IPv6 from inside the container
sudo modprobe wireguard   # WARP
sudo modprobe sit         # 6in4 tunnel broker
```

> **`network_mode: host` is required.** Port mappings are advisory; the container uses the host network stack. Compose `sysctls:` are ignored under host networking — set `ip_nonlocal_bind` on the host as above. Free IPv6 modules (`sit` / `wireguard`) also live in the host kernel; the image ships `iproute2` and `wireguard-tools`.

See [No IPv6 on the Host](/no-ipv6) for WARP / tunnel setup.
