# 快速开始

### 前置要求

- 设置了 `net.ipv6.ip_nonlocal_bind=1` 并安装了 `iproute2` 的 Linux 系统
- IPv6 连通性 — 原生 IPv6，或[由 Cloudflare WARP / 隧道代理商免费提供](/zh/no-ipv6)（后两者只要求宿主机有 IPv4）
- Node.js 20+（手动部署时需要）
- Docker（容器部署时需要）

### Docker 部署（推荐）

```bash
# 先在宿主机设置（host 网络下容器无法写入该 sysctl）
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

git clone https://github.com/kaecho/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# 编辑 docker/docker-compose.yml → API_KEY（以及 WARP_ENABLED / HE_*）
docker compose -f docker/docker-compose.yml up -d --build
```

### 手动部署

```bash
# 克隆并安装
git clone https://github.com/kaecho/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy
npm install
npm run build

# 设置必需的 API Key。默认不使用宿主机网卡上的前缀，
# 需要时设置 DETECT_HOST_SUBNETS=true。隧道或 WARP 会带上自己的前缀。
export API_KEY=your-secret-api-key

# 可选：自己指定一个前缀
export DEFAULT_SUBNET=2001:db8:1::/64

# 启动
npm start
```

设置 `DETECT_HOST_SUBNETS=true` 且没有 `DEFAULT_SUBNET` 时，启动还会登记宿主机网卡上找到的前缀。

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

SOCKS5 代理地址为 `localhost:1080`，用户名为 `alice`、密码为 `secret123` 时每次连接随机 IPv6；使用 `alice-sticky` 获得固定地址，使用 `alice-sticky-<key>` 并通过更换 key 来切换地址。详见 [SOCKS5 使用说明](/zh/socks5#用用户名选择地址模式)。

---
