# 开发指南

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
