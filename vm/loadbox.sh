#!/usr/bin/env bash
# The load box: runs the challenge's own `loadgen search` against the target, as the official benchmark does.
# Run as root.
#
#   bash vm/loadbox.sh setup TARGET_IP              once: Go, the load-box sysctls and limits, loadgen, and an ssh
#                                                   key the target must accept for root (search needs root ssh)
#   bash vm/loadbox.sh run LABEL REV [VAR=VALUE ...]   deploys REV on the target (target.sh deploy), then the full
#                                                   search: warm-up, doubling probes, bisection to 5%, 5-minute
#                                                   holds. Results in results/LABEL/
#   bash vm/loadbox.sh plan                         the comparison, one search each (about an hour each):
#                                                   calibrate (3de991e, scored 91,000 officially), the next
#                                                   submission's defaults, HTTP_WORKERS=3 and 4, READ_PLAN_CLOCK=2
#   bash vm/loadbox.sh summary                      every result so far, one line each
#
# MAX (default 240000) caps the probes; START (default 3000) is the warm-up and first probe.
# SRC (default auto) is the loadgen's -src: the load box's IPv4s to dial from. Every user holds a connection, and one
# source IP reaches one target IP:port on at most ~64k ports, so a box needs ceil(users / 64000) public IPv4s.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GO_VERSION=1.27.1
CONF=/root/loadbox.env
LG=/usr/local/bin/conduit-loadgen
NEXT=claude/fervent-franklin-b6tesx
say() { printf '\n[loadbox %s] %s\n' "$(date +%T)" "$*"; }

setup() {
  local target="${1:?usage: loadbox.sh setup TARGET_IP}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -y -q git curl openssh-client
  say "Go $GO_VERSION"
  if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go$GO_VERSION" ]; then
    curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"
    rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
  fi
  say "load-box sysctls (box/sysctl.conf: ip_local_port_range 1024 65535 matters) and descriptor limits"
  install -m 644 "$ROOT/box/sysctl.conf" /etc/sysctl.d/90-challenge.conf
  sysctl -q --system
  printf 'root soft nofile 1048576\nroot hard nofile 1048576\n' > /etc/security/limits.d/90-nofile.conf
  say "loadgen"
  (cd "$ROOT/bench" && /usr/local/go/bin/go build -o "$LG" ./cmd/loadgen)
  echo "TARGET=$target" > "$CONF"
  [ -f /root/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/id_ed25519
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$target" true 2>/dev/null; then
    say "ssh root@$target works"
    ssh "root@$target" "test -x /opt/mcsc/vm/target.sh && test -s /root/jwt-secret" ||
      echo "the target is not set up yet: run 'bash vm/target.sh setup' there"
  else
    say "root ssh to $target is refused. Add this key to /root/.ssh/authorized_keys on the target, then run setup again:"
    cat /root/.ssh/id_ed25519.pub
    exit 1
  fi
  say "DONE: next, bash vm/loadbox.sh plan (or run LABEL REV ...)"
}

run() {
  local label="${1:?usage: loadbox.sh run LABEL REV [VAR=VALUE ...]}" rev="${2:?usage: loadbox.sh run LABEL REV [VAR=VALUE ...]}"
  shift 2
  # shellcheck disable=SC1090
  . "$CONF"
  ulimit -n 1048576
  local out="$ROOT/results/$label"
  mkdir -p "$out"
  say "$label: deploy $rev $* on $TARGET"
  ssh "root@$TARGET" "bash /opt/mcsc/vm/target.sh deploy $(printf '%q ' "$rev" "$@")" 2>&1 | tee "$out/deploy.log"
  local secret
  secret="$(ssh "root@$TARGET" cat /root/jwt-secret)"
  say "$label: search (results in $out)"
  "$LG" search -target-ssh "root@$TARGET" -target-url "http://$TARGET" -no-switch -lang nish \
    -secret "$secret" -start "${START:-3000}" -max "${MAX:-240000}" -src "${SRC:-auto}" -label "$label" -outdir "$out" 2>&1 | tee "$out/search.log"
  ssh "root@$TARGET" "bash /opt/mcsc/vm/target.sh info" > "$out/target-info.txt" 2>&1 || true
  printf '%s  rev %s  %s\n' "$label" "$rev" "$*" > "$out/what.txt"
}

summary() {
  for d in "$ROOT"/results/*/; do
    [ -f "$d/search.log" ] || continue
    printf '%-28s %s\n' "$(basename "$d")" "$(cat "$d/what.txt" 2>/dev/null | cut -d' ' -f3-)"
    grep -E '^(SCORE|LG-LIMITED|RESULT)|^hold at|target CPU|cpu' "$d/search.log" | tail -4 | sed 's/^/    /'
  done
}

plan() {
  # Calibration first: the build #83 was scored at. Its result here is the factor for every other one.
  run calibrate-3de991e 3de991e
  run next-defaults "$NEXT"
  run next-http3 "$NEXT" HTTP_WORKERS=3
  run next-http4 "$NEXT" HTTP_WORKERS=4
  run next-clock2 "$NEXT" READ_PLAN_CLOCK=2
  summary
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  run) shift; run "$@" ;;
  plan) plan ;;
  summary) summary ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
