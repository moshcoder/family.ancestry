#!/bin/bash
# family.ancestry's own Redis on dev2, for the updater daemon's BullMQ queue
# (@profullstack/scraper-daemon, src/daemon.ts). One Redis per site, as the fleet does:
# redis:8-alpine, loopback only, AOF on, noeviction (BullMQ requires it), its own volume.
# Idempotent: creates the container once, leaves a running one alone. REDIS_URL lives in
# /root/.local/share/family-ancestry/db.env (not app.env, which is rewritten from the vault).
set -euo pipefail
NAME=family-ancestry-redis
PORT=6393
if docker inspect "$NAME" >/dev/null 2>&1; then
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --restart unless-stopped \
    --memory 256m --memory-swap 256m \
    -p "127.0.0.1:${PORT}:6379" -v family-ancestry-redis:/data \
    redis:8-alpine redis-server --appendonly yes --maxmemory 192mb --maxmemory-policy noeviction >/dev/null
fi
for i in $(seq 1 20); do
  [ "$(docker exec "$NAME" redis-cli ping 2>/dev/null)" = PONG ] && { echo "redis: $NAME on 127.0.0.1:$PORT"; exit 0; }
  sleep 0.5
done
echo "redis: $NAME did not answer" >&2
exit 1
