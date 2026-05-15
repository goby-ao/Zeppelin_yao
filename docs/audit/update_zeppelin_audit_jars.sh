#!/usr/bin/env bash

set -euo pipefail

MODE="${1:---dry-run}"

ZEPPELIN_HOME="${ZEPPELIN_HOME:-/data/cdh/zeppelin-0.9.1-SNAPSHOT}"
PACKAGE_DIR="${PACKAGE_DIR:-/data/gc/code_share/temp/zeppelin_audit_depoly}"
VERSION="${VERSION:-0.9.1-SNAPSHOT}"
BACKUP_ROOT="${BACKUP_ROOT:-${ZEPPELIN_HOME}/audit-jar-backup}"
BACKUP_DIR="${BACKUP_ROOT}/$(date +%Y%m%d%H%M%S)"
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
  $0 --dry-run
  $0 --apply

Environment overrides:
  ZEPPELIN_HOME=${ZEPPELIN_HOME}
  PACKAGE_DIR=${PACKAGE_DIR}
  VERSION=${VERSION}
  BACKUP_ROOT=${BACKUP_ROOT}
  USE_SUDO=${USE_SUDO}        # auto, true, or false

Note:
  Please stop Zeppelin before --apply, then restart it after replacement.
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
    fail "target file differs from source after copy: ${target_file}"
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
  --dry-run|--apply)
    ;;
  *)
    usage
    exit 2
    ;;
esac

[[ -d "${ZEPPELIN_HOME}" ]] || fail "ZEPPELIN_HOME not found: ${ZEPPELIN_HOME}"
[[ -d "${PACKAGE_DIR}" ]] || fail "PACKAGE_DIR not found: ${PACKAGE_DIR}"

echo "Mode: ${MODE}"
echo "Zeppelin home: ${ZEPPELIN_HOME}"
echo "Package dir: ${PACKAGE_DIR}"
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
  source_file="${PACKAGE_DIR}/${jar_name}"
  target_dir="${ZEPPELIN_HOME}/${relative_dir}"
  target_file="${target_dir}/${jar_name}"

  [[ -f "${source_file}" ]] || fail "new jar not found: ${source_file}"
  [[ -d "${target_dir}" ]] || fail "target dir not found: ${target_dir}"
  [[ -f "${target_file}" ]] || fail "old jar not found, refuse to replace without backup source: ${target_file}"
done

run mkdir -p "${BACKUP_DIR}/lib" "${BACKUP_DIR}/interpreter"

for item in "${JARS[@]}"; do
  jar_name="${item%%:*}"
  relative_dir="${item##*:}"
  source_file="${PACKAGE_DIR}/${jar_name}"
  target_dir="${ZEPPELIN_HOME}/${relative_dir}"
  target_file="${target_dir}/${jar_name}"
  backup_file="${BACKUP_DIR}/${relative_dir}/${jar_name}"

  echo
  echo "Updating ${jar_name}"
  run cp -p "${target_file}" "${backup_file}"
  run cp -p "${source_file}" "${target_file}"

  if [[ "${MODE}" == "--apply" ]]; then
    verify_checksum "${source_file}" "${target_file}"
  fi
done

echo
if [[ "${MODE}" == "--dry-run" ]]; then
  echo "Dry-run completed. No file was changed. Run with --apply to replace jars."
else
  echo "Update completed. Backup saved at: ${BACKUP_DIR}"
  echo "Restart Zeppelin to load the new jars."
fi
