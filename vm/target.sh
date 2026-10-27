#!/usr/bin/env bash
# The benchmark target: the 8 vCPU / 16 GB box, set up as the challenge's box is. Run as root.
#
#   bash vm/target.sh setup                              once: box/setup-box.sh, Go, the full seed, a JWT secret,
#                                                        the CPU monitor `loadgen search` runs
#   bash vm/target.sh deploy REV [SUB] [VAR=VALUE ...]   builds submissions/SUB (default nish-std-amritk) at git
#                                                        REV (a commit or a branch), resets the database from the
#                                                        seed, and starts it as challenge.service, with VAR=VALUE
#                                                        added to its environment (e.g. HTTP_WORKERS=4)
#   bash vm/target.sh info                               the box, and what is deployed
#
# loadbox.sh calls `deploy` over ssh; nothing here needs to be run by hand after `setup`.
set -euo pipefail
REPO="${REPO:-https://github.com/amritk/multicore-server-challenge}"
DIR=/opt/mcsc
GO_VERSION=1.27.1
SECRET_FILE=/root/jwt-secret
say() { printf '\n[target %s] %s\n' "$(date +%T)" "$*"; }

fetch() {
  [ -d "$DIR/.git" ] || git clone -q "$REPO" "$DIR"
  git -C "$DIR" fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
}

setup() {
  # Everything setup prints is kept, so a step that fails can be read again.
  exec > >(tee -a /root/target-setup.log) 2>&1
  trap 'echo "[target] setup FAILED at line $LINENO (log: /root/target-setup.log)"' ERR
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -y -q git curl python3 openssl
  fetch
  git -C "$DIR" checkout -q --detach origin/claude/nish-vm-bench 2>/dev/null || true
  say "box/setup-box.sh: Postgres 18, Nginx, sysctls, user challenge, challenge.service"
  bash "$DIR/box/setup-box.sh"

  say "Go $GO_VERSION (builds the seed generator)"
  if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go$GO_VERSION" ]; then
    curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"
    rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
  fi

  say "the full seed (conduit_seed, ~2.4 GB; 5-10 minutes)"
  chown -R postgres: "$DIR/seed"
  if ! runuser -u postgres -- psql -tAXc "SELECT 1 FROM pg_database WHERE datname = 'conduit_seed'" | grep -q 1; then
    runuser -u postgres -- env PATH="/usr/local/go/bin:$PATH" HOME=/var/lib/postgresql bash "$DIR/seed/make-seed.sh"
  fi

  [ -s "$SECRET_FILE" ] || (umask 077 && openssl rand -hex 32 > "$SECRET_FILE")

  say "the CPU monitor loadgen search runs (/opt/conduit-tools/monitor.sh)"
  install -d /opt/conduit-tools /root/conduit-monitor
  install -m 755 "$DIR/vm/monitor.py" /opt/conduit-tools/monitor.py
  printf '#!/bin/sh\nexec python3 /opt/conduit-tools/monitor.py "$@"\n' > /opt/conduit-tools/monitor.sh
  chmod 755 /opt/conduit-tools/monitor.sh
  info
  say "DONE: on the load box, run: bash vm/loadbox.sh setup $(hostname -I | awk '{print $1}')"
}

deploy() {
  local rev="${1:?usage: target.sh deploy REV [SUB] [VAR=VALUE ...]}"
  shift
  local sub=nish-std-amritk
  if [ $# -gt 0 ] && [[ "$1" != *=* ]]; then sub="$1"; shift; fi
  fetch
  if [ ! -s "$SECRET_FILE" ] ||
    ! runuser -u postgres -- psql -tAXc "SELECT 1 FROM pg_database WHERE datname = 'conduit_seed'" | grep -q 1; then
    echo "the target is not set up (no $SECRET_FILE or no conduit_seed database):" >&2
    echo "run 'bash /opt/mcsc/vm/target.sh setup' and check /root/target-setup.log" >&2
    exit 1
  fi
  local commit
  commit="$(git -C "$DIR" rev-parse --verify -q "origin/$rev^{commit}" || git -C "$DIR" rev-parse --verify "$rev^{commit}")"
  local short="${commit:0:7}"
  local build="/opt/challenge/$sub-$short"

  say "stop the server; $sub at $short ($rev)"
  systemctl stop challenge 2>/dev/null || true
  if [ ! -f "$build/.built" ]; then
    rm -rf "$build" && install -d -o challenge -g challenge "$build"
    git -C "$DIR" archive "$commit" "submissions/$sub" | tar -x --strip-components=2 -C "$build"
    say "install.sh (as root)"
    (cd "$build" && bash install.sh)
    chown -R challenge: "$build"
    say "build.sh (as challenge)"
    runuser -u challenge -- bash -c "cd '$build' && bash build.sh"
    touch "$build/.built"
  fi
  ln -sfn "$build" /opt/challenge/current

  # Front: direct serves port 80 itself, so Nginx is stopped; Front: nginx listens on 127.0.0.1:3000 behind it.
  local host=0.0.0.0 port=80
  if grep -qiE '^[*_ ]*front[*_ ]*:[*_ ]*nginx' "$build/README.md"; then
    host=127.0.0.1 port=3000
    systemctl start nginx
  else
    systemctl stop nginx
  fi
  {
    echo "DATABASE_URL=postgres://conduit:conduit@127.0.0.1:5432/conduit"
    echo "JWT_SECRET=$(cat "$SECRET_FILE")"
    echo "HOST=$host"
    echo "PORT=$port"
    for kv in "$@"; do echo "$kv"; done
  } > /etc/challenge/env
  chown root:challenge /etc/challenge/env && chmod 640 /etc/challenge/env

  say "fresh database conduit from conduit_seed, Postgres restarted"
  runuser -u postgres -- psql -qX -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS conduit WITH (FORCE)" \
    -c "CREATE DATABASE conduit TEMPLATE conduit_seed STRATEGY FILE_COPY"
  systemctl restart postgresql@18-main
  for _ in $(seq 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done

  say "start; settings: ${*:-defaults}"
  systemctl start challenge
  for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$port/api/tags" && break; sleep 1; done
  if ! curl -sf -o /dev/null "http://127.0.0.1:$port/api/tags"; then
    journalctl -u challenge -n 40 --no-pager
    echo "GET /api/tags did not answer within 60 s" >&2
    exit 1
  fi
  printf '%s %s %s %s\n' "$(date -Is)" "$sub" "$short" "$*" | tee -a /root/deployed.txt
  ps -o pid,user,nlwp,rss,args -u challenge | head -20
}

info() {
  echo "host $(hostname): $(nproc) vCPU, $(awk '/MemTotal/{print int($2/1048576 + 0.5)}' /proc/meminfo) GB"
  lscpu | grep -E '^(Model name|Thread\(s\) per core|Core\(s\) per socket|Socket\(s\)|CPU max MHz|Hypervisor vendor)' || true
  echo "postgres $(runuser -u postgres -- psql -tAXc 'show server_version' 2>/dev/null || echo -)"
  tail -3 /root/deployed.txt 2>/dev/null || echo "nothing deployed yet"
}

case "${1:-}" in
  setup) setup ;;
  deploy) shift; deploy "$@" ;;
  info) info ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
