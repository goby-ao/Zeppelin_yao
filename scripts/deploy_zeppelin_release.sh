#!/usr/bin/env bash
# Deploy exactly the files listed beside this script; keep the prior versions for rollback.
set -euo pipefail

MODE="${1:---dry-run}"
RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANIFEST="${RELEASE_DIR}/manifest.tsv"
ZEPPELIN_HOME="${ZEPPELIN_HOME:-}"
CLUSTER_NAME="${CLUSTER_NAME:-}"
FILES=()
TARGETS=()
CHECKSUMS=()
TEMP_FILES=()
EXPECTED_TARGETS=()

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail 'sha256sum or shasum is required'
  fi
}

cleanup() {
  local temp
  for temp in "${TEMP_FILES[@]:-}"; do
    [[ ! -f "${temp}" ]] || rm -f -- "${temp}"
  done
}
trap cleanup EXIT

[[ $# -le 1 ]] || fail 'usage: deploy.sh --dry-run|--apply|--rollback'
case "${MODE}" in
  --dry-run|--apply|--rollback) ;;
  *) fail 'usage: deploy.sh --dry-run|--apply|--rollback' ;;
esac
[[ -n "${ZEPPELIN_HOME}" && -d "${ZEPPELIN_HOME}" && ! -L "${ZEPPELIN_HOME}" ]] ||
  fail 'set ZEPPELIN_HOME to the real Zeppelin installation directory'
ZEPPELIN_HOME="$(cd "${ZEPPELIN_HOME}" && pwd -P)"
case "${CLUSTER_NAME}" in
  ns1|ns2|ns3) ;;
  *) fail 'set CLUSTER_NAME to ns1, ns2, or ns3' ;;
esac
[[ -f "${MANIFEST}" && ! -L "${MANIFEST}" ]] || fail "manifest not found: ${MANIFEST}"

IFS=$'\t' read -r record release_id release_cluster source_commit scope version < "${MANIFEST}"
[[ "${record}" == release && "${release_id}" == "${RELEASE_DIR##*/}" &&
   "${release_id}" =~ ^ns[123]-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$ ]] || fail 'invalid release ID'
[[ "${release_cluster}" == "${CLUSTER_NAME}" ]] || fail "release belongs to ${release_cluster}, not ${CLUSTER_NAME}"
[[ "${source_commit}" =~ ^[0-9a-f]{40}$ && "${version}" =~ ^[A-Za-z0-9._-]+$ ]] ||
  fail 'invalid source commit or version'
case "${scope}" in
  web|core|runtime|web+core|web+runtime) ;;
  *) fail "invalid release scope: ${scope}" ;;
esac
if [[ "${scope}" == web* ]]; then
  EXPECTED_TARGETS+=("zeppelin-web-${version}.war")
fi
if [[ "${scope}" == *runtime ]]; then
  EXPECTED_TARGETS+=("lib/zeppelin-interpreter-${version}.jar")
  EXPECTED_TARGETS+=("interpreter/zeppelin-interpreter-shaded-${version}.jar")
fi
if [[ "${scope}" == *core || "${scope}" == *runtime ]]; then
  EXPECTED_TARGETS+=("lib/zeppelin-zengine-${version}.jar")
  EXPECTED_TARGETS+=("lib/zeppelin-server-${version}.jar")
fi

while IFS=$'\t' read -r record filename target checksum extra; do
  [[ "${record}" == artifact && -z "${extra:-}" ]] || fail 'invalid manifest row'
  [[ "${filename}" =~ ^[A-Za-z0-9._-]+$ && "${checksum}" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'invalid artifact name or checksum'
  case "${target}" in
    "zeppelin-web-${version}.war"|\
    "lib/zeppelin-server-${version}.jar"|\
    "lib/zeppelin-zengine-${version}.jar"|\
    "lib/zeppelin-interpreter-${version}.jar"|\
    "interpreter/zeppelin-interpreter-shaded-${version}.jar") ;;
    *) fail "target is not an approved Zeppelin artifact: ${target}" ;;
  esac
  for existing in "${TARGETS[@]:-}"; do
    [[ "${existing}" != "${target}" ]] || fail "duplicate target: ${target}"
  done
  source_file="${RELEASE_DIR}/artifacts/${filename}"
  target_file="${ZEPPELIN_HOME}/${target}"
  [[ -f "${target_file}" && ! -L "${target_file}" && ! -L "$(dirname "${target_file}")" ]] ||
    fail "installed artifact is missing or a symlink: ${target_file}"
  if [[ "${MODE}" != --rollback ]]; then
    [[ -f "${source_file}" && ! -L "${source_file}" ]] || fail "release artifact missing: ${source_file}"
    [[ "$(sha256_file "${source_file}")" == "${checksum}" ]] || fail "checksum mismatch: ${source_file}"
  fi
  FILES+=("${source_file}")
  TARGETS+=("${target}")
  CHECKSUMS+=("${checksum}")
done < <(tail -n +2 "${MANIFEST}")
[[ -n "${TARGETS[*]:-}" && ${#TARGETS[@]} -eq ${#EXPECTED_TARGETS[@]} ]] ||
  fail 'manifest does not match release scope'
for index in "${!EXPECTED_TARGETS[@]}"; do
  [[ "${TARGETS[$index]}" == "${EXPECTED_TARGETS[$index]}" ]] || fail 'manifest artifact order or scope is invalid'
done

BACKUP_ROOT="${BACKUP_ROOT:-}"
[[ "${BACKUP_ROOT}" == /* ]] || fail 'set BACKUP_ROOT to an absolute directory outside ZEPPELIN_HOME'
[[ -d "${BACKUP_ROOT}" && ! -L "${BACKUP_ROOT}" ]] ||
  fail "BACKUP_ROOT must already exist and cannot be a symlink: ${BACKUP_ROOT}"
BACKUP_ROOT="$(cd "${BACKUP_ROOT}" && pwd -P)"
[[ "${BACKUP_ROOT}" != "${ZEPPELIN_HOME}" && "${BACKUP_ROOT}" != "${ZEPPELIN_HOME}/"* ]] ||
  fail 'BACKUP_ROOT must be outside ZEPPELIN_HOME'
BACKUP_DIR="${BACKUP_ROOT}/${release_id}"
printf 'Release: %s  Scope: %s  Cluster: %s  Source: %s\n' \
  "${release_id}" "${scope}" "${release_cluster}" "${source_commit}"
for index in "${!TARGETS[@]}"; do
  printf '  %s -> %s (SHA-256: %s)\n' \
    "${FILES[$index]##*/}" "${ZEPPELIN_HOME}/${TARGETS[$index]}" "${CHECKSUMS[$index]}"
done

if [[ "${MODE}" == --dry-run ]]; then
  if [[ -e "${BACKUP_DIR}" || -L "${BACKUP_DIR}" ]]; then
    fail "release already has a backup; use --rollback or choose a new release: ${BACKUP_DIR}"
  fi
  printf 'Dry-run complete; no files changed. Backup location on apply: %s\n' "${BACKUP_DIR}"
  exit 0
fi
[[ "${CONFIRM_STOPPED:-}" == 1 ]] || fail 'stop Zeppelin, then set CONFIRM_STOPPED=1'

stage_file() {
  local source="$1" target="$2" expected="$3" staged
  staged="$(mktemp "${target}.release.XXXXXX")"
  TEMP_FILES+=("${staged}")
  cp -p -- "${source}" "${staged}"
  [[ "$(sha256_file "${staged}")" == "${expected}" ]] || fail "staging checksum mismatch: ${target}"
  STAGED_FILE="${staged}"
}

if [[ "${MODE}" == --rollback ]]; then
  receipt="${BACKUP_DIR}/receipt.tsv"
  [[ -f "${receipt}" && ! -L "${receipt}" ]] || fail "rollback receipt missing: ${receipt}"
  old_checksums=()
  index=0
  while IFS=$'\t' read -r target old_checksum deployed_checksum extra; do
    [[ ${index} -lt ${#TARGETS[@]} && "${target}" == "${TARGETS[$index]}" &&
       "${deployed_checksum}" == "${CHECKSUMS[$index]}" &&
       "${old_checksum}" =~ ^[0-9a-f]{64}$ && -z "${extra:-}" ]] || fail 'rollback receipt does not match release'
    backup_file="${BACKUP_DIR}/${target}"
    [[ -f "${backup_file}" && ! -L "${backup_file}" ]] || fail "backup missing: ${backup_file}"
    [[ "$(sha256_file "${backup_file}")" == "${old_checksum}" ]] || fail "backup changed: ${backup_file}"
    current_checksum="$(sha256_file "${ZEPPELIN_HOME}/${target}")"
    [[ "${current_checksum}" == "${deployed_checksum}" || "${current_checksum}" == "${old_checksum}" ]] ||
      fail "installed artifact has changed since deployment: ${target}"
    old_checksums+=("${old_checksum}")
    index=$((index + 1))
  done < "${receipt}"
  [[ ${index} -eq ${#TARGETS[@]} ]] || fail 'incomplete rollback receipt'

  staged_files=()
  for index in "${!TARGETS[@]}"; do
    stage_file "${BACKUP_DIR}/${TARGETS[$index]}" \
      "${ZEPPELIN_HOME}/${TARGETS[$index]}" "${old_checksums[$index]}"
    staged_files+=("${STAGED_FILE}")
  done
  rollback_interrupted() {
    trap - ERR INT TERM
    printf 'Rollback interrupted; keep Zeppelin stopped and rerun this rollback.\n' >&2
    exit 1
  }
  trap rollback_interrupted ERR INT TERM
  for index in "${!TARGETS[@]}"; do
    mv -f -- "${staged_files[$index]}" "${ZEPPELIN_HOME}/${TARGETS[$index]}"
  done
  printf 'rolled-back\n' > "${BACKUP_DIR}/state"
  trap - ERR INT TERM
  printf 'Rollback complete; restart Zeppelin.\n'
  exit 0
fi

[[ ! -e "${BACKUP_DIR}" && ! -L "${BACKUP_DIR}" ]] ||
  fail "backup already exists; refusing to deploy the same release twice: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"
cp -p -- "${MANIFEST}" "${BACKUP_DIR}/manifest.tsv"
receipt_tmp="${BACKUP_DIR}/receipt.tsv.tmp"
: > "${receipt_tmp}"
for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  target_file="${ZEPPELIN_HOME}/${target}"
  backup_file="${BACKUP_DIR}/${target}"
  mkdir -p "$(dirname "${backup_file}")"
  cp -p -- "${target_file}" "${backup_file}"
  cmp -s -- "${target_file}" "${backup_file}" || fail "backup verification failed: ${target}"
  printf '%s\t%s\t%s\n' "${target}" "$(sha256_file "${backup_file}")" \
    "${CHECKSUMS[$index]}" >> "${receipt_tmp}"
done
mv "${receipt_tmp}" "${BACKUP_DIR}/receipt.tsv"

staged_files=()
for index in "${!TARGETS[@]}"; do
  stage_file "${FILES[$index]}" \
    "${ZEPPELIN_HOME}/${TARGETS[$index]}" "${CHECKSUMS[$index]}"
  staged_files+=("${STAGED_FILE}")
done

recover_partial_deploy() {
  trap - ERR INT TERM
  set +e
  printf 'Deployment interrupted; restoring backed-up artifacts.\n' >&2
  local restore_tmp index
  for index in "${!TARGETS[@]}"; do
    restore_tmp=""
    if restore_tmp="$(mktemp "${ZEPPELIN_HOME}/${TARGETS[$index]}.release.XXXXXX")"; then
      TEMP_FILES+=("${restore_tmp}")
      if cp -p -- "${BACKUP_DIR}/${TARGETS[$index]}" "${restore_tmp}" &&
         cmp -s -- "${BACKUP_DIR}/${TARGETS[$index]}" "${restore_tmp}" &&
         mv -f -- "${restore_tmp}" "${ZEPPELIN_HOME}/${TARGETS[$index]}"; then
        continue
      fi
    fi
    printf 'Restore failed: %s\n' "${TARGETS[$index]}" >&2
  done
  printf 'Check %s before restarting Zeppelin.\n' "${BACKUP_DIR}" >&2
  exit 1
}
trap recover_partial_deploy ERR INT TERM
for index in "${!TARGETS[@]}"; do
  mv -f -- "${staged_files[$index]}" "${ZEPPELIN_HOME}/${TARGETS[$index]}"
  [[ "$(sha256_file "${ZEPPELIN_HOME}/${TARGETS[$index]}")" == "${CHECKSUMS[$index]}" ]]
done
printf 'applied\n' > "${BACKUP_DIR}/state"
trap - ERR INT TERM
printf 'Deployment complete; backup at %s. Restart Zeppelin.\n' "${BACKUP_DIR}"
