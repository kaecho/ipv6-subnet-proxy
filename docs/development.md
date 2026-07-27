# Development

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Tests (node:test, no network access required)
npm test

# Build
npm run build
```

### Project Structure

```
src/
├── index.ts                    # Entry point
├── config.ts                   # Environment configuration
├── database/
│   ├── connection.ts           # SQLite singleton
│   └── migrations.ts           # Schema migrations
├── core/
│   ├── ip-allocator.ts         # IPv6 address allocation
│   ├── users.ts                # User management
│   ├── subnets.ts              # Subnet management
│   ├── sessions.ts             # Session tracking
│   ├── traffic.ts              # Traffic accounting
│   ├── rate-limiter.ts         # Rate limiting
│   ├── target-resolver.ts      # IPv6 fallback ladder + edge verification
│   ├── cdn-providers.ts        # Known anycast CDN fingerprints and seeds
│   ├── tunnel.ts               # 6in4 tunnel bring-up, routing, verification
│   ├── tunnelbroker.ts         # tunnelbroker.net API + endpoint updates
│   ├── warp.ts                 # WARP WireGuard links, routing, verification
│   ├── warp-api.ts             # Cloudflare WARP device registration
│   └── audit.ts                # Audit logging
├── socks5/
│   └── server.ts               # SOCKS5 protocol implementation
├── api/
│   ├── server.ts               # Fastify server setup
│   ├── middleware/
│   │   └── auth.ts             # API key authentication
│   └── routes/
│       ├── health.ts           # Health check endpoints
│       ├── users.ts            # User CRUD endpoints
│       ├── subnets.ts          # Subnet CRUD endpoints
│       ├── bindings.ts         # User-subnet binding endpoints
│       ├── sessions.ts         # Session management endpoints
│       ├── traffic.ts          # Traffic stats endpoints
│       ├── limits.ts           # Rate limit endpoints
│       ├── audit.ts            # Audit log endpoints
│       ├── resolver.ts         # IPv6 fallback diagnostics
│       ├── tunnel.ts           # Tunnel status and control
│       └── warp.ts             # WARP status and control
└── utils/
    ├── ipv6.ts                 # IPv6 address utilities
    └── logger.ts               # Pino logger

test/
├── target-resolver.test.ts     # Fallback ladder tests (node:test)
├── tunnel.test.ts              # Tunnel parsing, spec resolution, ip command plans
└── warp.test.ts                # WARP keys, registration parsing, ip/wg command plans

scripts/
└── check-ipv6.sh               # Offline IPv6 reachability check
```

---
