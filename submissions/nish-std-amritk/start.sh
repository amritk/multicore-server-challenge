#!/usr/bin/env bash
# Runs the server in the foreground. Configured by DATABASE_URL, JWT_SECRET,
# HOST and PORT; README.md lists the optional tuning variables.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# One descriptor per keep-alive connection, as many as the service allows.
ulimit -n "$(ulimit -Hn)"
exec "$DIR/bin/conduit"
