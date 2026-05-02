# Notification System Design

## Stage 1

### Endpoints
- GET /api/v1/notifications
- GET /api/v1/notifications/:id
- PATCH /api/v1/notifications/:id/read
- PATCH /api/v1/notifications/read-all
- DELETE /api/v1/notifications/:id

All need Authorization: Bearer token

Real time via WebSockets - server maps studentID to socket and pushes on new notification.

## Stage 2

PostgreSQL - data is relational, schema is fixed.

```sql
CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');

CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

SELECT id, type, message, is_read, created_at FROM notifications
WHERE student_id = $1 AND is_read = FALSE ORDER BY created_at DESC;

UPDATE notifications SET is_read = TRUE WHERE id = $1 AND student_id = $2;

DELETE FROM notifications WHERE id = $1 AND student_id = $2;
```

At 5M rows full scans slow down. Fix with composite index and monthly partitioning.

## Stage 3

No index means full scan on 5M rows. SELECT * is wasteful. Indexing every column is bad - slows inserts.

```sql
CREATE INDEX idx_notif ON notifications(student_id, is_read, created_at DESC);

SELECT DISTINCT student_id FROM notifications
WHERE type = 'Placement' AND created_at >= NOW() - INTERVAL '7 days';
```

## Stage 4

Cache in Redis with 60s TTL. Invalidate on write. Long term - WebSocket push removes polling entirely.

## Stage 5

Original loops 50k students sequentially, no error handling, email and DB wrongly coupled. Write DB first then queue email separately - email cannot be rolled back.

```
function notify_all(student_ids, message):
  batch_insert_to_db(student_ids, message)
  for student_id in student_ids:
    enqueue(email_queue, student_id, message)
    enqueue(push_queue, student_id, message)

email_worker:
  job = dequeue(email_queue)
  if fails: retry max 3 times with backoff
```

## Stage 6

score = type_weight * 10^12 + timestamp_ms
Placement=3, Result=2, Event=1

Min-heap of size N gives O(log N) per insert. See notification_app_be/index.js.
