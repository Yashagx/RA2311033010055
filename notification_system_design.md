# Notification System Design

This document walks through the design decisions I made while building the notification backend
for this project. It covers the API layer, database design, query optimisation, caching strategy,
bulk processing, and priority scoring.

---

## Stage 1 — REST API Design & Real-Time Delivery

### Authentication
Every request must carry a JWT in the `Authorization` header:

```
Authorization: Bearer <token>
Content-Type: application/json
```

The server decodes the token, extracts `student_id`, and uses it to scope all queries so a
student can never read or modify another student's notifications.

### Endpoints

**GET /api/v1/notifications**
Returns all notifications for the logged-in student, newest first.
```json
// Response 200
{
  "success": true,
  "data": [
    { "id": "uuid", "type": "Placement", "message": "Drive on 10 May", "is_read": false, "created_at": "2024-05-01T09:00:00Z" }
  ],
  "unread_count": 1
}
```

**GET /api/v1/notifications/:id**
Fetch a single notification. Returns `404` if the id doesn't exist or belongs to another student.

**PATCH /api/v1/notifications/:id/read**
Marks one notification as read.
```json
// Response 200
{ "success": true, "message": "Notification marked as read." }
```

**PATCH /api/v1/notifications/read-all**
Marks every unread notification for that student as read in a single query.
```json
// Response 200
{ "success": true, "updated_count": 5 }
```

**DELETE /api/v1/notifications/:id**
Permanently removes the notification. Returns `403` if ownership check fails.

### Real-Time via WebSocket

Polling every few seconds is wasteful. Instead, the server keeps a live connection open per user:

```
ws://api.example.com/ws?token=<JWT>
```

On connect, the server verifies the JWT, gets `student_id`, and registers the socket:

```js
socketMap.set(student_id, ws);
ws.on('close', () => socketMap.delete(student_id));
```

Whenever a new notification is inserted for a student, the server checks `socketMap` and pushes:

```json
{
  "event": "new_notification",
  "data": { "id": "uuid", "type": "Placement", "message": "Drive on 10 May", "created_at": "iso" }
}
```

The client appends it to the list immediately — no reload, no polling.

---

## Stage 2 — Database Design

### Why PostgreSQL?

I chose PostgreSQL because the data is clearly relational — students have notifications, and we
need foreign-key integrity so deleting a student automatically cleans up their notifications.
MongoDB would work but you'd have to enforce relationships in application code, which is fragile.
PostgreSQL also gives us proper ACID transactions, which matters for `mark-all-read` (we don't
want some rows updated and others not if the connection drops mid-flight). Rich indexing options
(composite, partial, BRIN) are also a strong reason.

### Schema

```sql
CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');

CREATE TABLE students (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type       notification_type NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

`ON DELETE CASCADE` means removing a student removes all their notifications — no orphan rows.

### The 4 Core Queries

```sql
-- 1. Fetch all unread for a student
SELECT id, type, message, is_read, created_at
FROM   notifications
WHERE  student_id = $1 AND is_read = FALSE
ORDER  BY created_at DESC;

-- 2. Mark one notification as read (ownership enforced by AND student_id = $2)
UPDATE notifications SET is_read = TRUE
WHERE  id = $1 AND student_id = $2;

-- 3. Mark all as read
UPDATE notifications SET is_read = TRUE
WHERE  student_id = $1 AND is_read = FALSE;

-- 4. Delete one notification
DELETE FROM notifications
WHERE  id = $1 AND student_id = $2;
```

### Scale Problems and Fixes

At a few thousand rows everything is fine. At 5 million rows:
- Full table scans on every `GET /notifications` call crush the database.
- Fix: composite indexes (see Stage 3).
- Fix: range-partition the table by month on `created_at` so older partitions are never touched
  by queries that filter on recent dates.
- Fix: put Redis in front of reads (see Stage 4).

---

## Stage 3 — Query Optimisation

### Is the Query Accurate?

The query below is logically correct:

```sql
SELECT id, type, message, is_read, created_at
FROM   notifications
WHERE  student_id = $1 AND is_read = FALSE
ORDER  BY created_at DESC;
```

It returns exactly the right rows (unread, for the right student, newest first). The problem is
not correctness — it's performance.

### Why It's Slow Without an Index

Without an index, PostgreSQL has to do a **Sequential Scan**: read every single row in the table
and check the `WHERE` clause row by row. At 5 million rows that's 5 million comparisons per
request. With 100 concurrent users hitting this endpoint that's 500 million comparisons per
second, which will saturate CPU and disk I/O quickly.

`SELECT *` makes it worse because fetching wide rows means more pages read from disk, more buffer
pool evictions, and more network overhead.

### Fix: Composite Index

```sql
CREATE INDEX idx_notifications_student_unread
ON notifications (student_id, is_read, created_at DESC);
```

Now PostgreSQL jumps directly to the B-tree leaf for `student_id = $1 AND is_read = FALSE`, and
the rows are already sorted by `created_at DESC` inside the index — no extra sort step needed.
Cost drops from O(N) to O(log N + K) where K is the number of results per student (typically
small).

### Why You Should Not Index Every Column

Each index is a separate B-tree that must be updated on every `INSERT`, `UPDATE`, and `DELETE`.
If you have 6 single-column indexes and insert 500 000 rows per day, each insert triggers 6
B-tree updates — write throughput tanks. Extra indexes also take significant disk space (a full
copy of the indexed columns per index). The rule is simple: only index columns that appear in
`WHERE`, `JOIN ON`, or `ORDER BY` clauses of your most frequent queries.

### 7-Day Placement Query

Find every student who received at least one Placement notification in the last 7 days:

```sql
SELECT DISTINCT student_id
FROM   notifications
WHERE  type = 'Placement'
  AND  created_at >= NOW() - INTERVAL '7 days';
```

To make it fast, add a partial index that only stores Placement rows:

```sql
CREATE INDEX idx_placement_recent
ON notifications (created_at DESC)
WHERE type = 'Placement';
```

---

## Stage 4 — Caching & Delivery Strategy

### Redis Cache

```
Key:   notifications:<student_id>:unread
Value: JSON array (serialised query result)
TTL:   60 seconds
```

**Read flow:**
1. Check Redis for the key.
2. Cache hit → return immediately (zero DB queries).
3. Cache miss → run the SQL query, store the result in Redis with 60 s TTL, return it.

**Write invalidation (on PATCH or DELETE):**
```
DEL notifications:<student_id>:unread
```
This forces the next read to go to the database and repopulate a fresh value.

Using TTL alone risks serving stale data for up to 60 s after a write. Invalidation alone risks
memory leaks if a bug skips the `DEL`. Together they guarantee freshness while bounding memory.

### WebSocket Push Strategy

When a new notification is created, the server does:

```js
const ws = socketMap.get(student_id);
if (ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify(payload));
}
```

If the student is online, they see the notification instantly. If they are offline, the record is
already in the DB — they will see it on next login via the REST endpoint.

### Tradeoffs

| Strategy | Pros | Cons |
|---|---|---|
| Redis cache | Reduces DB read load significantly | Adds infra; short stale window possible |
| WebSocket push | Zero latency for live users | Requires persistent connections; offline users miss push |
| Combined | Best of both worlds | More complex to implement and test |

---

## Stage 5 — Bulk Notification Processing

### Shortcomings of the Original Pseudocode

```
for student_id in student_ids:
    insert_to_db(student_id, message)
    send_email(student_id, message)
```

1. **N individual DB round-trips** — 50 000 students = 50 000 INSERT statements. A batch insert
   does it in one.
2. **DB and email are coupled** — if the email service is down, does the loop abort? If yes, some
   students got DB records, others did not.
3. **Email cannot be rolled back** — once SMTP delivers an email, you cannot undo it. If the DB
   insert later fails, the student already received the email and the system is inconsistent.
4. **No retry logic** — a transient network error silently drops a notification.
5. **Synchronous email inside a loop** — each SMTP call can take seconds; the loop blocks for
   minutes.

### Revised Design

DB writes and email delivery must be decoupled. Commit all DB rows first, then hand delivery off
to an async queue so the two operations have independent failure modes.

```
function notify_all(student_ids, message, type):
    // Step 1 — One batch INSERT. Commits or rolls back atomically.
    rows = [(sid, message, type, NOW()) for sid in student_ids]
    batch_insert_db(notifications_table, rows)

    // Step 2 — Enqueue delivery jobs. Fast, non-blocking.
    for student_id in student_ids:
        enqueue(email_queue, { student_id, message, type })
        enqueue(push_queue,  { student_id, message, type })


// Email worker — runs as a separate process
email_worker():
    while true:
        job = dequeue(email_queue)
        attempt = 0
        while attempt < 3:
            try:
                send_email(job.student_id, job.message)
                break
            catch TransientError:
                attempt += 1
                sleep(200ms * 2^attempt)   // exponential backoff
        if attempt == 3:
            move_to_dead_letter_queue(job)
```

The main function returns in milliseconds. Workers handle delivery asynchronously and retry on
failure without blocking anyone else.

---

## Stage 6 — Priority Scoring & Top-N Retrieval

### The Score Formula

```
score = type_weight × 10^12 + timestamp_ms
```

| Type | Weight |
|---|---|
| Placement | 3 |
| Result | 2 |
| Event | 1 |

The `10^12` multiplier ensures the type component always dominates: a Placement from yesterday
always ranks above an Event from today. Within the same type, a newer timestamp produces a higher
score. The formula gives a single integer that encodes both priority and recency unambiguously.

Example:
- Placement at ms `1714550400000` → `3_001_714_550_400_000`
- Event at same ms → `1_001_714_550_400_000`

### Maintaining Top-N Efficiently

A naive approach — sort all notifications descending every time a new one arrives — is O(M log M)
where M is the total count. For millions of notifications that's expensive.

Instead, keep a **min-heap of fixed size N** (smallest score at the root):

```
heap = MinHeap(capacity = N)

function on_new_notification(notification):
    s = compute_score(notification.type, notification.created_at)
    if heap.size() < N:
        heap.push({ s, notification })
    else if s > heap.root().score:
        heap.pop()            // evict lowest-priority item
        heap.push({ s, notification })
    // else: doesn't make top-N, discard

function get_top_N():
    return heap.sorted_descending()
```

**Cost per new notification:** O(log N) — a heap push or pop+push.
**Memory:** O(N) — only N items ever held in memory regardless of total notification volume.
**Read cost:** O(N log N) to sort the N items for display — tiny since N is small (e.g. 10).

This is far more efficient than any sort-on-read strategy and avoids hitting the database on every
new arrival.
