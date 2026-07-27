# Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   IPv6 Subnet Proxy                       │
│                                                           │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │  SOCKS5   │    │         Fastify API (port 3000)   │    │
│  │  Server   │    │  ┌─────┐ ┌──────┐ ┌──────────┐  │    │
│  │ (port 1080)│    │  │Users│ │Subnet│ │Sessions  │  │    │
│  │           │    │  │Route│ │Route │ │Route     │  │    │
│  │  Auth     │    │  └─────┘ └──────┘ └──────────┘  │    │
│  │  (RFC1929)│    │  ┌──────┐ ┌──────┐ ┌────────┐  │    │
│  │           │    │  │Traffic│ │Limits│ │Audit   │  │    │
│  │  Connect  │    │  │Route │ │Route │ │Route   │  │    │
│  │  Handler  │    │  └──────┘ └──────┘ └────────┘  │    │
│  └─────┬─────┘    └──────────────────────────────────┘    │
│        │                        │                          │
│        └──────────┬─────────────┘                          │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │    Core Modules      │                             │
│        │  ┌──────────────┐   │                             │
│        │  │ IP Allocator │   │                             │
│        │  │  (sticky/    │   │                             │
│        │  │   random)    │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  UserManager │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ SubnetManager│   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  RateLimiter │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ TrafficStats │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │ AuditLogger  │   │                             │
│        │  └──────────────┘   │                             │
│        └──────────┬──────────┘                             │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │   SQLite (WAL mode) │                             │
│        │   /data/proxy.db    │                             │
│        └─────────────────────┘                             │
└──────────────────────────────────────────────────────────┘

         ┌──────┐     SOCKS5        ┌────────────┐
         │Client│◄─────────────────►│  Target    │
         │      │   (IPv6 bind)     │  Server    │
         └──────┘                   └────────────┘
```

The application is a single process hosting two servers:

- **SOCKS5 server** on port `1080` — accepts client connections, authenticates via username/password, allocates an IPv6 address from the user's bound subnets, and relays traffic.
- **REST API server** on port `3000` — Fastify-based HTTP API for management. All endpoints (except `/health`) require `X-API-Key` header authentication.

Both servers share the same core modules and SQLite database.

---
