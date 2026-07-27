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

git clone https://github.com/emptysuns/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# 编辑 docker/docker-compose.yml → API_KEY（以及 WARP_ENABLED / HE_*）
docker compose -f docker/docker-compose.yml up -d --build
```

### 手动部署

```bash
# 克隆并安装
git clone https://github.com/emptysuns/ipv6-subnet-proxy.git
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
