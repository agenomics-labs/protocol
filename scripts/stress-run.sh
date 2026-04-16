#!/usr/bin/env bash
# Launches N concurrent flows against the live validator, mixed modes.
# Usage: scripts/stress-run.sh [N] [OUT_DIR]

set -e
N="${1:-20}"
OUT="${2:-/tmp/stress}"
mkdir -p "$OUT"
rm -f "$OUT"/*.log "$OUT"/pids

MODES=(dispute rework happy happy cancel happy rework dispute happy happy)

echo "launching $N concurrent flows -> $OUT"
echo "wall clock start: $(date +%s.%N)" > "$OUT/timing"

# Start the log subscriber
solana logs 2uSDxQtYLU4uSeZtA1ueJx7xg4PDYpEbkxM957T5UUm4 > "$OUT/settle.log" 2>&1 &
echo $! > "$OUT/logger.pid"

sleep 0.3
T0=$(date +%s.%N)
FLOW_PIDS=()

for i in $(seq 1 "$N"); do
  MODE="${MODES[$((RANDOM % ${#MODES[@]}))]}"
  TASK_ID=$((100000 + i * 13))
  # Total between 1 and 10 USDC
  TOTAL=$((1000000 + (RANDOM % 9000000)))
  M1=$((TOTAL / 2))
  M2=$((TOTAL - M1))
  LABEL="F${i}-${MODE}"

  ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET=$HOME/.config/solana/id.json \
  FLOW_LABEL="$LABEL" FLOW_MODE="$MODE" FLOW_TASK_ID="$TASK_ID" \
  FLOW_TOTAL="$TOTAL" FLOW_M1="$M1" FLOW_M2="$M2" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 scripts/flow-runner.ts \
    > "$OUT/flow-$i.log" 2>&1 &
  FLOW_PIDS+=($!)
  echo "$! $LABEL task=$TASK_ID total=$TOTAL" >> "$OUT/pids"
done

echo "launched, waiting on ${#FLOW_PIDS[@]} flows..."
for pid in "${FLOW_PIDS[@]}"; do wait "$pid" || true; done
T1=$(date +%s.%N)
ELAPSED=$(echo "$T1 - $T0" | bc -l)
echo "wall clock end: $T1" >> "$OUT/timing"
echo "elapsed: $ELAPSED" >> "$OUT/timing"

sleep 1
kill "$(cat "$OUT/logger.pid")" 2>/dev/null || true

PASS=$(grep -l "1 passing" "$OUT"/flow-*.log | wc -l)
FAIL=$(grep -L "1 passing" "$OUT"/flow-*.log | wc -l)
TOTAL_TX=$(grep -c "Transaction executed" "$OUT/settle.log" || echo 0)

echo
echo "===== STRESS RESULTS ====="
printf "  flows:       %d\n" "$N"
printf "  passing:     %d\n" "$PASS"
printf "  failing:     %d\n" "$FAIL"
printf "  settle tx:   %d\n" "$TOTAL_TX"
printf "  wall clock:  %.2fs\n" "$ELAPSED"
if [[ "$ELAPSED" != "0" ]]; then
  printf "  tx/sec:      %.1f\n" "$(echo "$TOTAL_TX / $ELAPSED" | bc -l)"
fi
