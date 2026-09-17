#!/usr/bin/env bash
# Build one explicit set of Zeppelin artifacts into an immutable Git release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION="0.9.1-SNAPSHOT"
SCOPE=""
CLUSTER=""
RELEASE_PARENT="${RELEASE_PARENT:-/Users/yao/projects/video_hadoop3_update/zeppelin_deploy}"
MODULES=()
TARGETS=()

usage() {
  printf 'Usage: %s --scope web|core|runtime|web+core|web+runtime --cluster ns1|ns2|ns3 [--release-parent GIT_DIRECTORY]\n' "$0"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    fail 'shasum or sha256sum is required'
  fi
}

add_artifact() {
  MODULES+=("$1")
  TARGETS+=("$2")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope|--cluster|--release-parent)
      [[ $# -ge 2 ]] || fail "missing value for $1"
      case "$1" in
        --scope) SCOPE="$2" ;;
        --cluster) CLUSTER="$2" ;;
        --release-parent) RELEASE_PARENT="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "${SCOPE}" in
  web|core|runtime|web+core|web+runtime) ;;
  *) usage; fail 'invalid or missing --scope' ;;
esac
case "${CLUSTER}" in
  ns1|ns2|ns3) ;;
  *) usage; fail 'invalid or missing --cluster' ;;
esac
[[ -d "${RELEASE_PARENT}" && ! -L "${RELEASE_PARENT}" ]] ||
  fail '--release-parent must name an existing directory inside a Git repository'
RELEASE_PARENT="$(cd "${RELEASE_PARENT}" && pwd -P)"
[[ "$(git -C "${RELEASE_PARENT}" rev-parse --is-inside-work-tree 2>/dev/null)" == true ]] ||
  fail '--release-parent must be inside a Git worktree'
[[ -z "$(git -C "${ROOT_DIR}" status --porcelain)" ]] ||
  fail 'Zeppelin source tree is dirty; commit the source before building a release'

SOURCE_COMMIT="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
RELEASE_ID="${CLUSTER}-$(date '+%Y%m%d-%H%M%S')-${SOURCE_COMMIT:0:8}"
RELEASE_DIR="${RELEASE_PARENT}/${RELEASE_ID}"
[[ ! -e "${RELEASE_DIR}" && ! -L "${RELEASE_DIR}" ]] || fail "release already exists: ${RELEASE_DIR}"

if [[ "${SCOPE}" == web* ]]; then
  "${SCRIPT_DIR}/build_zeppelin_web_release.sh"
  add_artifact zeppelin-web "zeppelin-web-${VERSION}.war"
fi

case "${SCOPE}" in
  core|web+core)
    (cd "${ROOT_DIR}" && mvn -pl zeppelin-server -am -DskipTests package)
    ;;
  runtime|web+runtime)
    (cd "${ROOT_DIR}" && mvn -pl zeppelin-server,zeppelin-interpreter-shaded -am -DskipTests package)
    ;;
esac
[[ "$(git -C "${ROOT_DIR}" rev-parse HEAD)" == "${SOURCE_COMMIT}" &&
   -z "$(git -C "${ROOT_DIR}" status --porcelain)" ]] ||
  fail 'Zeppelin source changed during the build; no release was packaged'

if [[ "${SCOPE}" == *runtime ]]; then
  add_artifact zeppelin-interpreter "lib/zeppelin-interpreter-${VERSION}.jar"
  add_artifact zeppelin-interpreter-shaded "interpreter/zeppelin-interpreter-shaded-${VERSION}.jar"
fi
if [[ "${SCOPE}" == *core || "${SCOPE}" == *runtime ]]; then
  add_artifact zeppelin-zengine "lib/zeppelin-zengine-${VERSION}.jar"
  add_artifact zeppelin-server "lib/zeppelin-server-${VERSION}.jar"
fi

for index in "${!MODULES[@]}"; do
  target="${TARGETS[$index]}"
  source_file="${ROOT_DIR}/${MODULES[$index]}/target/${target##*/}"
  [[ -f "${source_file}" && -s "${source_file}" && ! -L "${source_file}" ]] ||
    fail "built artifact missing or empty: ${source_file}"
done

mkdir "${RELEASE_DIR}"
mkdir "${RELEASE_DIR}/artifacts"
cp -p "${SCRIPT_DIR}/deploy_zeppelin_release.sh" "${RELEASE_DIR}/deploy.sh"
manifest_tmp="${RELEASE_DIR}/manifest.tsv.tmp"
printf 'release\t%s\t%s\t%s\t%s\t%s\n' \
  "${RELEASE_ID}" "${CLUSTER}" "${SOURCE_COMMIT}" "${SCOPE}" "${VERSION}" > "${manifest_tmp}"

for index in "${!MODULES[@]}"; do
  target="${TARGETS[$index]}"
  source_file="${ROOT_DIR}/${MODULES[$index]}/target/${target##*/}"
  release_name="${target##*/}"
  if [[ "${release_name}" == *.war ]]; then
    release_name="${release_name%.war}-${RELEASE_ID}.war"
  fi
  cp -p "${source_file}" "${RELEASE_DIR}/artifacts/${release_name}"
  checksum="$(sha256_file "${RELEASE_DIR}/artifacts/${release_name}")"
  printf 'artifact\t%s\t%s\t%s\n' "${release_name}" "${target}" "${checksum}" >> "${manifest_tmp}"
done

mv "${manifest_tmp}" "${RELEASE_DIR}/manifest.tsv"
printf 'Prepared %s\nReview and commit only %s, then push the artifact repository.\n' \
  "${RELEASE_ID}" "${RELEASE_DIR}"
