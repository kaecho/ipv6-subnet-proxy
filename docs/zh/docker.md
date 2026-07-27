# Docker 部署

### 构建

```bash
docker build -f docker/Dockerfile -t ipv6-subnet-proxy .
```

### docker-compose

```yaml
services:
  ipv6-proxy:
    build:
      context: .
      dockerfile: docker/Dockerfile
    environment:
      - API_KEY=changeme
      - LOG_LEVEL=info
      # - WARP_ENABLED=true
      # - WARP_ACCOUNTS=8
      # - HE_TUNNEL_ID=...
      # - HE_TUNNEL_USERNAME=...
      # - HE_TUNNEL_UPDATE_KEY=...
    volumes:
      - ./data:/data
    cap_add:
      - NET_ADMIN
    restart: unless-stopped
    network_mode: host
```

宿主机前置（在**宿主机**上设置，不要指望 compose）：

```bash
# 必需：允许绑定未配置在网卡上的地址
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

# 仅在容器内接入免费 IPv6 时需要
sudo modprobe wireguard   # WARP
sudo modprobe sit         # 6in4 隧道
```

> **必须使用 `network_mode: host`。** 端口映射仅作说明，容器直接使用宿主机网络栈。host 网络下 compose 的 `sysctls:` 无效 —— 请在宿主机按上面设置 `ip_nonlocal_bind`。`sit` / `wireguard` 模块也属于宿主机内核；镜像已内置 `iproute2` 与 `wireguard-tools`。

WARP / 隧道接入见 [宿主机没有 IPv6](/zh/no-ipv6)。
