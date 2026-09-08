#!/bin/sh
set -eu
archive="${1:?release archive required}"
version="${2:?version required}"
base="${SECRETARY_MAILBOX_HOME:-/opt/secretary-mailbox}"
docker="${DOCKER:-/usr/local/bin/docker}"
mkdir -p "$base/releases" "$base/data" "$base/secrets" "$base/backups"
test -f "$base/secrets/secretary_mailbox_token"
chmod 700 "$base" "$base/data" "$base/secrets" "$base/backups"
chown -R 10001:10001 "$base/data" "$base/secrets"
chmod 400 "$base/secrets/secretary_mailbox_token"
test ! -e "$base/releases/$version"
mkdir "$base/releases/$version"
tar -xzf "$archive" -C "$base/releases/$version" --strip-components=1
if test -L "$base/current"; then readlink "$base/current" > "$base/previous"; fi
cp "$base/data/secretary-mailbox.v1.json" "$base/backups/pre-$version.json" 2>/dev/null || true
ln -sfn "$base/releases/$version" "$base/current"
cp "$base/current/compose.yaml" "$base/compose.yaml"
cd "$base"
if ! "$docker" compose up -d --build; then
  test -s "$base/previous" && ln -sfn "$(cat "$base/previous")" "$base/current"
  cp "$base/current/compose.yaml" "$base/compose.yaml"
  "$docker" compose up -d --build
  exit 1
fi
attempt=0
until wget -qO- http://127.0.0.1:${SECRETARY_MAILBOX_PORT:-8789}/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if test "$attempt" -ge 20; then
    test -s "$base/previous" && ln -sfn "$(cat "$base/previous")" "$base/current"
    cp "$base/current/compose.yaml" "$base/compose.yaml"
    "$docker" compose up -d --build
    exit 1
  fi
  sleep 1
done
