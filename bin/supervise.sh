#!/bin/bash
# Keep `gang-sniper run` alive: restart it if it exits, and keep the Mac awake while it runs.
#   bin/supervise.sh            foreground
#   nohup bin/supervise.sh &    background (log: ~/.gang-sniper/supervise.log)
# Stop: kill the supervisor (its PID is in ~/.gang-sniper/supervise.pid); the sniper child is stopped with it.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${SNIPER_DATA_DIR:-$HOME/.gang-sniper}"
mkdir -p "$DATA"
echo $$ > "$DATA/supervise.pid"

child=0
stop() { [ "$child" -ne 0 ] && kill -TERM "$child" 2>/dev/null && wait "$child"; rm -f "$DATA/supervise.pid"; exit 0; }
trap stop INT TERM HUP

delay=5
while true; do
  started=$(date +%s)
  echo "$(date '+%F %T') start" >> "$DATA/supervise.log"
  # -i: no idle sleep; -s: no system sleep on AC power
  caffeinate -i -s node "$DIR/bin/gang-sniper.js" run >> "$DATA/run.out" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=0
  echo "$(date '+%F %T') exit $code" >> "$DATA/supervise.log"
  # crash loop guard: back off when it dies quickly, reset after a healthy run
  if [ $(( $(date +%s) - started )) -gt 300 ]; then delay=5; else delay=$(( delay * 2 > 300 ? 300 : delay * 2 )); fi
  sleep "$delay"
done
