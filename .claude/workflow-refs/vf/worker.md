# /vf — Stage 1b: Start Worker

Read by /vf only when Stage 1b runs.

1. Ensure the queue backend is reachable first (else the worker crash-loops):
   - **Redis** (BullMQ, RQ, Celery-with-Redis, Sidekiq) — `redis-cli -u "$REDIS_URL" ping` (default `redis://localhost:6379`). If unreachable, `docker compose up -d redis` only if `docker-compose.yml` / `compose.yaml` defines a `redis` service; otherwise STOP and tell the user to start Redis.
   - **RabbitMQ / AMQP** (Celery, MassTransit) — check `$RABBITMQ_URL` / `amqp://localhost:5672` with `curl -sf http://localhost:15672/api/aliveness-test/%2F -u guest:guest` if the management plugin is on; same docker-compose fallback.
   - **DB-backed queues** (Hangfire SQL, Django-Q ORM, pg-boss) — the app's DB connection is enough.
2. Start it through the stack helper, so `stack.sh stop` later finds the worker and every prefork child:
   ```bash
   ~/.claude/workflow-refs/stack.sh start "$STACK_TAG" worker "$VF_DIR/worker.log" 'cd <dir> && <worker-cmd>'
   ```
   Start exactly one scheduler (beat/cron) per stack. If the worker command embeds one (e.g. `celery worker --beat`), don't also start a separate `celery beat`.
3. Wait up to **30 seconds** for a ready marker in `$VF_DIR/worker.log`:
   - Celery: `celery@<host> ready` / `mingle: all alone`
   - BullMQ: worker `ready` event, or `Worker started`
   - Hangfire: `Server <name> successfully announced`
   - .NET `BackgroundService`: `Application started`
   - Fallback: `stack.sh status "$STACK_TAG"` still lists `worker` after 5 seconds and the log has no fatal/exception lines.
4. On timeout or crash: dump the last 50 lines of `$VF_DIR/worker.log`, run `stack.sh stop "$STACK_TAG"`, and STOP.
