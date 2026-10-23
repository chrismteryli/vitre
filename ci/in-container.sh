#!/usr/bin/env bash
# Runs the install test and the smoke test in an Ubuntu 26.10 container (the release that ships GNOME Shell 51), with docker or podman.
# GitHub Actions calls the steps one by one; on a laptop with docker or podman, `ci/in-container.sh all` does the same thing.
#
#   ci/in-container.sh start         pull ubuntu:26.10, start it (this checkout mounted read-only at /src, $VITRE_CI_OUT at /out)
#   ci/in-container.sh setup         install GNOME Shell 51 and the test tools, create the test user (ci/container-setup.sh, as root)
#   ci/in-container.sh install-test  ci/install-test.sh as the test user
#   ci/in-container.sh smoke-test    ci/smoke-test.sh as the test user
#   ci/in-container.sh stop          remove the container
#   ci/in-container.sh all           start, setup, both tests, stop (stops even when something failed)
#
# Settings: VITRE_CI_IMAGE (default ubuntu:26.10), VITRE_CI_ENGINE (docker or podman; default: whichever is installed),
#           VITRE_CI_CONTAINER (container name, default vitre-ci), VITRE_CI_OUT (default ./ci-out: logs, screenshot, summary).
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IMAGE="${VITRE_CI_IMAGE:-ubuntu:26.10}"
NAME="${VITRE_CI_CONTAINER:-vitre-ci}"
ENGINE="${VITRE_CI_ENGINE:-$(command -v docker || command -v podman || true)}"
[ -n "$ENGINE" ] || die "neither docker nor podman is installed"

engine() { "$ENGINE" "$@"; }

cmd_start() {
  group "pull $IMAGE ($(uname -m))"
  local n ok=0
  for n in 1 2 3; do
    if engine pull "$IMAGE"; then ok=1; break; fi
    echo "pull failed (attempt $n of 3)"; sleep $((n * 5))
  done
  if [ "$ok" -ne 1 ] && [ "$IMAGE" = "ubuntu:26.10" ]; then
    # Docker Hub rate limits sometimes hit shared runners: the same image from Google's mirror of Docker Hub
    echo "falling back to mirror.gcr.io/library/ubuntu:26.10"
    engine pull mirror.gcr.io/library/ubuntu:26.10 && engine tag mirror.gcr.io/library/ubuntu:26.10 "$IMAGE" && ok=1
  fi
  [ "$ok" -eq 1 ] || die "could not pull $IMAGE"
  engine image inspect "$IMAGE" --format 'image {{.Id}} {{.Os}}/{{.Architecture}}' 2>/dev/null || true
  endgroup
  chmod 777 "$OUT"      # the test user in the container is not the user who owns this folder
  engine rm -f "$NAME" >/dev/null 2>&1 || true
  engine run -d --init --name "$NAME" \
    -v "$REPO:/src:ro" -v "$OUT:/out" \
    -e VITRE_REPO=/src -e VITRE_CI_OUT=/out -e GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" -e TERM=dumb \
    "$IMAGE" sleep infinity >/dev/null || die "could not start the container"
  echo "container $NAME is running ($IMAGE, mounting $REPO at /src and $OUT at /out)"
}

cmd_setup() {
  engine exec -u root "$NAME" bash /src/ci/container-setup.sh
}

# Runs one of the test scripts as the test user. The icon theme fetched by container-setup.sh is passed along when it is there.
run_as_user() {
  local script="$1" extra=()
  if engine exec "$NAME" test -x /opt/mactahoe/src/install.sh; then extra=(-e VITRE_ICONS_SRC=/opt/mactahoe/src); fi
  engine exec -u vitre -w /home/vitre "${extra[@]}" "$NAME" bash "/src/ci/$script"
}

cmd_stop() { engine rm -f "$NAME" >/dev/null 2>&1 || true; }

case "${1:-}" in
  start)        cmd_start ;;
  setup)        cmd_setup ;;
  install-test) run_as_user install-test.sh ;;
  smoke-test)   run_as_user smoke-test.sh ;;
  stop)         cmd_stop ;;
  all)
    rc=0
    cmd_start && cmd_setup || rc=1
    if [ "$rc" -eq 0 ]; then
      run_as_user install-test.sh || rc=1
      run_as_user smoke-test.sh || rc=1
    fi
    cmd_stop
    echo; echo "logs, screenshot and summary: $OUT"
    exit "$rc"
    ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac
