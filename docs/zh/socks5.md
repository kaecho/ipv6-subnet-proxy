# SOCKS5 代理使用

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
