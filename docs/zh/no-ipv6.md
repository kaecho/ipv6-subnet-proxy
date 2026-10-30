# 宿主机没有 IPv6？

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

- **随机用户名**（`alice` 或 `alice-random`）：每建立一条连接换一个 WARP 地址。
- **粘性用户名**（`alice-sticky`）：固定绑在某一个 WARP 地址上，重连后依旧不变；`alice-sticky-<key>` 为每个 key 固定一个独立地址。

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
