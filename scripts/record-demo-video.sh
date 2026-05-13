#!/usr/bin/env bash
#
# Records a 3-min silent screencast of the Agenomics MCP devnet demo.
#
# Strategy: spin up Xephyr on display :2 (sandboxed from the user's :0
# desktop), run xterm full-frame inside it, capture :2 with ffmpeg.
#
# The terminal demo carries the whole story: provision → register →
# create_vault → read-back via get_vault_info + get_agent_profile →
# pin the Solana Explorer URL on a held final frame for the user to
# overlay a "click here" callout in post.
#
# Output: ./demo-output/agenomics-demo.mp4 (1080p MP4, H.264 + silent AAC)
# Voice-over beat sheet: docs/VIDEO_3MIN_BEATS.md

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

OUT_DIR="$REPO/demo-output"
mkdir -p "$OUT_DIR"
MP4="$OUT_DIR/agenomics-demo.mp4"
LOG_DIR="$OUT_DIR/logs"
mkdir -p "$LOG_DIR"

DISP=:2
W=1920
H=1080
FPS=30

# ── Sanity ───────────────────────────────────────────────────────────
for bin in Xephyr ffmpeg xterm node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing: $bin"; exit 1; }
done

# Demo metadata gets persisted by the demo script via $DEMO_OUT.
DEMO_OUT="$OUT_DIR/demo-meta.json"
export DEMO_OUT

# Fallback URL used in the report block if the demo failed to capture one.
FALLBACK_URL="https://explorer.solana.com/address/28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw?cluster=devnet"

# ── Cleanup hook ─────────────────────────────────────────────────────
cleanup() {
  rc=$?
  echo "[record] cleanup (rc=$rc) ..."
  if [[ -n "${FFMPEG_PID:-}" ]]; then kill "$FFMPEG_PID" 2>/dev/null || true; fi
  if [[ -n "${XEPHYR_PID:-}" ]]; then kill "$XEPHYR_PID" 2>/dev/null || true; fi
  if [[ -n "${XTERM_PID:-}" ]];  then kill "$XTERM_PID"  2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Start sandboxed display ───────────────────────────────────────
echo "[record] starting Xephyr on $DISP at ${W}x${H}"
Xephyr "$DISP" -screen "${W}x${H}" -dpi 96 -ac -nolisten tcp -title "Agenomics Demo" \
  >"$LOG_DIR/xephyr.log" 2>&1 &
XEPHYR_PID=$!
sleep 2
kill -0 "$XEPHYR_PID" || { echo "Xephyr failed"; cat "$LOG_DIR/xephyr.log"; exit 1; }

# ── 2. Set a dark root window inside Xephyr ──────────────────────────
DISPLAY="$DISP" xsetroot -solid "#0a0a14" 2>/dev/null || true

# ── 3. Start ffmpeg capturing :2 ─────────────────────────────────────
echo "[record] ffmpeg capturing $DISP -> $MP4"
ffmpeg -y -hide_banner -loglevel warning \
  -f x11grab -framerate "$FPS" -video_size "${W}x${H}" -i "$DISP.0" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -c:a aac -shortest \
  "$MP4" >"$LOG_DIR/ffmpeg.log" 2>&1 &
FFMPEG_PID=$!
sleep 1

# ── 4. Terminal demo (fills the full 1920x1080 frame) ────────────────
echo "[record] running terminal demo (xterm full frame)"
# 140 cols × 44 rows at fs 18 (DejaVu Sans Mono) ≈ 1820×1012 px,
# readable on YouTube/Vimeo without zooming.
DISPLAY="$DISP" xterm \
  -geometry 140x44+0+0 \
  -fa "DejaVu Sans Mono" -fs 18 \
  -bg "#0a0a14" -fg "#e7e9ee" \
  -title "agenomics-demo" \
  -e bash -c "cd '$REPO' && DEMO_OUT='$DEMO_OUT' DEMO_HOLD_MS=30000 node scripts/demo-mcp-vault.mjs; echo; echo '  ── recorded at $(date -u +%Y-%m-%dT%H:%M:%SZ) ──'; sleep 3" &
XTERM_PID=$!

# Wait for the xterm to exit
wait "$XTERM_PID" || true
echo "[record] demo complete"

# Pull the captured Explorer URL out for the report
EXPLORER_URL="$FALLBACK_URL"
if [[ -f "$DEMO_OUT" ]]; then
  CAPTURED=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEMO_OUT','utf8')).explorer||'')}catch{}" 2>/dev/null || true)
  if [[ -n "$CAPTURED" && "$CAPTURED" != "https://explorer.solana.com/tx/—"* ]]; then
    EXPLORER_URL="$CAPTURED"
  fi
fi

# ── 5. Stop ffmpeg cleanly ───────────────────────────────────────────
echo "[record] stopping ffmpeg"
kill -INT "$FFMPEG_PID" 2>/dev/null || true
wait "$FFMPEG_PID" 2>/dev/null || true

# ── 8. Report ────────────────────────────────────────────────────────
if [[ -f "$MP4" ]]; then
  SIZE=$(stat -c%s "$MP4")
  DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4" 2>/dev/null || echo "?")
  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo " ✓ recording saved: $MP4"
  echo "   size:     $((SIZE / 1024)) KB"
  echo "   duration: ${DURATION}s"
  echo "   explorer: $EXPLORER_URL"
  echo "   meta:     $DEMO_OUT"
  echo "────────────────────────────────────────────────────────────"
else
  echo "✗ no MP4 produced — see $LOG_DIR/ffmpeg.log"
  exit 1
fi
