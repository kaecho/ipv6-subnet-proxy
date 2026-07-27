# Data Model

### Users

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `username` | TEXT | Unique username |
| `password` | TEXT | bcrypt hash |
| `mode` | TEXT | `sticky` or `random` |
| `status` | TEXT | `active` or `disabled` |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

### Subnets

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `cidr` | TEXT | Unique CIDR notation (e.g., `2001:db8:1::/64`) |
| `gateway` | TEXT | Gateway address (optional) |
| `status` | TEXT | `active` or `disabled` |
| `created_at` | TEXT | ISO 8601 timestamp |

### Sticky Bindings

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id) |
| `subnet_id` | TEXT | References subnets(id) |
| `ipv6_addr` | TEXT | Allocated IPv6 address (full expanded form) |
| `bound_at` | TEXT | ISO 8601 timestamp |

### Traffic Stats

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id) |
| `date` | TEXT | Date in `YYYY-MM-DD` format |
| `bytes_in` | INTEGER | Bytes received from target |
| `bytes_out` | INTEGER | Bytes sent to target |

### Audit Logs

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | References users(id), nullable |
| `actor` | TEXT | Who performed the action (`system` or username) |
| `action` | TEXT | Action identifier |
| `detail` | TEXT | JSON string with action details |
| `created_at` | TEXT | ISO 8601 timestamp |

### Rate Limits

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) | Primary key |
| `user_id` | TEXT | Unique, references users(id) |
| `max_connections` | INTEGER | Max concurrent connections (nullable) |
| `max_bandwidth` | INTEGER | Max bytes/sec (nullable) |

---
