#!/bin/sh
# Runs inside the "builder" container. Every SYNC_INTERVAL_MINUTES:
#   1. check GitHub for a newer version of the site's code (if GITHUB_TOKEN is set),
#   2. pull chapters and wiki: from Google Drive, or, when site.config.json says "source": "vault",
#      the text from the vault repository (VAULT_TOKEN) and only the illustrations from Drive,
#   3. build the site next to the live one and swap it in, so readers never see a half-built site.
# Everything lives inside main(), which ends by exec or exit: an update can safely replace this file
# while it runs.
# A build-only copy of the vault at /app/vault. Reset to the remote on every pass: nobody edits it.
# The token is passed on each fetch and never written into git's config.
pull_vault() {
  if [ -z "$VAULT_TOKEN" ]; then
    echo "site.config.json says \"source\": \"vault\" but settings.env has no VAULT_TOKEN (nas/README.md)."
    return 1
  fi
  command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null || return 1
  url="https://x-access-token:${VAULT_TOKEN}@github.com/${VAULT_REPO:-momonekomata/pokemon-novel-vault}.git"
  [ -d /app/vault/.git ] || git init --quiet /app/vault || return 1
  git -C /app/vault fetch --quiet "$url" "${VAULT_BRANCH:-main}" && git -C /app/vault reset --quiet --hard FETCH_HEAD
}

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

    SOURCE=$(node -p "require('./site.config.json').source || 'drive'")
    if [ "$SOURCE" = "vault" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M')] Pulling text from the vault and illustrations from Google Drive..."
      VAULT_OK=true; pull_vault || VAULT_OK=false
    else
      echo "[$(date '+%Y-%m-%d %H:%M')] Pulling from Google Drive..."
      VAULT_OK=true
    fi
    if $VAULT_OK && npm run --silent sync && OUT_DIR=/public/next npm run --silent build; then
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
