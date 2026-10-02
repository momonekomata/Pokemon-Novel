#!/bin/sh
# Runs inside the "builder" container: every SYNC_INTERVAL_MINUTES, pull from Drive and rebuild.
# The new site is built next to the live one and swapped in at the end, so readers never
# see a half-built site.
cd /app || exit 1
export GOOGLE_SERVICE_ACCOUNT_FILE=/app/secrets/google-key.json
INTERVAL=$(( ${SYNC_INTERVAL_MINUTES:-60} * 60 ))

echo "Installing the site's tools (first start only takes a minute)..."
npm ci --no-audit --no-fund || exit 1

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M')] Pulling from Google Drive..."
  if npm run --silent sync && OUT_DIR=/public/next npm run --silent build; then
    rm -rf /public/previous
    [ -d /public/site ] && mv /public/site /public/previous
    mv /public/next /public/site
    echo "[$(date '+%Y-%m-%d %H:%M')] Site updated. Next check in ${SYNC_INTERVAL_MINUTES:-60} minutes."
  else
    rm -rf /public/next
    echo "[$(date '+%Y-%m-%d %H:%M')] Update FAILED (see the message above). The previous site stays up."
  fi
  sleep "$INTERVAL"
done
