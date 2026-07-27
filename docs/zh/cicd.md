# CI/CD 持续集成

当推送匹配 `v*` 格式的 Git 标签时，Docker 镜像将自动构建并发布到 GitHub Container Registry (GHCR)。

GitHub Actions 工作流执行以下步骤：

1. 检出仓库代码
2. 生成 Docker 元数据标签（语义化版本 + `latest`）
3. 设置 QEMU 用于多架构构建
4. 登录 GHCR
5. 构建并推送 `linux/amd64` 和 `linux/arm64` 架构的镜像

**使用方法：**

```bash
git tag v1.0.0
git push origin v1.0.0
```

镜像将发布至 `ghcr.io/<your-username>/ipv6-subnet-proxy`。

---
