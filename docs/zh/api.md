# REST API 参考

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
| `PATCH` | `/api/v1/users/:id` | 更新用户（密码、状态） |
| `DELETE` | `/api/v1/users/:id` | 删除用户 |
| `POST` | `/api/v1/users/:id/refresh` | 清空该用户的全部粘性桶 |
| `GET` | `/api/v1/users/:id/current-ip` | 列出当前粘性桶 |

**POST /api/v1/users**

```json
{
  "username": "alice",
  "password": "secret123"
}
```

**PATCH /api/v1/users/:id**

```json
{
  "password": "newpass",
  "status": "disabled"
}
```

不再接受 `mode` 字段。分配方式由 SOCKS5 用户名决定：`alice` / `alice-random` 为随机，`alice-sticky` 为默认粘性桶，`alice-sticky-<key>` 为独立粘性桶。详见 [SOCKS5 代理使用](/zh/socks5#用用户名选择地址模式)。

`POST /api/v1/users/:id/refresh` 会删除该用户的全部粘性桶（包括 UUID key 的桶），下一次连接会获得新地址。返回 `{ "success": true, "bindings": 3, "message": "Refreshed 3 sticky IPv6 binding(s)" }`。

`GET /api/v1/users/:id/current-ip` 每个桶返回一行：

```json
{
  "userId": "<user-uuid>",
  "addresses": [
    {
      "subnetId": "<subnet-uuid>",
      "stickyKey": "default",
      "ipv6Addr": "2001:db8:1:0:1234:5678:9abc:def0",
      "lastUsedAt": "2026-10-31T12:00:00.000Z"
    }
  ]
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

IPv6 回退链的诊断接口，详见[访问无 IPv6 解析的域名](/zh/ipv4-only)。

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

6in4 隧道的状态与控制接口，详见[宿主机没有 IPv6？](/zh/no-ipv6)。

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

Cloudflare WARP 链路的状态与控制接口，详见[方案一：Cloudflare WARP](/zh/no-ipv6#方案一cloudflare-warp免注册)。

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
