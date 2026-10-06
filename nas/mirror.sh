#!/bin/sh
# Runs inside the "mirror" container. Every MIRROR_INTERVAL_MINUTES (default 60) it brings
# /mirror (drive-mirror/ on the NAS) up to date with the vault repository's main branch, as plain
# files with no .git folder inside. Synology Cloud Sync then uploads that folder to the Google Drive
# folder, one way, so Drive stays a read-only copy of the novel (nas/README.md, "Google Drive mirror").
#
# Git's own data lives in /state (mirror-state/ on the NAS), never inside /mirror, so Cloud Sync never
# sees it. Files the repo deletes are removed from /mirror; files the repo never had (if any) are left.
main() {
  if [ -z "$VAULT_TOKEN" ]; then
    echo "The Drive mirror is off: add VAULT_TOKEN to settings.env (nas/README.md) and restart."
    exec sleep infinity
  fi
  command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null || exit 1

  REPO="${VAULT_REPO:-momonekomata/pokemon-novel-vault}"
  BRANCH="${VAULT_BRANCH:-main}"
  GIT_DIR=/state/vault-mirror.git
  INTERVAL=$(( ${MIRROR_INTERVAL_MINUTES:-60} * 60 ))

  while true; do
    if [ ! -d "$GIT_DIR" ]; then
      git init --quiet --bare "$GIT_DIR"
      git --git-dir="$GIT_DIR" symbolic-ref HEAD "refs/heads/$BRANCH"
    fi
    # The token is passed on each fetch and never written into git's config.
    if git --git-dir="$GIT_DIR" fetch --quiet --depth=1 \
        "https://x-access-token:${VAULT_TOKEN}@github.com/${REPO}.git" "+${BRANCH}:refs/heads/${BRANCH}" \
      && git --git-dir="$GIT_DIR" --work-tree=/mirror reset --quiet --hard "$BRANCH"; then
      echo "[$(date '+%Y-%m-%d %H:%M')] Mirror at $(git --git-dir="$GIT_DIR" rev-parse --short "$BRANCH"). Next check in ${MIRROR_INTERVAL_MINUTES:-60} minutes."
    else
      echo "[$(date '+%Y-%m-%d %H:%M')] Mirror update FAILED (see above). The previous copy stays as it was."
    fi
    sleep "$INTERVAL"
  done
}
main "$@"; exit
