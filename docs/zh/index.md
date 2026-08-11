---
layout: home

hero:
  name: IPv6 子网代理
  text: 在 IPv6 子网中轮换出口地址
  tagline: 支持 WARP / 6in4 隧道的 SOCKS5 代理，附带 REST API 与用户级限速
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/kaecho/ipv6-subnet-proxy
    - theme: alt
      text: English
      link: /

features:
  - title: SOCKS5 + REST API
    details: :1080 上的 RFC 1928/1929 CONNECT 代理，:3000 上的 Fastify 管理 API
  - title: 宿主机没有 IPv6 也能用
    details: 内置 Cloudflare WARP（免注册）与 Hurricane Electric 6in4 隧道客户端
  - title: 用户级地址分配
    details: sticky / random 两种模式，速率限制、流量统计、审计日志
  - title: CDN 边缘借用
    details: 无 AAAA 的域名也可经双栈 CDN 边缘走 IPv6 访问
---
