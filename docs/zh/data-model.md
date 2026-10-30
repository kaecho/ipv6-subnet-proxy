# 数据模型

### 用户表 (users)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `username` | TEXT | 唯一用户名 |
| `password` | TEXT | bcrypt 哈希 |
| `status` | TEXT | `active` 或 `disabled` |
| `created_at` | TEXT | ISO 8601 时间戳 |
| `updated_at` | TEXT | ISO 8601 时间戳 |

### 子网表 (subnets)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `cidr` | TEXT | 唯一 CIDR 表示法（如 `2001:db8:1::/64`） |
| `gateway` | TEXT | 网关地址（可选） |
| `status` | TEXT | `active` 或 `disabled` |
| `created_at` | TEXT | ISO 8601 时间戳 |

### 粘性绑定表 (sticky_bindings)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id) |
| `subnet_id` | TEXT | 引用 subnets(id) |
| `sticky_key` | TEXT | SOCKS5 用户名中的桶名（普通 `-sticky` 为 `default`） |
| `ipv6_addr` | TEXT | 分配的 IPv6 地址（完整展开格式） |
| `bound_at` | TEXT | ISO 8601 时间戳 |
| `last_used_at` | TEXT | 最近连接时间；带 key 的行空闲 24 小时会被删除（`default` 除外） |

`(user_id, subnet_id, sticky_key)` 唯一。`sticky_key` 与 `last_used_at` 由自动迁移添加；旧数据会归入 `default` 桶。

### 流量统计表 (traffic_stats)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id) |
| `date` | TEXT | `YYYY-MM-DD` 格式的日期 |
| `bytes_in` | INTEGER | 从目标接收的字节数 |
| `bytes_out` | INTEGER | 发送到目标的字节数 |

### 审计日志表 (audit_logs)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 引用 users(id)，可为空 |
| `actor` | TEXT | 操作执行者（`system` 或用户名） |
| `action` | TEXT | 操作标识符 |
| `detail` | TEXT | 包含操作详情的 JSON 字符串 |
| `created_at` | TEXT | ISO 8601 时间戳 |

### 速率限制表 (rate_limits)

| 列名 | 类型 | 描述 |
|---|---|---|
| `id` | TEXT (UUID) | 主键 |
| `user_id` | TEXT | 唯一，引用 users(id) |
| `max_connections` | INTEGER | 最大并发连接数（可为空） |
| `max_bandwidth` | INTEGER | 最大带宽，字节/秒（可为空） |

---
