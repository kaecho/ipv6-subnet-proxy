# Quick Start

### Prerequisites

- Linux with `net.ipv6.ip_nonlocal_bind=1` and `iproute2` installed
- IPv6 connectivity — either native, or free from [Cloudflare WARP or a tunnel broker](/no-ipv6), both of which need only IPv4 on the host
- Node.js 20+ (for manual deployment)
- Docker (for container deployment)

### Docker (recommended)

```bash
# On the HOST first (network_mode: host cannot set this from the container)
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

git clone https://github.com/kaecho/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# Edit docker/docker-compose.yml → API_KEY (and WARP_ENABLED / HE_* if needed)
docker compose -f docker/docker-compose.yml up -d --build
```

### Manual

```bash
# Clone and install
git clone https://github.com/kaecho/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy
npm install
npm run build

# Set required API key. Host interface prefixes are not used unless
# DETECT_HOST_SUBNETS=true. A tunnel or WARP brings its own prefix.
export API_KEY=your-secret-api-key

# Optional: register one prefix yourself
export DEFAULT_SUBNET=2001:db8:1::/64

# Start
npm start
```

With `DETECT_HOST_SUBNETS=true` and no `DEFAULT_SUBNET`, startup also registers prefixes found on host interfaces.

### Verify

```bash
# Health check
curl http://localhost:3000/health

# Create a user — all active subnets are automatically bound
curl -X POST http://localhost:3000/api/v1/users \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret123"}'
```

Users are automatically bound to all registered subnets on creation — no manual binding needed. You can still manage subnets and bindings via the API for advanced use cases.

# Add a subnet
curl -X POST http://localhost:3000/api/v1/subnets \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"cidr": "2001:db8:1::/64"}'

# Bind user to subnet
curl -X POST http://localhost:3000/api/v1/users/<USER_ID>/bindings \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"subnet_id": "<SUBNET_ID>"}'
```

Now use the SOCKS5 proxy at `localhost:1080` with username `alice` and password `secret123`. That username gives a random address per connection. Use `alice-sticky` for a fixed address, or `alice-sticky-<key>` to switch addresses by changing the key. See [SOCKS5 usage](/socks5#username-selected-address-mode).

---
