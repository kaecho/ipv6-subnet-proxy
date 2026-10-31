# SOCKS5 代理使用

使用任意 SOCKS5 客户端，配置以下参数：

- **地址**：代理服务器 IP 或主机名
- **端口**：`1080`（或自定义的 `SOCKS5_PORT`）
- **协议**：SOCKS5
- **认证**：用户名 / 密码
- **用户名**：已创建用户名的后缀形式（见下文）
- **密码**：对应用户的密码

代理仅支持 TCP CONNECT 命令。BIND 和 UDP ASSOCIATE 请求将被拒绝（返回 `0x07` 命令不支持）。

### 用用户名选择地址模式

账号本身不再保存模式。每个账号都可以使用两种行为，由 SOCKS5 用户名选择：

| SOCKS5 用户名 | IPv6 分配方式 |
|---|---|
| `alice` | 每次连接随机地址 |
| `alice-random` | 每次连接随机地址 |
| `alice-sticky` | 使用账号 `default` 桶中的固定地址 |
| `alice-sticky-<key>` | 使用独立桶 `<key>` 中的固定地址 |

密码始终是基础账号（`alice`）的密码。后缀不属于账号，不能当作独立用户管理。

例如账号为 `alice` / `secret123`：

```text
alice                    secret123   # 随机
alice-random             secret123   # 随机
alice-sticky             secret123   # 粘性，默认桶
alice-sticky-8d3f...     secret123   # 粘性，key 为 8d3f... 的桶
```

#### 粘性桶

- 换 key 就是换地址。`alice-sticky-a` 与 `alice-sticky-b` 通常会得到不同地址。
- 绑定多个子网时，一个桶在每个子网各有一个地址。首次连接会选定其中一个已绑定子网，后续连接复用该子网中的地址。
- 带 key 的桶（`alice-sticky-<key>`）**`STICKY_TTL_HOURS`** 小时没有使用时会被删除（默认 24），下一次使用该 key 会重新分配地址；每次复用都会刷新计时。
- 普通的 `default` 桶（`alice-sticky`）不会过期，会一直保持地址，直到 `POST /api/v1/users/:id/refresh` 清空。
- `POST /api/v1/users/:id/refresh` 会清空该账号的全部粘性桶（包括带 key 的桶），这就是原有的 API 换 IP 方式。
- `GET /api/v1/users/:id/current-ip` 会列出当前桶及其地址。

在容器环境里设置空闲时间，例如 10 天：

```yaml
environment:
  - STICKY_TTL_HOURS=240
```

key 不区分大小写，长度 1-64，字符范围为 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，UUID 可以直接使用。若子网是单个 `/128`（例如一台 WARP 设备），该子网只有一个可用地址，所有 key 都会共用这个地址。

若确实存在名为 `alice-sticky` 的独立账号，只有在不存在 `alice` 账号时才会使用它；否则后缀形式优先。需要使用变体时，避免创建以 `-random` 或 `-sticky` 结尾的基础账号。

### IPv6 内核要求

主机必须设置 `net.ipv6.ip_nonlocal_bind=1`，以允许绑定到未分配给任何本地接口的 IPv6 地址：

```bash
sysctl -w net.ipv6.ip_nonlocal_bind=1
```

若要永久生效，请将 `net.ipv6.ip_nonlocal_bind=1` 添加到 `/etc/sysctl.conf` 或 `/etc/sysctl.d/99-ipv6.conf`。

当内核已有覆盖整个前缀的 `local` 路由（内置 6in4 隧道会自动添加）时，代理不再为每条会话单独执行 `ip addr add`；`ip_nonlocal_bind=1` 已足够绑定该地址。依赖 NDP 的原生子网（桥接或 LXC 场景）仍会逐地址注册。

### 握手超时

客户端必须在 30 秒内完成 SOCKS5 方法协商、认证和 CONNECT 请求。静默连接会被关闭，避免长期占用连接槽位。已进入转发的空闲连接不受此超时限制。
