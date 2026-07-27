# IPv6 子网代理

[English](https://emptysuns.github.io/ipv6-subnet-proxy/) | [中文](https://emptysuns.github.io/ipv6-subnet-proxy/zh/)

将出站连接分散到托管子网中不同 IPv6 地址的 SOCKS5 代理。内置免费 IPv6 接入：**Cloudflare WARP**（免注册）或 **6in4 隧道代理商**；附带 REST 管理 API、SQLite 持久化、用户级限速、流量统计与审计日志。

**完整文档（中 / EN）：** https://emptysuns.github.io/ipv6-subnet-proxy/zh/

---

## 快速开始（Docker）

```bash
# 在宿主机上执行（network_mode: host 时容器无法自行设置）
sudo sysctl -w net.ipv6.ip_nonlocal_bind=1
echo net.ipv6.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/99-ipv6-proxy.conf

# 若宿主机本身没有 IPv6，按需加载内核模块：
#   sudo modprobe wireguard   # WARP
#   sudo modprobe sit         # 6in4 隧道

git clone https://github.com/emptysuns/ipv6-subnet-proxy.git
cd ipv6-subnet-proxy

# 编辑 docker/docker-compose.yml → 设置 API_KEY（以及 WARP_ENABLED / HE_*）
docker compose -f docker/docker-compose.yml up -d --build
```

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/api/v1/users \
  -H "X-API-Key: changeme" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

SOCKS5：`localhost:1080`，用户 `alice` / `secret123`。

> 必须使用 host 网络。`network_mode: host` 下 compose 的 `sysctls:` 无效 —— 请在**宿主机**按上面设置 `ip_nonlocal_bind`。

## 宿主机没有 IPv6？

| | Cloudflare WARP | 隧道代理商（6in4） |
|---|---|---|
| 注册 | 不需要 | tunnelbroker.net 免费账号 |
| 得到什么 | 每台设备一个地址 | 路由的 `/48` |
| 内核 | `modprobe wireguard` | `modprobe sit` |
| 环境变量 | `WARP_ENABLED=true` | `HE_TUNNEL_ID` + 凭据 |

详见：[文档 → 宿主机没有 IPv6](https://emptysuns.github.io/ipv6-subnet-proxy/zh/no-ipv6)

## 手动安装

```bash
npm install && npm run build
export API_KEY=your-secret-api-key
# export DEFAULT_SUBNET=2001:db8:1::/64   # 可选；默认从网卡自动检测
npm start
```

需要 Node 20+、Linux、`iproute2`、`net.ipv6.ip_nonlocal_bind=1`。

## 配置

全部通过环境变量配置。常用项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `API_KEY` | _(必填)_ | REST API 密钥（`X-API-Key`） |
| `SOCKS5_PORT` | `1080` | 代理监听端口 |
| `API_PORT` | `3000` | REST API 端口 |
| `DEFAULT_SUBNET` | — | 启动时注册的 CIDR |
| `WARP_ENABLED` | `false` | 通过 Cloudflare WARP 获取免费 IPv6 |
| `WARP_ACCOUNTS` | `1` | WARP 设备数（= 出口地址数） |
| `HE_TUNNEL_ID` | — | tunnelbroker.net 隧道 ID |
| `HE_TUNNEL_USERNAME` | — | HE 账号 |
| `HE_TUNNEL_UPDATE_KEY` | — | 单隧道 Update Key（优于密码） |
| `LOG_LEVEL` | `info` | `trace`…`fatal` |

完整列表：[文档 → 配置说明](https://emptysuns.github.io/ipv6-subnet-proxy/zh/configuration)

## 文档与开发

```bash
npm run docs:dev      # 本地 VitePress
npm run docs:build
npm test
npm run build
```

镜像：`ghcr.io/emptysuns/ipv6-subnet-proxy`（推送 `v*` tag 发布）。

## 许可证

MIT
