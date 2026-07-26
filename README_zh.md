# IPv6 子网代理

[English](README.md) | [中文](README_zh.md)

一个基于 Node.js TypeScript 的 SOCKS5 代理服务，能够将出站连接分布到托管 `/64` 子网中的不同 IPv6 地址。包含 REST 管理 API、SQLite 持久化存储、用户级速率限制、流量统计和审计日志功能。

---

## 目录

- [功能特性](#功能特性)
- [架构设计](#架构设计)
- [快速开始](#快速开始)
- [宿主机没有 IPv6？](#宿主机没有-ipv6)
  - [方案一：Cloudflare WARP](#方案一cloudflare-warp免注册)
  - [方案二：隧道代理商](#方案二隧道代理商一整段路由前缀)
- [配置说明](#配置说明)
- [SOCKS5 代理使用](#socks5-代理使用)
- [访问无 IPv6 解析的域名](#访问无-ipv6-解析的域名)
- [REST API 参考](#rest-api-参考)
  - [健康检查](#健康检查)
  - [用户管理](#用户管理)
  - [子网管理](#子网管理)
  - [绑定管理](#绑定管理)
  - [会话管理](#会话管理)
  - [流量统计](#流量统计)
  - [速率限制](#速率限制)
  - [审计日志](#审计日志)
  - [解析诊断](#解析诊断)
  - [隧道管理](#隧道管理)
  - [WARP 管理](#warp-管理)
- [数据模型](#数据模型)
- [速率限制机制](#速率限制机制)
- [开发指南](#开发指南)
- [Docker 部署](#docker-部署)
- [CI/CD 持续集成](#cicd-持续集成)

---

## 功能特性

- **SOCKS5 密码认证** — 完整实现 RFC 1928（SOCKS5）和 RFC 1929（用户名/密码）协议。支持 CONNECT 命令；BIND 和 UDP ASSOCIATE 请求将被拒绝。
- **内置隧道代理商接入** — 宿主机本身没有 IPv6 也能部署：程序自行建立 6in4 隧道，并从隧道路由的前缀中分配地址。Hurricane Electric 免费提供一个 `/48`，即 2^80 个地址。详见[宿主机没有 IPv6？](#宿主机没有-ipv6)。
- **内置 Cloudflare WARP 接入** — 完全免注册的免费 IPv6：程序自行注册 WARP 设备，并为每台设备建立一条 WireGuard 链路，每条链路就是一个可供轮换的出口地址。详见[方案一：Cloudflare WARP](#方案一cloudflare-warp免注册)。
- **自动检测子网** — 启动时从宿主机网络接口自动检测 IPv6 子网，无需手动配置
- **用户级 IPv6 分配** — 两种分配模式：`sticky`（同一用户+子网对复用固定 IPv6 地址）和 `random`（每次连接随机分配新地址，默认）
- **CDN 边缘借用** — 未设置 AAAA 解析的站点，仍可通过其 CDN 的双栈边缘节点经 IPv6 访问；使用前先用证书验证。详见[访问无 IPv6 解析的域名](#访问无-ipv6-解析的域名)。
- **自动绑定** — 创建用户时自动绑定所有活跃子网
- **多子网管理** — 管理多个 `/64`（或任意前缀长度）子网，可为每个用户绑定任意子网组合
- **REST 管理 API** — 完整的用户、子网和绑定关系 CRUD 操作；查询活跃会话、流量统计、审计日志；管理速率限制。
- **速率限制** — 用户级并发连接数限制和令牌桶带宽限流。
- **流量统计** — 按用户、按日统计字节数（入站/出站）。
- **审计日志** — 所有管理操作均记录时间戳和操作者信息。
- **Docker 多架构** — 支持 `linux/amd64` 和 `linux/arm64` 架构镜像，发布至 GHCR。
- **SQLite 持久化** — 使用 WAL 模式的 SQLite 数据库，存储于持久卷中。

---

## 架构设计

```
┌──────────────────────────────────────────────────────────┐
│                   IPv6 子网代理                             │
│                                                           │
│  ┌──────────┐    ┌──────────────────────────────────┐    │
│  │ SOCKS5   │    │    Fastify API (端口 3000)        │    │
│  │ 服务器    │    │  ┌─────┐ ┌──────┐ ┌──────────┐  │    │
│  │(端口 1080)│    │  │用户 │ │子网  │ │会话      │  │    │
│  │           │    │  │路由 │ │路由  │ │路由      │  │    │
│  │ 认证      │    │  └─────┘ └──────┘ └──────────┘  │    │
│  │ (RFC1929) │    │  ┌──────┐ ┌──────┐ ┌────────┐  │    │
│  │           │    │  │流量  │ │限制  │ │审计    │  │    │
│  │ CONNECT   │    │  │路由  │ │路由  │ │路由    │  │    │
│  │ 处理      │    │  └──────┘ └──────┘ └────────┘  │    │
│  └─────┬─────┘    └──────────────────────────────────┘    │
│        │                        │                          │
│        └──────────┬─────────────┘                          │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │      核心模块        │                             │
│        │  ┌──────────────┐   │                             │
│        │  │ IP 分配器    │   │                             │
│        │  │  (sticky/    │   │                             │
│        │  │   random)    │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  用户管理器   │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  子网管理器   │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  速率限制器   │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  流量统计    │   │                             │
│        │  ├──────────────┤   │                             │
│        │  │  审计日志    │   │                             │
│        │  └──────────────┘   │                             │
│        └──────────┬──────────┘                             │
│                   │                                        │
│        ┌──────────▼──────────┐                             │
│        │  SQLite (WAL 模式)   │                             │
│        │  /data/proxy.db     │                             │
│        └─────────────────────┘                             │
└──────────────────────────────────────────────────────────┘

         ┌──────┐    SOCKS5        ┌────────────┐
         │客户端 │◄───────────────►│  目标服务器  │
         │      │   (IPv6 绑定)    │            │
         └──────┘                  └────────────┘
```

应用程序为单进程架构，运行两个服务：

- **SOCKS5 服务器**（端口 `1080`）— 接受客户端连接，使用用户名/密码进行认证，从用户绑定的子网中分配 IPv6 地址，并转发流量。
- **REST API 服务器**（端口 `3000`）— 基于 Fastify 的 HTTP 管理 API。除 `/health` 外，所有端点均需 `X-API-Key` 头进行认证。

两个服务共享相同的核心模块和 SQLite 数据库。

---

## 快速开始

### 前置要求

- 设置了 `net.ipv6.ip_nonlocal_bind=1` 并安装了 `iproute2` 的 Linux 系统
- IPv6 连通性 — 原生 IPv6，或[由 Cloudflare WARP / 隧道代理商免费提供](#宿主机没有-ipv6)（后两者只要求宿主机有 IPv4）
- Node.js 20+（手动部署时需要）
- Docker（容器部署时需要）

### Docker 部署（推荐）

```bash
# 克隆仓库
git clone https://github.com/your-username/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# 编辑 docker-compose.yml，设置 API_KEY 和 DEFAULT_SUBNET
# 然后启动
docker compose -f docker/docker-compose.yml up -d
```

### 手动部署

```bash
# 克隆并安装
git clone https://github.com/your-username/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy
npm install
npm run build

# 设置必需的 API Key（子网会从宿主机网卡自动检测）
export API_KEY=your-secret-api-key

# 可选：手动指定子网（如果没有检测到，或想补充额外的）
export DEFAULT_SUBNET=2001:db8:1::/64

# 启动
npm start
```

启动后，程序会自动从宿主机网络接口检测 IPv6 子网并注册。日志中可以看到类似输出：
```
info: Auto-registered detected IPv6 subnet { cidr: "2001:db8:1::/64" }
```

### 验证

```bash
# 健康检查
curl http://localhost:3000/health

# 创建用户（自动绑定所有已注册子网，无需手动绑定）
curl -X POST http://localhost:3000/api/v1/users \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret123"}'
```

用户创建后即自动绑定所有活跃子网，可直接使用代理。也可以通过 API 手动管理子网和绑定关系。

---

## 宿主机没有 IPv6？

要把连接分散到一个子网上，前提是得先有一个子网。而多数廉价 VPS 只给一个 `/128`，甚至完全不给 IPv6。有两条免费的路子，而且两者都由本程序代为接入 —— 不用敲 `wg-quick`，不用敲 `ip tunnel`，也不用写 systemd 单元：

| | Cloudflare WARP | 隧道代理商（6in4） |
|---|---|---|
| 注册 | 完全不需要 | 在 tunnelbroker.net 免费注册 |
| 拿到什么 | 每注册一台设备得到一个地址 | 一整个路由的 `/48` —— 2^80 个地址 |
| 承载方式 | WireGuard（UDP 2408） | 6in4（IP 协议号 41） |
| 内核要求 | `wireguard` 模块 | `sit` 模块 |
| 地址丰富度 | 取决于注册几个 | 基本无上限 |
| 适用场景 | 只想改一个环境变量就有 IPv6 | 想要一整段前缀来分散连接 |

两者互不影响 —— 同一台机器可以同时开，出口地址池就是二者的并集。如果只想快点跑起来，先用 WARP。

---

### 方案一：Cloudflare WARP（免注册）

[Cloudflare WARP](https://1.1.1.1) 免费向任何人发放一个全球可路由的 IPv6 地址，走 WireGuard 承载 —— 不需要账号、不需要邮箱、不需要付费。注册一台设备只是一次无需鉴权的 API 调用，这一步由本程序代你完成。

```bash
export WARP_ENABLED=true
```

配置到此为止。启动时程序会注册一台 WARP 设备，建立到 Cloudflare 的 WireGuard 链路，并把拿到的地址注册为可分配子网：

```
info: Registered a Cloudflare WARP device { slot: 0, address: "2606:4700:110:8921:bf06:c4d7:40b7:8afd", accountType: "free" }
info: WARP link is up { device: "warp0", endpoint: "162.159.192.1:2408", table: 51820, mtu: 1280 }
info: WARP verified: reached [2606:4700:4700::1111]:53
info: Registered IPv6 subnet { cidr: "2606:4700:110:8921:bf06:c4d7:40b7:8afd/128", source: "warp", boundUsers: 1 }
```

#### 一个账号只有一个地址

这是 WARP 最需要先弄明白的一点，也是它与隧道代理商唯一实质的区别：**Cloudflare 分配的是单个 `/128`，不是一段前缀。** 一次注册就等于一个固定的出口 IP。而本程序的核心用途正是把连接分散到多个地址上，只有一个显然不够。

所以就多注册几个：

```bash
export WARP_ENABLED=true
export WARP_ACCOUNTS=8
```

每个账号都会成为一块独立的 WireGuard 网卡（`warp0`…`warp7`），各自持有一个地址，每个地址再注册成一个"只有一个地址的子网"。接下来无需任何额外机制，程序原有的按用户选子网逻辑就自动完成了轮换：

- **`random` 模式的用户**：每建立一条连接换一个 WARP 地址。
- **`sticky` 模式的用户**：固定绑在某一个 WARP 地址上，重连后依旧不变。

注册信息会存进数据库并复用，因此重启后地址保持不变，也不会白白消耗 Cloudflare 的注册配额。想主动换一批地址，用 `WARP_RESET=true` 启动一次即可；被替换掉的旧地址会自动从地址池里剔除。

#### WARP+（可选）

WARP+ 授权密钥可以提高 Cloudflare 那边的配额。它不影响地址分配 —— 免费版本身就已经给了 IPv6 地址。

```bash
export WARP_LICENSE=xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxx
```

#### Docker 部署

```yaml
services:
  ipv6-proxy:
    image: ghcr.io/<your-username>/ipv6-subnet-proxy:latest
    environment:
      - API_KEY=changeme
      - WARP_ENABLED=true
      - WARP_ACCOUNTS=8
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

宿主机侧只有一个前置要求 —— WireGuard 是内核模块，容器无法自行加载宿主机的模块：

```bash
sudo modprobe wireguard
echo wireguard | sudo tee /etc/modules-load.d/wireguard.conf
```

`network_mode: host` 与 `cap_add: NET_ADMIN` 两者缺一不可：链路是建立在宿主机的网络命名空间里的。镜像已内置 `wireguard-tools`，`wg` 本身不需要另行安装。

#### 每条链路具体配置了什么

| 步骤 | 作用 |
|---|---|
| 到 Cloudflare anycast 端点的 WireGuard 设备 | 把 IPv6 封装进发往 `engage.cloudflareclient.com:2408` 的 UDP |
| 在该设备上配置分配到的 `/128` | 这既是出口地址，也是这条链路的全部地址池 |
| 策略路由规则 + 独立路由表 | **以该地址为源**的流量从这条链路出去 |

主路由表不会被写入任何内容。这里的 WARP 是给代理用的出口地址池，而不是给整台机器用的 VPN：宿主机自身的流量、以及它原有的原生 IPv6，都不受影响。规则优先级从 1520 起，排在主表（32766）之前，因此即便宿主机本身有 IPv6 默认路由，WARP 源地址的流量依然走 WARP。

建链过程是幂等的 —— 每条链路会先拆掉自己的设备再重建，所以重启和崩溃都不会留下需要手工清理的残留。

#### 状态检查

```bash
curl -s http://localhost:3000/api/v1/warp -H "X-API-Key: $API_KEY" | jq
```

`links[].up` 表示各设备是否建立成功，`links[].probe` 表示是否真的通了流量，`warnings` 汇总所有降级情况。`GET /api/v1/warp/accounts` 列出已注册的设备及其地址（不含密钥）。`POST /api/v1/warp/reconnect` 重建链路，`POST /api/v1/warp/verify` 重新探测。

如果某条链路 up 但探测失败，说明网卡建起来了而包在中途被丢了 —— 绝大多数情况是发往 2408 端口的 UDP 被封，或者 `wireguard` 模块没加载。

#### 需要知道的局限

WARP 的地址来自 Cloudflare 自有网段且被大量用户共享，因此会对 IP 信誉打分的站点通常会把它当作 VPN 流量对待。而隧道代理商的 `/48` 是你独占的，在目标站点看来完全是另一回事。按需要选择，或者两者都开，再把用户绑定到合适的地址池上。

---

### 方案二：隧道代理商（一整段路由前缀）

WARP 是一次注册给一个地址，而隧道代理商给的是一整段前缀。

[Hurricane Electric](https://tunnelbroker.net) 免费提供一个路由的 `/48`：1,208,925,819,614,629,174,706,176 个地址，经由 6in4 隧道交付，对宿主机的全部要求只有 IPv4 和内核的 `sit` 模块。**宿主机自身完全不需要 IPv6。**

隧道由本程序代为建立。在 tunnelbroker.net 上创建隧道，把凭据交给程序，剩下的它自己完成 —— 不用敲 `ip tunnel`，不用改 `/etc/network/interfaces`，也不用单独写一个 `he-ipv6.service`。

### 方式 A：使用账号凭据（推荐）

在 [tunnelbroker.net](https://tunnelbroker.net) 注册并创建 Regular Tunnel，在隧道页面点击 **Assign /48**，然后：

```bash
export HE_TUNNEL_ID=1033580          # 隧道页面的 "Tunnel ID"
export HE_TUNNEL_USERNAME=your-account
export HE_TUNNEL_PASSWORD=your-password
```

启动时，程序会通过 [tunnelbroker API](https://forums.he.net/index.php?topic=3153.0) 读取隧道的端点与路由前缀，把隧道指向本机当前的公网 IPv4，建立 `sit` 设备，并将路由前缀注册为可分配子网。日志会完整反映这一过程：

```
info: Fetched tunnel details from tunnelbroker.net { tunnelId: "1033580", routed48: "2001:470:ecf2::/48" }
info: Tunnel endpoint set to 203.0.113.9
info: 6in4 tunnel is up { device: "he-ipv6", routed: ["2001:470:ecf2::/48"], mtu: 1480 }
info: Tunnel verified: reached [2001:470:20::2]:53
info: Registered tunnel-routed IPv6 subnet { cidr: "2001:470:ecf2::/48" }
```

> 如果隧道设置了 **Update Key**（隧道页面的 *Advanced* 标签），HE 要求用该密钥而非账号密码：填入 `HE_TUNNEL_UPDATE_KEY`。部署它更安全 —— 它只能控制这一条隧道。

### 方式 B：直接填写隧道参数

不想把账号密码放到服务器上。从隧道页面抄四个值：

| 隧道页面字段 | 环境变量 |
|---|---|
| Server IPv4 Address | `HE_TUNNEL_SERVER_IPV4` |
| Client IPv6 Address | `HE_TUNNEL_CLIENT_IPV6` |
| Routed /48（和/或 Routed /64） | `HE_TUNNEL_ROUTED_PREFIXES` |
| Server IPv6 Address _（可选）_ | `HE_TUNNEL_SERVER_IPV6` |

```bash
export HE_TUNNEL_SERVER_IPV4=216.218.221.42
export HE_TUNNEL_CLIENT_IPV6=2001:470:1f04:17b::2/64
export HE_TUNNEL_ROUTED_PREFIXES=2001:470:8123::/48,2001:470:1f05:17b::/64
```

这些参数描述的是标准的 RFC 4213 6in4 隧道，所以方式 B 适用于任何隧道代理商，不限于 HE。只有 API 读取和端点更新这两项功能是 HE 专有的。

两种方式同时配置时，以环境变量为准 —— 适合只覆盖其中某一项而仍然使用 API。

### Docker 部署

```yaml
services:
  ipv6-proxy:
    image: ghcr.io/<your-username>/ipv6-subnet-proxy:latest
    environment:
      - API_KEY=changeme
      - HE_TUNNEL_ID=1033580
      - HE_TUNNEL_USERNAME=your-account
      - HE_TUNNEL_UPDATE_KEY=your-update-key
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

宿主机侧有两项前置条件，因为这里涉及的内核状态并不随容器隔离：

```bash
# 1. 6in4 内核模块。容器无法自行加载宿主机的模块。
sudo modprobe sit
echo sit | sudo tee /etc/modules-load.d/sit.conf

# 2. 允许绑定未配置在网卡上的地址。
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf
```

`network_mode: host` 和 `cap_add: NET_ADMIN` 二者缺一不可：隧道建立在宿主机的网络命名空间中。

### 程序具体做了什么

| 步骤 | 作用 |
|---|---|
| 建立指向代理商 IPv4 端点的 `sit` 设备 | 把 IPv6 封装进 IPv4 报文（协议号 41） |
| 在隧道链路上配置客户端地址 | 点对点链路的本端地址 |
| 为每个路由前缀添加策略规则和独立路由表 | **源地址属于**隧道前缀的流量才走隧道 |
| 为每个路由前缀添加 `local` 路由 | 使 `/48` 内的任意地址无需预先配置即可响应 |
| 在主路由表中添加默认路由 | 仅当宿主机自身没有默认路由时 —— 见 `HE_TUNNEL_DEFAULT_ROUTE` |

采用基于源地址的策略路由，是为了让**已有原生 IPv6 的机器**也能安全启用此功能：宿主机自身的流量继续走原生链路，只有来自隧道前缀的地址才走隧道。建立过程是幂等的 —— 它会先拆除自己的设备再重建，因此重启和崩溃都不会留下需要手动清理的残留。

### 动态公网 IP

6in4 隧道只在代理商记录的 *Client IPv4* 与本机实际公网地址一致时才通流量。配置了凭据后，程序每 15 分钟（`HE_TUNNEL_UPDATE_INTERVAL_MS`）复查一次公网 IPv4，发生变化时自动更新隧道并重建设备。家庭宽带和重装的 VPS 都能自行恢复。

### NAT 环境

隧道依然可用：把隧道锚定到内网地址，并在路由器上把 IP 协议 41 转发到本机（是协议 41 本身，不是某个 TCP/UDP 端口）。

```bash
export HE_TUNNEL_LOCAL_IPV4=192.168.1.20
```

不设置时程序会自行探测，并在日志中警告它选用了哪个地址。

### 状态检查

```bash
curl -s http://localhost:3000/api/v1/tunnel -H "X-API-Key: $API_KEY" | jq
```

`up` 表示设备是否建立成功，`probes` 表示是否真的有流量通过隧道，`warnings` 汇总所有降级项 —— 缺失的 sysctl、被拒绝的凭据、不支持策略路由的内核等。`POST /api/v1/tunnel/reconnect` 可重建隧道，`POST /api/v1/tunnel/verify` 可重新探测。

如果 `up` 为 true 但所有探测都失败，说明设备在本地建好了，而报文在中途被丢弃。按可能性排序：代理商记录的 Client IPv4 与本机不符、协议 41 被服务商或前置 NAT 过滤、`sit` 模块未加载。

---

## 配置说明

所有配置通过环境变量进行设置：

| 变量 | 默认值 | 描述 |
|---|---|---|
| `API_KEY` | _(必需)_ | REST API 认证的 API 密钥 |
| `SOCKS5_PORT` | `1080` | SOCKS5 代理监听端口 |
| `API_PORT` | `3000` | REST API 监听端口 |
| `API_HOST` | `0.0.0.0` | REST API 绑定地址 |
| `DB_PATH` | `/data/proxy.db` | SQLite 数据库文件路径 |
| `DEFAULT_SUBNET` | — | 启动时自动注册子网（CIDR 格式） |
| `DEFAULT_SUBNET_GATEWAY` | — | 默认子网的网关地址 |
| `BCRYPT_ROUNDS` | `10` | 密码哈希的 bcrypt 轮次 |
| `LOG_LEVEL` | `info` | 日志级别：`trace`、`debug`、`info`、`warn`、`error`、`fatal` |

### Cloudflare WARP

免注册的免费 IPv6，详见[方案一：Cloudflare WARP](#方案一cloudflare-warp免注册)。默认关闭，需设置 `WARP_ENABLED=true`；其余项都有可用的默认值。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WARP_ENABLED` | `false` | 注册 WARP 设备并为每台设备建立一条 WireGuard 链路 |
| `WARP_ACCOUNTS` | `1` | 注册的设备数量（1-64）。**每台设备就是一个出口地址** —— 想要地址池轮换就调大它 |
| `WARP_LICENSE` | — | WARP+ 授权密钥。可选，免费版本身就已提供地址 |
| `WARP_RESET` | `false` | 丢弃已保存的注册信息并重新注册。会更换全部 WARP 地址，旧地址自动从地址池剔除 |
| `WARP_REGISTER_SUBNETS` | `true` | 把每个分配到的地址注册为单地址（`/128`）可分配子网 |
| `WARP_DEVICE_PREFIX` | `warp` | 网卡名 = 此前缀 + 槽位号，即 `warp0`、`warp1`… |
| `WARP_MTU` | `1280` | 链路 MTU。1280 是 IPv6 最小 MTU，也是 WARP 客户端的取值 |
| `WARP_ROUTE_TABLE` | `51820` | 起始路由表号，槽位 N 使用该值加 N |
| `WARP_RULE_PRIORITY` | `1520` | 起始规则优先级，槽位 N 使用该值加 N。必须小于 32766，否则规则会排在主表之后而失效 |
| `WARP_KEEPALIVE` | `25` | WireGuard persistent-keepalive 秒数，用于保持 NAT 映射 |
| `WARP_ENDPOINT` | `engage.cloudflareclient.com:2408` | Cloudflare 的 WireGuard 端点，API 未返回时使用。DNS 不稳时可填字面地址 |
| `WARP_VERIFY` | `true` | 建链后探测每条链路并汇报结果 |
| `WARP_VERIFY_HOST` | `2606:4700:4700::1111` | 探测目标（Cloudflare 的解析器，支持 TCP） |
| `WARP_VERIFY_PORT` | `53` | 探测端口 |
| `WARP_TEARDOWN_ON_EXIT` | `true` | 退出时删除设备、路由和规则 |
| `WARP_REGISTER_DELAY_MS` | `1500` | 两次注册之间的间隔。Cloudflare 会对突发注册限流 |
| `WARP_API_URL` | `https://api.cloudflareclient.com/v0a2158/reg` | 设备注册 API |
| `WARP_CLIENT_VERSION` | `a-6.10-2158` | 注册请求携带的 `CF-Client-Version` 头 |
| `WARP_USER_AGENT` | `okhttp/3.12.1` | 注册请求携带的 User-Agent |
| `WARP_REQUEST_TIMEOUT_MS` | `15000` | 上述 API 调用的超时时间 |

### 隧道代理商（6in4）

在没有 IPv6 的宿主机上接入隧道前缀，详见[方案二：隧道代理商](#方案二隧道代理商一整段路由前缀)。只要配置了账号凭据或手动端点参数，隧道功能即自动启用。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HE_TUNNEL_ENABLED` | _(自动)_ | 配置了凭据或手动端点参数时自动开启。设为 `false` 可保留配置但不启用 |
| `HE_TUNNEL_ID` | — | tunnelbroker.net 隧道页面的 Tunnel ID |
| `HE_TUNNEL_USERNAME` | — | tunnelbroker.net 账号名 |
| `HE_TUNNEL_PASSWORD` | — | 账号密码。隧道设置了 Update Key 时不使用此项 |
| `HE_TUNNEL_UPDATE_KEY` | — | 隧道级 Update Key（隧道 → *Advanced*）。设置后必须用它替代密码，且部署更安全 |
| `HE_TUNNEL_SERVER_IPV4` | _(取自 API)_ | 代理商侧 IPv4 端点 —— "Server IPv4 Address" |
| `HE_TUNNEL_SERVER_IPV6` | _(取自 API)_ | 代理商侧 IPv6 地址 —— "Server IPv6 Address" |
| `HE_TUNNEL_CLIENT_IPV6` | _(取自 API)_ | 本机在隧道链路上的地址，如 `2001:470:1f04:17b::2/64` |
| `HE_TUNNEL_ROUTED_PREFIXES` | _(取自 API)_ | 逗号分隔的隧道路由前缀，这些前缀将成为可分配子网 |
| `HE_TUNNEL_LOCAL_IPV4` | _(自动探测)_ | 隧道锚定的本地 IPv4。NAT 环境下填内网地址 |
| `HE_TUNNEL_DEVICE` | `he-ipv6` | 创建的 `sit` 设备名 |
| `HE_TUNNEL_MTU` | `1480` | 隧道 MTU。1480 是 6in4 在 1500 字节路径上的余量 |
| `HE_TUNNEL_TTL` | `255` | 外层 IPv4 报文的 TTL |
| `HE_TUNNEL_ROUTE_TABLE` | `1470` | 隧道流量使用的路由表号，同时用作规则优先级 |
| `HE_TUNNEL_DEFAULT_ROUTE` | `auto` | `auto` 仅在宿主机没有默认路由时添加；`always` 总是添加；`never` 不改动主路由表 |
| `HE_TUNNEL_FORWARDING` | `false` | 开启 `net.ipv6.conf.all.forwarding`。仅在需要把前缀转发给其他主机时使用 |
| `HE_TUNNEL_REGISTER_SUBNETS` | `true` | 启动时把路由前缀注册为可分配子网 |
| `HE_TUNNEL_UPDATE_ENDPOINT` | _(有凭据时开启)_ | 启动时把隧道指向本机公网 IPv4 |
| `HE_TUNNEL_UPDATE_INTERVAL_MS` | `900000` | 公网 IPv4 复查间隔，变化时自动更新。`0` 为关闭，最小值限制为 60 秒 |
| `HE_TUNNEL_VERIFY` | `true` | 建立完成后探测隧道并报告结果 |
| `HE_TUNNEL_VERIFY_HOST` | `2001:470:20::2` | 探测目标（HE 的 anycast DNS，支持 TCP 查询） |
| `HE_TUNNEL_VERIFY_PORT` | `53` | 探测端口 |
| `HE_TUNNEL_TEARDOWN_ON_EXIT` | `true` | 退出时移除设备、路由和规则 |
| `HE_TUNNEL_PUBLIC_IPV4_URL` | `https://checkip.amazonaws.com` | 查询本机公网 IPv4 的地址 |
| `HE_TUNNEL_API_URL` | `https://tunnelbroker.net/tunnelInfo.php` | 隧道信息 API |
| `HE_TUNNEL_UPDATE_URL` | `https://ipv4.tunnelbroker.net/nic/update` | 端点更新 API（dyndns 协议） |
| `HE_TUNNEL_REQUEST_TIMEOUT_MS` | `10000` | 上述 API 调用的超时时间 |

### IPv6 回退配置

以下变量控制代理如何访问没有 AAAA 解析的域名。默认值已适用于绝大多数场景，通常无需调整。详见[访问无 IPv6 解析的域名](#访问无-ipv6-解析的域名)。

| 变量 | 默认值 | 描述 |
|---|---|---|
| `CDN_FALLBACK_ENABLED` | `true` | 是否启用回退链。设为 `false` 时，无 AAAA 的域名直接失败 |
| `CDN_FALLBACK_VERIFY` | `true` | 借用边缘节点前先用 TLS 握手验证。关闭后速度更快，但可能把证书错误暴露给客户端 |
| `CDN_FALLBACK_PORTS` | `80,443` | 允许借用的端口。CDN 边缘节点不会监听任意端口 |
| `CDN_FALLBACK_EDGES` | — | 手动指定可用边缘节点：`cloudfront=2600:9000::1,2600:9000::2;fastly=2a04:4e42::1`。纯地址列表适用于所有 CDN |
| `CDN_FALLBACK_RESOLVERS` | _(系统)_ | 回退查询使用的 DNS 服务器，如 `1.1.1.1,8.8.8.8`。本地 DNS 会过滤 AAAA 记录时尤其有用 |
| `CDN_FALLBACK_PROBE_ALL` | `true` | 无法识别 CDN 时，尝试所有已知边缘池 |
| `CDN_FALLBACK_LEARN` | `true` | 记录已知 CDN 双栈主机上观察到的边缘地址，用真实流量保持边缘池新鲜 |
| `CDN_FALLBACK_MAX_PROBES` | `6` | 单个目标的验证探测次数上限 |
| `CDN_FALLBACK_PROBE_TIMEOUT_MS` | `5000` | 单次探测超时 |
| `CDN_FALLBACK_DNS_TIMEOUT_MS` | `3000` | 单次 DNS 查询超时 |
| `CDN_FALLBACK_TTL_MS` | `600000` | 成功路由的缓存时长（10 分钟） |
| `CDN_FALLBACK_NEGATIVE_TTL_MS` | `60000` | 失败结果的缓存时长（1 分钟） |
| `CDN_FALLBACK_EDGE_TTL_MS` | `1800000` | 边缘池的有效期（30 分钟） |
| `CDN_FALLBACK_CACHE_MAX` | `4096` | 路由缓存条目上限 |
| `NAT64_PREFIX` | — | 可选的 NAT64 `/96` 前缀（如 `64:ff9b::/96`），用于纯 IPv4 目标。需要可达的 NAT64 网关 |

---

## SOCKS5 代理使用

使用任意 SOCKS5 客户端，配置以下参数：

- **地址**：代理服务器 IP 或主机名
- **端口**：`1080`（或自定义的 `SOCKS5_PORT`）
- **协议**：SOCKS5
- **认证**：用户名 / 密码
- **用户名**：已创建用户的用户名
- **密码**：对应的密码

代理仅支持 TCP CONNECT 命令。BIND 和 UDP ASSOCIATE 请求将被拒绝（返回 `0x07` 命令不支持）。

### 用户地址模式

用户可在两种 IPv6 分配模式下运行：

- **random**（默认）：每次连接从子网中随机生成新的 IPv6 地址。
- **sticky**：每个用户+子网对分配一个固定 IPv6 地址。该地址在重连后保持不变，直到通过 `POST /users/:id/refresh` 显式刷新。

### IPv6 内核要求

主机必须设置 `net.ipv6.ip_nonlocal_bind=1`，以允许绑定到未分配给任何本地接口的 IPv6 地址：

```bash
sysctl -w net.ipv6.ip_nonlocal_bind=1
```

若要永久生效，请将 `net.ipv6.ip_nonlocal_bind=1` 添加到 `/etc/sysctl.conf` 或 `/etc/sysctl.d/99-ipv6.conf`。

---

## 访问无 IPv6 解析的域名

纯 IPv6 出口通常只能访问设置了 AAAA 记录的域名。这看似排除了互联网的很大一部分，但实际情况远没有 DNS 显示的那么糟。

这类站点大多位于 anycast CDN 之后。CDN 边缘节点本身是双栈的，它根据 TLS SNI 或 HTTP `Host` 头选择回源目标，而不是根据目标 IP——**因此无论站点是否设置 AAAA 解析，边缘节点都会通过 IPv6 提供服务**。在 DNS 中发布 IPv6 是客户侧的一个开关，而能否经 IPv6 访问则是边缘节点集群的固有属性。本代理正是利用了这两者之间的落差。

由于 SOCKS5 在 TCP 层是透明转发，客户端自己的 SNI 和 `Host` 头会原样传递，只有目标地址被改变。

### 回退链

每次 CONNECT 都会按以下顺序解析目标，第一个成功的即被采用：

| 层级 | 工作方式 |
|---|---|
| `native` | 域名自身有 AAAA 记录，直接使用，不做探测 |
| `dualstack` | `dualstack.<cname 节点>` 有 AAAA 记录。Fastly、Akamai、AWS ELB 和 CloudFront 都发布这一变体——同一 CDN、同一映射，只是它的 IPv6 视图。借用保真度最高 |
| `cdn-borrow` | 通过 CNAME 链或目标 IPv4 地址的 PTR 记录识别 CDN，然后借用同一 CDN 的其他边缘节点 |
| `nat64` | 由 `NAT64_PREFIX` 合成地址。未配置时不启用 |

### 验证机制

借用绝不基于猜测。在正式使用某个边缘节点前，代理会先对它发起一次 TLS 握手，SNI 设为目标域名并完整校验证书。不服务该域名的节点会验证失败并被丢弃——这样一次错误的猜测只会变成一次干净的连接失败，而不会在用户浏览器里变成证书错误。

在 80 端口上没有证书可校验，因此先在 443 端口用 TLS 验证该节点；只有在此之后，HTTP `Host` 探测才作为兜底证明。

验证通过的路由缓存 10 分钟，失败结果缓存 1 分钟，因此探测开销按域名支付一次，而不是按连接支付。如果某条缓存路由的所有地址后续都连接失败，该条目会被丢弃，下次请求重新走一遍回退链。

### 借用的边缘节点从哪来

按优先级依次为：运维通过 `CDN_FALLBACK_EDGES` 手动指定的地址；**从实际流量中学习到的地址**（任何已知 CDN 的双栈主机本身就是该 CDN 边缘集群的一个样本）；以及内置的各 CDN 种子域名列表。学习机制使该功能不依赖于内置种子域名长期保持双栈。

### 检测某个域名

`scripts/check-ipv6.sh` 可在代理之外独立执行同样的检查：

```bash
./scripts/check-ipv6.sh support.apple.com build.nvidia.com
```

```
HOST                  DNS_A6  NATIVE  DUALSTACK  BORROW  DETAIL
support.apple.com     NO      -       -          YES     cname:prod-support.apple-support.akadns.net; borrow_ok=2600:1413:...
www.akamai.com        YES     YES     -          YES     native=2600:1413:5000:35::173d:ca51 (2 AAAA)
```

对运行中的代理，`GET /api/v1/resolver/check?host=<域名>` 会返回它实际的判定结果，包括 CNAME 链、识别出的 CDN，以及所选地址是否已通过验证。

### 局限

借用只对确实位于受支持 CDN 之后的站点有效。若某域名只有单一的纯 IPv4 源站，则不存在任何 IPv6 路径——这种情况下需要配置 `NAT64_PREFIX` 并具备可达的 NAT64 网关，或者提供 IPv4 出口。代理会返回 `0x04`（主机不可达）而不是一直挂起。

---

## REST API 参考

所有 API 端点均以 `/api/v1` 作为前缀。除健康检查端点外，所有请求均需通过 `X-API-Key` 头进行认证。

### 健康检查

| 方法 | 路径 | 描述 | 认证 |
|---|---|---|---|
| `GET` | `/health` | 基础健康检查（运行时长） | 否 |
| `GET` | `/health/ready` | 就绪检查（验证数据库连接） | 否 |

### 用户管理

| 方法 | 路径 | 描述 |
|---|---|---|
| `POST` | `/api/v1/users` | 创建用户 |
| `GET` | `/api/v1/users` | 列出所有用户 |
| `GET` | `/api/v1/users/:id` | 根据 ID 获取用户 |
| `PATCH` | `/api/v1/users/:id` | 更新用户（密码、模式、状态） |
| `DELETE` | `/api/v1/users/:id` | 删除用户 |
| `POST` | `/api/v1/users/:id/refresh` | 刷新 sticky IPv6 绑定 |
| `GET` | `/api/v1/users/:id/current-ip` | 获取当前的 sticky 地址 |

**POST /api/v1/users**

```json
{
  "username": "alice",
  "password": "secret123",
  "mode": "random"
}
```

**PATCH /api/v1/users/:id**

```json
{
  "password": "newpass",
  "mode": "random",
  "status": "disabled"
}
```

### 子网管理

| 方法 | 路径 | 描述 |
|---|---|---|
| `POST` | `/api/v1/subnets` | 添加子网 |
| `GET` | `/api/v1/subnets` | 列出所有子网 |
| `GET` | `/api/v1/subnets/:id` | 根据 ID 获取子网 |
| `DELETE` | `/api/v1/subnets/:id` | 删除子网 |
| `POST` | `/api/v1/subnets/:id/health` | 检查子网健康状态（尝试 IPv6 绑定） |

**POST /api/v1/subnets**

```json
{
  "cidr": "2001:db8:1::/64",
  "gateway": "2001:db8:1::1"
}
```

### 绑定管理

将用户绑定到子网。用户必须绑定到至少一个子网才能使用 SOCKS5 代理。

| 方法 | 路径 | 描述 |
|---|---|---|
| `POST` | `/api/v1/users/:id/bindings` | 将用户绑定到子网 |
| `GET` | `/api/v1/users/:id/bindings` | 列出用户的子网绑定 |
| `DELETE` | `/api/v1/users/:id/bindings/:bindingId` | 删除绑定 |

**POST /api/v1/users/:id/bindings**

```json
{
  "subnet_id": "<subnet-uuid>"
}
```

### 会话管理

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/api/v1/sessions` | 列出活跃的 SOCKS5 会话（可选 `?user_id=` 过滤） |
| `DELETE` | `/api/v1/sessions/:sessionId` | 强制断开会话 |

### 流量统计

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/api/v1/traffic` | 查询流量统计数据 |

**查询参数：** `user_id`、`start`（ISO 日期）、`end`（ISO 日期）、`limit`、`offset`

### 速率限制

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/api/v1/users/:id/limits` | 获取速率限制规则及当前连接数 |
| `PUT` | `/api/v1/users/:id/limits` | 设置速率限制规则 |

**PUT /api/v1/users/:id/limits**

```json
{
  "max_connections": 10,
  "max_bandwidth": 1048576
}
```

- `max_connections`：最大并发 SOCKS5 连接数（`null` 表示不限制）
- `max_bandwidth`：最大带宽，字节/秒（`null` 表示不限制）

### 审计日志

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/api/v1/audit-logs` | 查询审计日志 |

**查询参数：** `user_id`、`action`、`start`（ISO 日期时间）、`end`（ISO 日期时间）、`limit`、`offset`

**审计操作记录：**
- `user.created`、`user.updated`、`user.deleted`
- `subnet.created`、`subnet.deleted`
- `binding.created`、`binding.deleted`
- `ip.refreshed`
- `rate_limits.updated`
- `tunnel.endpoint_updated`、`tunnel.reconnected`
- `warp.reconnected`

### 解析诊断

IPv6 回退链的诊断接口，详见[访问无 IPv6 解析的域名](#访问无-ipv6-解析的域名)。

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/api/v1/resolver/check` | 诊断某域名如何经 IPv6 访问 |
| `GET` | `/api/v1/resolver/cache` | 查看路由缓存、边缘池和已学习的边缘地址 |
| `DELETE` | `/api/v1/resolver/cache` | 清空路由缓存 |

**GET /api/v1/resolver/check**

**查询参数：** `host`（必需）、`port`（默认 `443`）

```json
{
  "host": "support.apple.com",
  "port": 443,
  "cnameChain": ["prod-support.apple-support.akadns.net"],
  "aaaa": [],
  "a": ["23.44.51.100"],
  "provider": "akamai",
  "route": {
    "kind": "cdn-borrow",
    "addresses": ["2600:1413:1::6011:b42a"],
    "provider": "akamai",
    "via": "akamai edge",
    "verified": true
  },
  "error": null
}
```

当不存在任何 IPv6 路径时，`route` 为 `null`，`error` 给出原因。

### 隧道管理

6in4 隧道的状态与控制接口，详见[宿主机没有 IPv6？](#宿主机没有-ipv6)。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/tunnel` | 隧道状态：设备、参数、探测结果、告警 |
| `POST` | `/api/v1/tunnel/verify` | 重新探测隧道是否通流量 |
| `POST` | `/api/v1/tunnel/endpoint` | 把隧道指向本机当前公网 IPv4 |
| `POST` | `/api/v1/tunnel/reconnect` | 按当前配置重建隧道 |

**GET /api/v1/tunnel**

```json
{
  "enabled": true,
  "device": "he-ipv6",
  "up": true,
  "spec": {
    "serverIpv4": "216.218.221.42",
    "clientIpv6": "2001:470:1f04:17b::2",
    "linkPrefix": "2001:470:1f04:17b::/64",
    "localIpv4": "192.168.1.20",
    "routedPrefixes": ["2001:470:8123::/48"],
    "mtu": 1480
  },
  "natted": true,
  "publicIpv4": "203.0.113.9",
  "endpointUpdate": { "ok": true, "code": "nochg", "ip": "203.0.113.9", "at": "2026-07-26T12:00:00.000Z" },
  "probes": [
    { "source": "2001:470:1f04:17b::2", "ok": true, "detail": "reached [2001:470:20::2]:53" },
    { "source": "2001:0470:8123:6c1a:...", "ok": true, "detail": "reached [2001:470:20::2]:53" }
  ],
  "warnings": []
}
```

响应中不会回显任何凭据，`config.credentials` 只返回 `configured` 或 `none`。

### WARP 管理

Cloudflare WARP 链路的状态与控制接口，详见[方案一：Cloudflare WARP](#方案一cloudflare-warp免注册)。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/warp` | WARP 状态：每条链路的地址、探测结果与告警 |
| `GET` | `/api/v1/warp/accounts` | 已注册的设备及其地址（不含密钥） |
| `POST` | `/api/v1/warp/verify` | 重新探测各条链路是否通流量 |
| `POST` | `/api/v1/warp/reconnect` | 按已保存的注册信息重建链路 |

**GET /api/v1/warp**

```json
{
  "enabled": true,
  "up": true,
  "links": [
    {
      "slot": 0,
      "device": "warp0",
      "address": "2606:4700:110:8921:bf06:c4d7:40b7:8afd",
      "cidr": "2606:4700:110:8921:bf06:c4d7:40b7:8afd/128",
      "endpoint": "162.159.192.1:2408",
      "table": 51820,
      "accountType": "free",
      "up": true,
      "error": null,
      "probe": { "source": "2606:4700:110:8921:bf06:c4d7:40b7:8afd", "ok": true, "detail": "reached [2606:4700:4700::1111]:53" }
    }
  ],
  "cidrs": ["2606:4700:110:8921:bf06:c4d7:40b7:8afd/128"],
  "startedAt": "2026-07-26T12:00:00.000Z",
  "warnings": []
}
```

响应中不会回显 WireGuard 私钥和设备 token。

---

## 数据模型

### 用户表 (users)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `username` | TEXT | 唯一用户名 |
| `password` | TEXT | bcrypt 哈希 |
| `mode` | TEXT | `sticky` 或 `random` |
| `status` | TEXT | `active` 或 `disabled` |
| `created_at` | TEXT | ISO 8601 时间戳 |
| `updated_at` | TEXT | ISO 8601 时间戳 |

### 子网表 (subnets)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `cidr` | TEXT | 唯一 CIDR 表示法（如 `2001:db8:1::/64`） |
| `gateway` | TEXT | 网关地址（可选） |
| `status` | TEXT | `active` 或 `disabled` |
| `created_at` | TEXT | ISO 8601 时间戳 |

### 粘性绑定表 (sticky_bindings)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id) |
| `subnet_id` | TEXT | 引用 subnets(id) |
| `ipv6_addr` | TEXT | 分配的 IPv6 地址（完整展开格式） |
| `bound_at` | TEXT | ISO 8601 时间戳 |

### 流量统计表 (traffic_stats)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id) |
| `date` | TEXT | `YYYY-MM-DD` 格式的日期 |
| `bytes_in` | INTEGER | 从目标接收的字节数 |
| `bytes_out` | INTEGER | 发送到目标的字节数 |

### 审计日志表 (audit_logs)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id)，可为空 |
| `actor` | TEXT | 操作执行者（`system` 或用户名） |
| `action` | TEXT | 操作标识符 |
| `detail` | TEXT | 包含操作详情的 JSON 字符串 |
| `created_at` | TEXT | ISO 8601 时间戳 |

### 速率限制表 (rate_limits)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 唯一，引用 users(id) |
| `max_connections` | INTEGER | 最大并发连接数（可为空） |
| `max_bandwidth` | INTEGER | 最大带宽，字节/秒（可为空） |

---

## 速率限制机制

速率限制在用户级别通过两种方式进行控制：

1. **连接数限制** — 对并发 SOCKS5 会话数量的硬性限制。在连接时强制执行。默认：不限制。
2. **带宽限制** — 令牌桶算法。每个用户拥有一个桶，以 `max_bandwidth` 字节/秒的速率补充令牌。如果桶为空，数据将被延迟。默认：不限制。

速率限制是可选的 — 将值设置为 `null`（或在 JSON 请求体中省略）即可禁用。

---

## 开发指南

```bash
# 安装依赖
npm install

# 开发模式运行（热重载）
npm run dev

# 类型检查
npm run typecheck

# 运行测试（基于 node:test，无需网络）
npm test

# 构建
npm run build
```

### 项目结构

```
src/
├── index.ts                    # 入口文件
├── config.ts                   # 环境配置
├── database/
│   ├── connection.ts           # SQLite 单例
│   └── migrations.ts           # 数据库迁移
├── core/
│   ├── ip-allocator.ts         # IPv6 地址分配
│   ├── users.ts                # 用户管理
│   ├── subnets.ts              # 子网管理
│   ├── sessions.ts             # 会话跟踪
│   ├── traffic.ts              # 流量统计
│   ├── rate-limiter.ts         # 速率限制
│   ├── target-resolver.ts      # IPv6 回退链与边缘节点验证
│   ├── cdn-providers.ts        # 已知 anycast CDN 特征与种子域名
│   ├── tunnel.ts               # 6in4 隧道建立、路由与验证
│   ├── tunnelbroker.ts         # tunnelbroker.net API 与端点更新
│   └── audit.ts                # 审计日志
├── socks5/
│   └── server.ts               # SOCKS5 协议实现
├── api/
│   ├── server.ts               # Fastify 服务器设置
│   ├── middleware/
│   │   └── auth.ts             # API 密钥认证
│   └── routes/
│       ├── health.ts           # 健康检查端点
│       ├── users.ts            # 用户 CRUD 端点
│       ├── subnets.ts          # 子网 CRUD 端点
│       ├── bindings.ts         # 用户-子网绑定端点
│       ├── sessions.ts         # 会话管理端点
│       ├── traffic.ts          # 流量统计端点
│       ├── limits.ts           # 速率限制端点
│       ├── audit.ts            # 审计日志端点
│       ├── resolver.ts         # IPv6 回退诊断端点
│       ├── tunnel.ts           # 隧道状态与控制
│       └── warp.ts             # WARP 状态与控制端点
└── utils/
    ├── ipv6.ts                 # IPv6 地址工具
    └── logger.ts               # Pino 日志器

test/
├── target-resolver.test.ts     # 回退链测试（node:test）
└── tunnel.test.ts              # 隧道解析、参数合并与 ip 命令编排测试

scripts/
└── check-ipv6.sh               # 独立的 IPv6 可达性检测脚本
```

---

## Docker 部署

### 构建镜像

```bash
docker build -f docker/Dockerfile -t ipv6-subnet-proxy .
```

### docker-compose 配置

```yaml
services:
  ipv6-proxy:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "1080:1080"
      - "3000:3000"
    environment:
      - API_KEY=changeme
      - DEFAULT_SUBNET=2001:db8:1::/64
      - LOG_LEVEL=info
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv6.ip_nonlocal_bind=1
    restart: unless-stopped
    network_mode: host
```

> **注意：** 在 Docker 中，IPv6 绑定需要 `network_mode: host` 才能正常工作。使用主机网络模式时，端口映射仅起说明作用，容器将直接使用主机的网络栈。这也意味着 `net.ipv6.ip_nonlocal_bind=1` 必须设置在*宿主机*上 —— 上面的 `sysctls:` 无法作用于容器并不拥有的命名空间。

若要在容器内接入免费 IPv6，宿主机需加载对应的内核模块：[隧道代理商](#方案二隧道代理商一整段路由前缀)用 `modprobe sit`，[WARP](#方案一cloudflare-warp免注册)用 `modprobe wireguard`。镜像已内置 `iproute2`（BusyBox 的 `ip` 无法创建隧道设备）和 `wireguard-tools`。

---

## CI/CD 持续集成

当推送匹配 `v*` 格式的 Git 标签时，Docker 镜像将自动构建并发布到 GitHub Container Registry (GHCR)。

GitHub Actions 工作流执行以下步骤：

1. 检出仓库代码
2. 生成 Docker 元数据标签（语义化版本 + `latest`）
3. 设置 QEMU 用于多架构构建
4. 登录 GHCR
5. 构建并推送 `linux/amd64` 和 `linux/arm64` 架构的镜像

**使用方法：**

```bash
git tag v1.0.0
git push origin v1.0.0
```

镜像将发布至 `ghcr.io/<your-username>/ipv6-subnet-proxy`。

---

## 许可证

MIT
