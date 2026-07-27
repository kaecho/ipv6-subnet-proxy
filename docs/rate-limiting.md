# Rate Limiting

Rate limiting operates at two levels per user:

1. **Connection limit** — Hard limit on the number of concurrent SOCKS5 sessions. Enforced at connection time. Default: unlimited.
2. **Bandwidth throttling** — Token bucket algorithm. Each user gets a bucket that refills at `max_bandwidth` bytes per second. If the bucket is empty, data is delayed. Default: unlimited.

Rate limits are optional — set values to `null` (or omit in the JSON body) to disable.

---
