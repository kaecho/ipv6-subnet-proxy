# 配置说明

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
| `STICKY_TTL_HOURS` | `24` | 带 key 的粘性桶空闲保留小时数（1-87600）。普通 `-sticky` 默认桶永不过期 |

### Cloudflare WARP

免注册的免费 IPv6，详见[方案一：Cloudflare WARP](/zh/no-ipv6#方案一cloudflare-warp免注册)。默认关闭，需设置 `WARP_ENABLED=true`；其余项都有可用的默认值。

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

在没有 IPv6 的宿主机上接入隧道前缀，详见[方案二：隧道代理商](/zh/no-ipv6#方案二隧道代理商一整段路由前缀)。只要配置了账号凭据或手动端点参数，隧道功能即自动启用。

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

以下变量控制代理如何访问没有 AAAA 解析的域名。默认值已适用于绝大多数场景，通常无需调整。详见[访问无 IPv6 解析的域名](/zh/ipv4-only)。

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
