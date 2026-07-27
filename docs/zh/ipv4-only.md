# 访问无 IPv6 解析的域名

纯 IPv6 出口通常只能访问设置了 AAAA 记录的域名。这看似排除了互联网的很大一部分，但实际情况远没有 DNS 显示的那么糟。

这类站点大多位于 anycast CDN 之后。CDN 边缘节点本身是双栈的，它根据 TLS SNI 或 HTTP `Host` 头选择回源目标，而不是根据目标 IP——**因此无论站点是否设置 AAAA 解析，边缘节点都会通过 IPv6 提供服务**。在 DNS 中发布 IPv6 是客户侧的一个开关，而能否经 IPv6 访问则是边缘节点集群的固有属性。本代理正是利用了这两者之间的落差。

由于 SOCKS5 在 TCP 层是透明转发，客户端自己的 SNI 和 `Host` 头会原样传递，只有目标地址被改变。

### 回退链

每次 CONNECT 都会按以下顺序解析目标，第一个成功的即被采用：

| 层级 | 工作方式 |
|---|---|
| `native` | 域名自身有 AAAA 记录，直接使用，不做探测 |
| `dualstack` | `dualstack.<cname 节点>` 有 AAAA 记录。Fastly、Akamai、AWS ELB 和 CloudFront 都发布这一变体——同一 CDN、同一映射，只是它的 IPv6 视图。借用保真度最高 |
| `cdn-borrow` | 通过 CNAME 链或目标 IPv4 地址的 PTR 记录识别 CDN，然后借用同一 CDN 的其他边缘节点 |
| `nat64` | 由 `NAT64_PREFIX` 合成地址。未配置时不启用 |

### 验证机制

借用绝不基于猜测。在正式使用某个边缘节点前，代理会先对它发起一次 TLS 握手，SNI 设为目标域名并完整校验证书。不服务该域名的节点会验证失败并被丢弃——这样一次错误的猜测只会变成一次干净的连接失败，而不会在用户浏览器里变成证书错误。

在 80 端口上没有证书可校验，因此先在 443 端口用 TLS 验证该节点；只有在此之后，HTTP `Host` 探测才作为兜底证明。

验证通过的路由缓存 10 分钟，失败结果缓存 1 分钟，因此探测开销按域名支付一次，而不是按连接支付。如果某条缓存路由的所有地址后续都连接失败，该条目会被丢弃，下次请求重新走一遍回退链。

### 借用的边缘节点从哪来

按优先级依次为：运维通过 `CDN_FALLBACK_EDGES` 手动指定的地址；**从实际流量中学习到的地址**（任何已知 CDN 的双栈主机本身就是该 CDN 边缘集群的一个样本）；以及内置的各 CDN 种子域名列表。学习机制使该功能不依赖于内置种子域名长期保持双栈。

### 检测某个域名

`scripts/check-ipv6.sh` 可在代理之外独立执行同样的检查：

```bash
./scripts/check-ipv6.sh support.apple.com build.nvidia.com
```

```
HOST                  DNS_A6  NATIVE  DUALSTACK  BORROW  DETAIL
support.apple.com     NO      -       -          YES     cname:prod-support.apple-support.akadns.net; borrow_ok=2600:1413:...
www.akamai.com        YES     YES     -          YES     native=2600:1413:5000:35::173d:ca51 (2 AAAA)
```

对运行中的代理，`GET /api/v1/resolver/check?host=<域名>` 会返回它实际的判定结果，包括 CNAME 链、识别出的 CDN，以及所选地址是否已通过验证。

### 局限

借用只对确实位于受支持 CDN 之后的站点有效。若某域名只有单一的纯 IPv4 源站，则不存在任何 IPv6 路径——这种情况下需要配置 `NAT64_PREFIX` 并具备可达的 NAT64 网关，或者提供 IPv4 出口。代理会返回 `0x04`（主机不可达）而不是一直挂起。

---
