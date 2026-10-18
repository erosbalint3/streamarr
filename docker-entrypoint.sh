#!/bin/sh
# Starts as root just long enough to fix ownership of Streamarr's own folders, then
# runs the server as PUID:PGID. Media folders are never touched (mount them read-only).
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" != "0" ]; then
  # Already started as a specific user (e.g. `user:` in compose) – nothing to fix, just run.
  exec "$@"
fi

for dir in "${CONFIG_DIR:-/config}" "${TRANSCODE_DIR:-/transcode}"; do
  mkdir -p "$dir"
  # Docker creates missing bind-mount folders as root; take them over (only when needed,
  # so large caches aren't re-chowned on every start).
  if [ "$(stat -c '%u:%g' "$dir")" != "$PUID:$PGID" ] || [ -n "$(find "$dir" -mindepth 1 \( ! -uid "$PUID" -o ! -gid "$PGID" \) -print -quit 2>/dev/null)" ]; then
    echo "[entrypoint] setting owner of $dir to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$dir" || echo "[entrypoint] warning: could not chown $dir (read-only or network share?)"
  fi
done

# Supplementary groups: whatever compose's group_add gave us, plus the owners of any GPU
# device nodes, so hardware transcoding works without looking up group ids by hand.
groups="$(id -G | tr ' ' '\n')"
for dev in /dev/dri/renderD* /dev/dri/card* /dev/nvidia*; do
  [ -e "$dev" ] && groups="$groups
$(stat -c '%g' "$dev")"
done
groups="$(printf '%s\n' "$groups" | grep -v '^0$' | sort -un | paste -sd, -)"

if [ -n "$groups" ]; then
  exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$groups" --inh-caps=-all -- "$@"
fi
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
