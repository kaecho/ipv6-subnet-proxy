---
layout: home

hero:
  name: IPv6 Subnet Proxy
  text: Rotate egress across an IPv6 subnet
  tagline: SOCKS5 proxy with WARP / 6in4 tunnel support, REST API, and per-user limits
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/kaecho/ipv6-subnet-proxy
    - theme: alt
      text: 中文
      link: /zh/

features:
  - title: SOCKS5 + REST API
    details: RFC 1928/1929 CONNECT proxy on :1080, Fastify management API on :3000
  - title: Free IPv6 if the host has none
    details: Built-in Cloudflare WARP (no signup) and Hurricane Electric 6in4 tunnel client
  - title: Per-user allocation
    details: Random or sticky IPv6 chosen by SOCKS5 username; rate limits, traffic stats, audit log
  - title: CDN edge borrowing
    details: Reach AAAA-less names over IPv6 through dual-stack CDN edges
---
