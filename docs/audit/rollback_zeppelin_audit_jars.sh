#!/usr/bin/env bash

set -euo pipefail

MODE="${1:---dry-run}"
BACKUP_DIR="${2:-}"

ZEPPELIN_HOME="${ZEPPELIN_HOME:-/data/cdh/zeppelin-0.9.1-SNAPSHOT}"
VERSION="${VERSION:-0.9.1-SNAPSHOT}"
BACKUP_ROOT="${BACKUP_ROOT:-${ZEPPELIN_HOME}/audit-jar-backup}"
USE_SUDO="${USE_SUDO:-auto}"
SUDO_CMD=()

JARS=(
  "zeppelin-interpreter-${VERSION}.jar:lib"
  "zeppelin-interpreter-shaded-${VERSION}.jar:interpreter"
  "zeppelin-server-${VERSION}.jar:lib"
  "zeppelin-zengine-${VERSION}.jar:lib"
)

usage() {
  cat <<EOF
Usage:
  $0 --list
  $0 --dry-run BACKUP_DIR
  $0 --apply BACKUP_DIR

Examples:
  $0 --list
  $0 --dry-run /data/cdh/zeppelin-0.9.1-SNAPSHOT/audit-jar-backup/20260515203900
  $0 --apply /data/cdh/zeppelin-0.9.1-SNAPSHOT/audit-jar-backup/20260515203900

Environment overrides:
  ZEPPELIN_HOME=${ZEPPELIN_HOME}
  VERSION=${VERSION}
  BACKUP_ROOT=${BACKUP_ROOT}
  USE_SUDO=${USE_SUDO}        # auto, true, or false

Note:
  Please stop Zeppelin before --apply, then restart it after rollback.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

run() {
  printf '+'
  if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then
    printf ' %q' "${SUDO_CMD[@]}"
  fi
  printf ' %q' "$@"
  printf '\n'

  if [[ "${MODE}" == "--apply" ]]; then
    "${SUDO_CMD[@]}" "$@"
  fi
}

verify_checksum() {
  local source_file="$1"
  local target_file="$2"

  if ! "${SUDO_CMD[@]}" cmp -s "${source_file}" "${target_file}"; then
    fail "target file differs from backup after rollback: ${target_file}"
  fi
}

case "${USE_SUDO}" in
  auto)
    if [[ "$(id -u)" != "0" ]]; then
      SUDO_CMD=(sudo)
    fi
    ;;
  true|yes|1)
    SUDO_CMD=(sudo)
    ;;
  false|no|0)
    SUDO_CMD=()
    ;;
  *)
    fail "invalid USE_SUDO: ${USE_SUDO}, expected auto, true, or false"
    ;;
esac

case "${MODE}" in
  --list)
    [[ -d "${BACKUP_ROOT}" ]] || fail "BACKUP_ROOT not found: ${BACKUP_ROOT}"
    find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d | sort -r
    exit 0
    ;;
  --dry-run|--apply)
    ;;
  *)
    usage
    exit 2
    ;;
esac

[[ -n "${BACKUP_DIR}" ]] || {
  usage
  exit 2
}

[[ -d "${ZEPPELIN_HOME}" ]] || fail "ZEPPELIN_HOME not found: ${ZEPPELIN_HOME}"
[[ -d "${BACKUP_DIR}" ]] || fail "BACKUP_DIR not found: ${BACKUP_DIR}"

echo "Mode: ${MODE}"
echo "Zeppelin home: ${ZEPPELIN_HOME}"
echo "Backup dir: ${BACKUP_DIR}"
if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then
  echo "Privileged command: ${SUDO_CMD[*]}"
else
  echo "Privileged command: disabled"
fi
echo

if [[ "${MODE}" == "--apply" && ${#SUDO_CMD[@]} -gt 0 ]]; then
  "${SUDO_CMD[@]}" -v
fi

for item in "${JARS[@]}"; do
  jar_name="${item%%:*}"
  relative_dir="${item##*:}"
  backup_file="${BACKUP_DIR}/${relative_dir}/${jar_name}"
  target_dir="${ZEPPELIN_HOME}/${relative_dir}"
  target_file="${target_dir}/${jar_name}"

  [[ -f "${backup_file}" ]] || fail "backup jar not found: ${backup_file}"
  [[ -d "${target_dir}" ]] || fail "target dir not found: ${target_dir}"
  [[ -f "${target_file}" ]] || fail "current jar not found: ${target_file}"
done

for item in "${JARS[@]}"; do
  jar_name="${item%%:*}"
  relative_dir="${item##*:}"
  backup_file="${BACKUP_DIR}/${relative_dir}/${jar_name}"
  target_file="${ZEPPELIN_HOME}/${relative_dir}/${jar_name}"

  echo
  echo "Rolling back ${jar_name}"
  run cp -p "${backup_file}" "${target_file}"

  if [[ "${MODE}" == "--apply" ]]; then
    verify_checksum "${backup_file}" "${target_file}"
  fi
done

echo
if [[ "${MODE}" == "--dry-run" ]]; then
  echo "Dry-run completed. No file was changed. Run with --apply and the same BACKUP_DIR to rollback jars."
else
  echo "Rollback completed from: ${BACKUP_DIR}"
  echo "Restart Zeppelin to load the restored jars."
fi
