# CI/CD

Docker images are automatically built and published to GitHub Container Registry (GHCR) when a tag matching `v*` is pushed.

The GitHub Actions workflow:

1. Checks out the repository
2. Generates Docker metadata tags (semver + `latest`)
3. Sets up QEMU for multi-architecture builds
4. Logs into GHCR
5. Builds and pushes images for `linux/amd64` and `linux/arm64`

**Usage:**

```bash
git tag v1.0.0
git push origin v1.0.0
```

The image will be published to `ghcr.io/<your-username>/ipv6-subnet-proxy`.

---
