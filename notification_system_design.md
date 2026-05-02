# Notification System Design

## Stage 1 — REST API & Real-Time
**Auth:** `Bearer <JWT_TOKEN>` | `Content-Type: application/json`

| Method | Endpoint | Description |
|:---:|---|---|
| GET | `/notifications` | Fetch unread. Schema: `{success: bool, data: [{id, type, msg, is_read, created_at}], count}` |
| GET | `/notifications/:id` | Fetch one. Schema: `{success: bool, data: {notif_object}}` |
| PATCH | `/notifications/:id/read` | Mark one read. |
| PATCH | `/notifications/read-all` | Mark all read. |
| DELETE | `/notifications/:id` | Remove notification. |

**WebSocket:** `ws://api.example.com/ws?token=<JWT>`
Server maps `student_id -> socket`. On new notification, server pushes:
```json
{"event": "new_notification", "data": {"id": "uuid", "type": "Placement", "message": "msg", "created_at": "iso"}}
```

## Stage 2 — Database Design
**PostgreSQL Justification:** Relational data, fixed schema, ACID transactions for `mark-all-read`, and rich indexing support.

```sql
CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');
CREATE TABLE students (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id INTEGER REFERENCES students(id),
  type notification_type, message TEXT, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
);

-- Queries: 1. Fetch Unread | 2. Mark Read | 3. Mark All Read | 4. Delete
SELECT * FROM notifications WHERE student_id = $1 AND is_read = FALSE ORDER BY created_at DESC;
UPDATE notifications SET is_read = TRUE WHERE id = $1 AND student_id = $2;
UPDATE notifications SET is_read = TRUE WHERE student_id = $1 AND is_read = FALSE;
DELETE FROM notifications WHERE id = $1 AND student_id = $2;
```
**Scale:** At 5M rows, use **composite indexes** and **partitioning** by month on `created_at`.

## Stage 3 — Optimization
**Accuracy:** `SELECT * FROM notifications WHERE student_id = $1 AND is_read = FALSE ORDER BY created_at DESC` is accurate but slow due to **Sequential Scan (O(N))**.
**Fix:** `CREATE INDEX idx_notif ON notifications (student_id, is_read, created_at DESC);` (Jump to B-tree leaves).
**Why not index all?** Every index slows down `INSERT/UPDATE` (write amplification) and consumes disk space.

**7-Day Placement Query:**
```sql
SELECT DISTINCT student_id FROM notifications 
WHERE type = 'Placement' AND created_at >= NOW() - INTERVAL '7 days';
```

## Stage 4 — Caching & Delivery
**Redis Strategy:** Key `notif:<id>:unread`, TTL 60s. Invalidate on `PATCH/DELETE`.
**WebSocket Strategy:** Push on write if student is online.
**Tradeoffs:** Redis reduces DB load but adds infra; WebSocket is real-time but doesn't handle offline state.

## Stage 5 — Bulk Processing
**Original Shortcomings:** Sequential loops (O(N) DB trips), coupled DB/Email (email can't rollback), no retries.
**Revised Pseudocode:**
```js
function notify_all(ids, msg, type) {
  batch_insert_db(ids, msg, type); // Single O(1) trip
  ids.map(id => enqueue('email_queue', {id, msg})); // Decoupled
}
// Worker: retry with exponential backoff on failure.
```

## Stage 6 — Priority & Top-N
**Score:** `score = type_weight * 10^12 + timestamp_ms` (Placement: 3, Result: 2, Event: 1).
**Top-N:** Maintain a **Min-Heap of size N**. Complexity: `O(log N)` per insert, `O(N)` space. Faster than `ORDER BY` on 5M rows.
