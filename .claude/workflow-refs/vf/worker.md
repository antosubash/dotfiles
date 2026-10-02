# /vf — Stage 1b: Start Worker

Read by /vf only when Stage 1b runs.

1. Ensure the queue backend is reachable first (else the worker crash-loops):
   - **Redis** (BullMQ, RQ, Celery-with-Redis, Sidekiq) — `redis-cli -u "$REDIS_URL" ping` (default `redis://localhost:6379`). If unreachable, `docker compose up -d redis` only if `docker-compose.yml` / `compose.yaml` defines a `redis` service; otherwise STOP and tell the user to start Redis.
   - **RabbitMQ / AMQP** (Celery, MassTransit) — check `$RABBITMQ_URL` / `amqp://localhost:5672` with `curl -sf http://localhost:15672/api/aliveness-test/%2F -u guest:guest` if the management plugin is on; same docker-compose fallback.
   - **DB-backed queues** (Hangfire SQL, Django-Q ORM, pg-boss) — the app's DB connection is enough.
2. Start in the background (`run_in_background: true`):
   ```bash
   nohup <worker-cmd> > "$VF_DIR/worker.log" 2>&1 &
   echo $! > "$VF_DIR/worker.pid"
   ```
3. Wait up to **30 seconds** for a ready marker in `$VF_DIR/worker.log`:
   - Celery: `celery@<host> ready` / `mingle: all alone`
   - BullMQ: worker `ready` event, or `Worker started`
   - Hangfire: `Server <name> successfully announced`
   - .NET `BackgroundService`: `Application started`
   - Fallback: PID still alive after 5 seconds and no fatal/exception lines in the log.
4. On timeout or crash: dump the last 50 lines of `$VF_DIR/worker.log`, kill the web server, and STOP.
