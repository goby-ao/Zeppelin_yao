#!/usr/bin/env bash
#
# Build Zeppelin legacy web assets, package zeppelin-web WAR, and copy it to
# the local release directory.
#
# Usage:
#   scripts/build_zeppelin_web_release.sh
#
# Optional env vars:
#   DEPLOY_DIR=/path/to/release_dir
#   DEPS_FROM=/path/to/another/zeppelin-web
#   VERIFY_WAR=1
#   SKIP_COPY=1
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_DIR="${ROOT_DIR}/zeppelin-web"
WAR_NAME="zeppelin-web-0.9.1-SNAPSHOT.war"
WAR_PATH="${WEB_DIR}/target/${WAR_NAME}"
DEPLOY_DIR="${DEPLOY_DIR:-/Users/yao/projects/video_hadoop3_update/temp/zeppelin_audit_depoly}"
DEFAULT_DEPS_FROM="/Users/yao/IdeaProjects/Zeppelin_yao/zeppelin-web"

CREATED_LINKS=()

cleanup() {
  local link
  for link in "${CREATED_LINKS[@]:-}"; do
    [[ -L "${link}" ]] && rm -f "${link}"
  done
}
trap cleanup EXIT

log() {
  printf '[zeppelin-web-release] %s\n' "$*"
}

fail() {
  printf '[zeppelin-web-release] ERROR: %s\n' "$*" >&2
  exit 1
}

md5_print() {
  local file="$1"
  if command -v md5 >/dev/null 2>&1; then
    md5 "${file}"
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "${file}"
  else
    log "md5/md5sum not found, skip checksum"
  fi
}

link_dependency_dir() {
  local name="$1"
  local source="${DEPS_FROM}/${name}"
  local target="${WEB_DIR}/${name}"

  [[ -e "${target}" ]] && return 0
  [[ -e "${source}" ]] || return 0

  ln -s "${source}" "${target}"
  CREATED_LINKS+=("${target}")
  log "linked ${name} from ${DEPS_FROM}"
}

prepare_frontend_dependencies() {
  if [[ -d "${WEB_DIR}/node_modules" ]]; then
    return 0
  fi

  if [[ -z "${DEPS_FROM:-}" && "${WEB_DIR}" != "${DEFAULT_DEPS_FROM}" &&
        -d "${DEFAULT_DEPS_FROM}/node_modules" ]]; then
    DEPS_FROM="${DEFAULT_DEPS_FROM}"
  fi

  if [[ -z "${DEPS_FROM:-}" ]]; then
    fail "zeppelin-web/node_modules not found. Run npm/yarn install first, or set DEPS_FROM=/path/to/zeppelin-web"
  fi

  [[ -d "${DEPS_FROM}/node_modules" ]] ||
    fail "DEPS_FROM does not contain node_modules: ${DEPS_FROM}"

  link_dependency_dir node_modules
  link_dependency_dir bower_components
  link_dependency_dir node
}

verify_war() {
  local war="$1"
  local index vendor app paragraph

  [[ -f "${war}" ]] || fail "WAR not found: ${war}"

  index="$(unzip -p "${war}" index.html)"
  vendor="$(printf '%s' "${index}" | sed -nE 's/.*(scripts\/vendor\.[^"]+\.js).*/\1/p' | head -1)"
  app="$(printf '%s' "${index}" | sed -nE 's/.*(app\.[^"]+\.js).*/\1/p' | head -1)"
  paragraph="$(unzip -p "${war}" app/notebook/paragraph/paragraph.html)"

  [[ -n "${vendor}" ]] || fail "vendor bundle not found in WAR index.html"
  [[ -n "${app}" ]] || fail "app bundle not found in WAR index.html"

  unzip -p "${war}" "${vendor}" | grep -q 'jQuery JavaScript Library v3.6.4' ||
    fail "WAR vendor bundle is not using jQuery 3.6.4"
  unzip -p "${war}" "${vendor}" | grep -q 'angular.module("as.sortable"' ||
    fail "WAR vendor bundle does not contain as.sortable"
  printf '%s' "${paragraph}" | grep -q 'resendCancelParagraph(paragraph, \$event)' ||
    fail "WAR paragraph template missing resend cancel handler"
  printf '%s' "${paragraph}" | grep -q 'paragraph-cancel-force-note' ||
    fail "WAR paragraph template missing inline force-stop note"

  log "verified WAR bundles: ${vendor}, ${app}"
}

main() {
  command -v mvn >/dev/null 2>&1 || fail "mvn command not found"

  prepare_frontend_dependencies

  export PATH="${WEB_DIR}/node:${WEB_DIR}/node_modules/.bin:${PATH}"

  log "building frontend dist"
  (
    cd "${WEB_DIR}"
    npm-run-all prebuild
    npm_lifecycle_event=build:dist webpack
    grunt post-webpack-dist
  )

  log "packaging WAR"
  (
    cd "${ROOT_DIR}"
    mvn -pl zeppelin-web war:war -DskipTests
  )

  if [[ "${VERIFY_WAR:-0}" == "1" ]]; then
    command -v unzip >/dev/null 2>&1 || fail "unzip command not found"
    verify_war "${WAR_PATH}"
  else
    log "skip WAR content verification; set VERIFY_WAR=1 to enable"
  fi

  if [[ "${SKIP_COPY:-0}" == "1" ]]; then
    log "SKIP_COPY=1, WAR left at ${WAR_PATH}"
    md5_print "${WAR_PATH}"
    return 0
  fi

  mkdir -p "${DEPLOY_DIR}"
  cp -p "${WAR_PATH}" "${DEPLOY_DIR}/${WAR_NAME}"
  log "copied WAR to ${DEPLOY_DIR}/${WAR_NAME}"
  md5_print "${DEPLOY_DIR}/${WAR_NAME}"
}

main "$@"
