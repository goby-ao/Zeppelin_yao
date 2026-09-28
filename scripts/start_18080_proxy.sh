#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /Users/yao/.nvm/versions/node/v12.22.12/bin/node "$SCRIPT_DIR/zeppelin-online-proxy.js"
