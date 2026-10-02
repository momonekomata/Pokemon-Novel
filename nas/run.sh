#!/bin/sh
# Runs inside the "builder" container. Every SYNC_INTERVAL_MINUTES:
#   1. check GitHub for a newer version of the site's code (if GITHUB_TOKEN is set),
#   2. pull chapters and wiki from Google Drive,
#   3. build the site next to the live one and swap it in, so readers never see a half-built site.
# Everything lives inside main(), which ends by exec or exit: an update can safely replace this file
# while it runs.
main() {
  cd /app || exit 1
  export GOOGLE_SERVICE_ACCOUNT_FILE=/app/secrets/google-key.json
  INTERVAL=$(( ${SYNC_INTERVAL_MINUTES:-60} * 60 ))

  if [ "$1" != "--restarted" ]; then
    echo "Installing the site's tools (first start only takes a minute)..."
    npm ci --no-audit --no-fund || exit 1
  fi

  while true; do
    node scripts/self-update.mjs
    if [ $? -eq 3 ]; then
      echo "The update changed this loop; restarting it."
      exec sh /app/nas/run.sh --restarted
    fi

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
}
main "$@"; exit
