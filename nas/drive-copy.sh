#!/bin/sh
# Copies the vault mirror (drive-mirror/) into the NAS's synced copy of the novel's Google Drive folder.
# Run it on the NAS itself, as root, from DSM Task Scheduler:
# Synology Cloud Sync notices files written this way, but not files written from inside a container.
#
# Set the Drive folder in settings.env:
#   DRIVE_COPY_DIR=/volume3/homes/<you>/Google Drive/Pokemon Novel - Reference Files and Chapters
#
# What it does, every run:
#   - every file the vault has is made identical to the vault, and only files that differ are written,
#     so Cloud Sync uploads real changes only (an edit made in Drive is put back);
#   - a file the vault has deleted since the last run is deleted;
#   - nothing else is ever touched: illustrations/ and any other Drive-only file stay as they are.
# Safety stops: it refuses to run if the Drive folder has no illustrations/ (a wrong path), and it skips
# deletions if a run would delete more than 25 files at once (a broken mirror, not a real change).

HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/drive-mirror"
LIST="$HERE/mirror-state/tracked.txt"
DONE="$HERE/mirror-state/copied.txt"
LOG="$HERE/drive-copy.log"
MAX_DELETES=25

say() { echo "[$(date '+%Y-%m-%d %H:%M')] $*" | tee -a "$LOG"; }

if [ ! -f "$HERE/settings.env" ]; then say "Not copying: there is no settings.env in $HERE."; exit 1; fi
# Forgiving about how the line was typed: spaces, "export", quotes, Windows line endings, or a line that got
# stuck onto the end of the one before it.
line=$(grep -a 'DRIVE_COPY_DIR=' "$HERE/settings.env" | tail -n 1 | tr -d '\r')
if [ -z "$line" ]; then say "Not copying: settings.env in $HERE has no DRIVE_COPY_DIR= line yet. Add it on a line of its own."; exit 1; fi
case "$line" in
  DRIVE_COPY_DIR=*|" "*|"export "*|"	"*) ;;
  *) say "Note: in settings.env the DRIVE_COPY_DIR line is stuck onto the end of another line (\"${line%%DRIVE_COPY_DIR=*}\"). Put it on a line of its own; that other setting is probably broken too." ;;
esac
TARGET=${line#*DRIVE_COPY_DIR=}
TARGET=$(printf '%s' "$TARGET" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
TARGET=${TARGET%/}
if [ -z "$TARGET" ]; then say "Not copying: DRIVE_COPY_DIR in settings.env is empty. Put the Drive folder's path after the = sign."; exit 1; fi
if [ ! -d "$TARGET/illustrations" ]; then say "Not copying: \"$TARGET\" has no illustrations/ folder, so it is not the novel's Drive folder. Check DRIVE_COPY_DIR."; exit 1; fi
if [ ! -s "$LIST" ]; then say "Not copying: the mirror has not finished a run yet (no $LIST)."; exit 1; fi
case "$TARGET/" in "$SRC/"*|"$HERE/"*) say "Not copying: DRIVE_COPY_DIR points inside the project folder."; exit 1;; esac

if command -v cmp >/dev/null 2>&1; then
  same() { cmp -s "$1" "$2"; }
else
  same() { [ "$(md5sum < "$1")" = "$(md5sum < "$2")" ]; }
fi

written=0; missing=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  s="$SRC/$p"; t="$TARGET/$p"
  if [ ! -f "$s" ]; then missing=$((missing + 1)); continue; fi
  if [ -f "$t" ] && same "$s" "$t"; then continue; fi
  mkdir -p "$(dirname "$t")" || continue
  # Written in place (no temporary files for Cloud Sync to pick up; the file keeps its Drive identity).
  if cat "$s" > "$t"; then written=$((written + 1)); else say "Could not write $p"; fi
done < "$LIST"

deleted=0
if [ -s "$DONE" ]; then
  sort "$LIST" > "$HERE/mirror-state/now.sorted"
  sort "$DONE" > "$HERE/mirror-state/before.sorted"
  comm -23 "$HERE/mirror-state/before.sorted" "$HERE/mirror-state/now.sorted" > "$HERE/mirror-state/gone.txt"
  gone=$(grep -c . "$HERE/mirror-state/gone.txt")
  if [ "$gone" -gt "$MAX_DELETES" ]; then
    say "Skipped deleting $gone files: more than $MAX_DELETES at once looks like a broken mirror, not a real change. See mirror-state/gone.txt."
    keep_done=1
  else
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ -f "$TARGET/$p" ] && rm -f "$TARGET/$p"; then deleted=$((deleted + 1)); fi
    done < "$HERE/mirror-state/gone.txt"
  fi
  rm -f "$HERE/mirror-state/now.sorted" "$HERE/mirror-state/before.sorted"
fi
# After a skipped deletion, keep the old list so the files are still known next time.
[ -n "$keep_done" ] || cp "$LIST" "$DONE"

if [ "$written" -gt 0 ] || [ "$deleted" -gt 0 ] || [ "$missing" -gt 0 ]; then
  say "Copied $written changed files, deleted $deleted, $missing listed but not found (mirror mid-update; next run catches up)."
fi
# Keep the log short.
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
