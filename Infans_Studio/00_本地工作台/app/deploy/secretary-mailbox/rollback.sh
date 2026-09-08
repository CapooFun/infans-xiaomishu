#!/bin/sh
set -eu
base="${SECRETARY_MAILBOX_HOME:-/opt/secretary-mailbox}"
docker="${DOCKER:-/usr/local/bin/docker}"
test -s "$base/previous"
target="$(cat "$base/previous")"
test -d "$target"
ln -sfn "$target" "$base/current"
cp "$base/current/compose.yaml" "$base/compose.yaml"
cd "$base"
"$docker" compose up -d --build
