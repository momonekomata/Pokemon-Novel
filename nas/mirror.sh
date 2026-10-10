#!/bin/sh
# Runs inside the "mirror" container. Every MIRROR_INTERVAL_MINUTES (default 60) it brings
# /mirror (drive-mirror/ on the NAS) up to date with the vault repository's main branch, as plain
# files with no .git folder inside, and writes the list of those files to /state/tracked.txt.
#
# It never writes into the Google Drive folder itself: Synology Cloud Sync does not notice changes
# made from inside a container. nas/drive-copy.sh, run on the NAS by DSM Task Scheduler, copies
# drive-mirror/ into the Drive folder Cloud Sync already syncs.
#
# Git's own data lives in /state (mirror-state/ on the NAS), never inside /mirror. If /mirror is
# switched to a different folder, the old bookkeeping is dropped so nothing is carried over.
main() {
  if [ -z "$VAULT_TOKEN" ]; then
    echo "The Drive mirror is off: add VAULT_TOKEN to settings.env and restart."
    exec sleep infinity
  fi
  command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null || exit 1

  REPO="${VAULT_REPO:-momonekomata/pokemon-novel-vault}"
  BRANCH="${VAULT_BRANCH:-main}"
  GIT_DIR=/state/vault-mirror.git
  INTERVAL=$(( ${MIRROR_INTERVAL_MINUTES:-60} * 60 ))

  TARGET_ID=$(stat -c '%d:%i' /mirror)
  if [ -d "$GIT_DIR" ] && [ "$(cat /state/mirror-target 2>/dev/null)" != "$TARGET_ID" ]; then
    echo "The mirror folder changed; starting its bookkeeping afresh (no files are removed)."
    rm -f "$GIT_DIR/index"
  fi
  echo "$TARGET_ID" > /state/mirror-target

  while true; do
    if [ ! -d "$GIT_DIR" ]; then
      git init --quiet --bare "$GIT_DIR"
      git --git-dir="$GIT_DIR" symbolic-ref HEAD "refs/heads/$BRANCH"
    fi
    # The token is passed on each fetch and never written into git's config.
    if git --git-dir="$GIT_DIR" fetch --quiet --depth=1 \
        "https://x-access-token:${VAULT_TOKEN}@github.com/${REPO}.git" "+${BRANCH}:refs/heads/${BRANCH}" \
      && git --git-dir="$GIT_DIR" --work-tree=/mirror reset --quiet --hard "$BRANCH" \
      && git -c core.quotePath=false --git-dir="$GIT_DIR" --work-tree=/mirror ls-files > /state/tracked.tmp \
      && mv /state/tracked.tmp /state/tracked.txt; then
      echo "[$(date '+%Y-%m-%d %H:%M')] Mirror at $(git --git-dir="$GIT_DIR" rev-parse --short "$BRANCH"), $(wc -l < /state/tracked.txt) files. Next check in ${MIRROR_INTERVAL_MINUTES:-60} minutes."
    else
      echo "[$(date '+%Y-%m-%d %H:%M')] Mirror update FAILED (see above). The previous copy stays as it was."
    fi
    sleep "$INTERVAL"
  done
}
main "$@"; exit
