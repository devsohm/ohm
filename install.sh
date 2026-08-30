#!/bin/sh
set -eu

umask 077

ohm_fail() {
  printf 'ohm install: %s\n' "$*" >&2
  exit 1
}

for ohm_command in curl tar mktemp uname mkdir mv ln chmod grep awk cmp cp readlink rm rmdir sleep wc ls; do
  command -v "$ohm_command" >/dev/null 2>&1 || ohm_fail "$ohm_command is required"
done

ohm_release_root=https://github.com/devsohm/ohm/releases
if ! ohm_latest_url=$(curl \
  --proto '=https' \
  --proto-redir '=https' \
  --location \
  --fail \
  --silent \
  --show-error \
  --connect-timeout 15 \
  --max-time 300 \
  --max-filesize 1048576 \
  --retry 2 \
  --output /dev/null \
  --write-out '%{url_effective}' \
  "$ohm_release_root/latest"
); then
  ohm_fail "could not resolve the latest GitHub release"
fi
ohm_latest_url=${ohm_latest_url%/}
case "$ohm_latest_url" in
  "$ohm_release_root/tag/"*) ohm_tag=${ohm_latest_url##*/} ;;
  *) ohm_fail "GitHub returned an unexpected latest-release URL" ;;
esac
printf '%s\n' "$ohm_tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
  || ohm_fail "GitHub returned an invalid release tag"
ohm_version=${ohm_tag#v}

case "$(uname -s)" in
  Linux) ohm_platform=linux ;;
  Darwin) ohm_platform=darwin ;;
  *) ohm_fail "standalone releases support Linux and macOS; use install.ps1 on Windows" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ohm_arch=x64 ;;
  arm64|aarch64) ohm_arch=arm64 ;;
  *) ohm_fail "standalone releases support x64 and arm64" ;;
esac

ohm_tmp_base=${TMPDIR:-/tmp}
[ -d "$ohm_tmp_base" ] || ohm_fail "temporary directory does not exist: $ohm_tmp_base"
ohm_tmp=$(mktemp -d "$ohm_tmp_base/ohm-install.XXXXXX") || ohm_fail "could not create a private temporary directory"
ohm_transaction_committed=0
ohm_runtime_commit_started=0
ohm_runtime_restore_failed=0
ohm_launcher_commit_started=0
ohm_launcher_had_previous=0
ohm_launcher_restore_failed=0
ohm_command_commit_started=0
ohm_command_had_previous=0
ohm_command_restore_failed=0
ohm_created_agents=0
ohm_created_settings=0
ohm_runtime_transaction_active=0
ohm_runtime_transaction_record=
ohm_runtime_transaction_record_temp=
ohm_lifecycle_lock=
ohm_lifecycle_owner=
ohm_lifecycle_lock_acquired=0
ohm_cleanup() {
  if [ "$ohm_transaction_committed" -ne 1 ]; then
    if [ "$ohm_command_commit_started" -eq 1 ] && [ -n "${ohm_command:-}" ]; then
      if [ "$ohm_command_had_previous" -eq 1 ] \
        && { [ -e "${ohm_command_backup:-}" ] || [ -L "${ohm_command_backup:-}" ]; }; then
        rm -f -- "$ohm_command" 2>/dev/null || :
        if ! mv "$ohm_command_backup" "$ohm_command" 2>/dev/null; then
          ohm_command_restore_failed=1
          printf 'ohm install: warning: could not restore the previous ohm command; backup preserved at %s\n' \
            "$ohm_command_backup" >&2
        fi
      elif [ -L "$ohm_command" ] && [ "$(readlink "$ohm_command" 2>/dev/null || :)" = "${ohm_launcher:-}" ]; then
        rm -f -- "$ohm_command" 2>/dev/null || :
      fi
    fi
    if [ "$ohm_launcher_commit_started" -eq 1 ] && [ -n "${ohm_launcher:-}" ]; then
      if [ "$ohm_launcher_had_previous" -eq 1 ] \
        && { [ -e "${ohm_launcher_backup:-}" ] || [ -L "${ohm_launcher_backup:-}" ]; }; then
        rm -f -- "$ohm_launcher" 2>/dev/null || :
        if ! mv "$ohm_launcher_backup" "$ohm_launcher" 2>/dev/null; then
          ohm_launcher_restore_failed=1
          printf 'ohm install: warning: could not restore the previous ohm launcher; backup preserved at %s\n' \
            "$ohm_launcher_backup" >&2
        fi
      elif [ -L "$ohm_launcher" ] && [ "$(readlink "$ohm_launcher" 2>/dev/null || :)" = "${ohm_target:-}/bin/ohm" ]; then
        rm -f -- "$ohm_launcher" 2>/dev/null || :
      fi
    fi
    if [ "$ohm_created_agents" -eq 1 ]; then
      rm -f -- "${ohm_home:-}/AGENTS.md" 2>/dev/null || :
    fi
    if [ "$ohm_created_settings" -eq 1 ]; then
      rm -f -- "${ohm_home:-}/config.json" 2>/dev/null || :
    fi
    if [ "$ohm_runtime_commit_started" -eq 1 ] && [ -n "${ohm_target:-}" ]; then
      if [ -d "$ohm_target" ] && [ ! -L "$ohm_target" ]; then
        rm -rf -- "$ohm_target" 2>/dev/null || :
      fi
      if [ -d "${ohm_backup:-}" ] && [ ! -e "$ohm_target" ] && [ ! -L "$ohm_target" ]; then
        if ! mv "$ohm_backup" "$ohm_target" 2>/dev/null; then
          ohm_runtime_restore_failed=1
          printf 'ohm install: warning: could not restore the previous standalone runtime; backup preserved at %s\n' \
            "$ohm_backup" >&2
        fi
      fi
    fi
    if [ "$ohm_runtime_transaction_active" -eq 1 ] \
      && [ "$ohm_runtime_restore_failed" -ne 1 ] \
      && [ -n "${ohm_runtime_transaction_record:-}" ]; then
      rm -f -- "$ohm_runtime_transaction_record" 2>/dev/null || :
      ohm_runtime_transaction_active=0
    fi
  fi
  if [ -n "${ohm_runtime_transaction_record_temp:-}" ] \
    && [ -n "${ohm_runtime_root:-}" ]; then
    case "$ohm_runtime_transaction_record_temp" in
      "$ohm_runtime_root"/.ohm-install-record.*)
        rm -f -- "$ohm_runtime_transaction_record_temp" 2>/dev/null || :
        ;;
    esac
  fi
  if [ -n "${ohm_stage_parent:-}" ] && [ -n "${ohm_runtime_root:-}" ]; then
    case "$ohm_stage_parent" in
      "$ohm_runtime_root"/.ohm-stage.*)
        [ ! -d "$ohm_stage_parent" ] || [ -L "$ohm_stage_parent" ] || rm -rf -- "$ohm_stage_parent"
        ;;
    esac
  fi
  if [ -n "${ohm_backup_parent:-}" ] && [ -n "${ohm_runtime_root:-}" ]; then
    case "$ohm_backup_parent" in
      "$ohm_runtime_root"/.ohm-backup.*)
        if [ "$ohm_runtime_restore_failed" -ne 1 ] \
          && { [ "$ohm_transaction_committed" -eq 1 ] || [ ! -d "${ohm_backup:-}" ]; }; then
          [ ! -d "$ohm_backup_parent" ] || [ -L "$ohm_backup_parent" ] || rm -rf -- "$ohm_backup_parent"
        fi
        ;;
    esac
  fi
  if [ -n "${ohm_link_stage:-}" ] && [ -n "${ohm_launcher_dir:-}" ]; then
    case "$ohm_link_stage" in
      "$ohm_launcher_dir"/.ohm-link.*)
        if [ "$ohm_launcher_restore_failed" -ne 1 ]; then
          [ ! -d "$ohm_link_stage" ] || [ -L "$ohm_link_stage" ] || rm -rf -- "$ohm_link_stage"
        fi
        ;;
    esac
  fi
  if [ -n "${ohm_command_stage:-}" ] && [ -n "${ohm_command_dir:-}" ]; then
    case "$ohm_command_stage" in
      "$ohm_command_dir"/.ohm-command.*)
        if [ "$ohm_command_restore_failed" -ne 1 ]; then
          [ ! -d "$ohm_command_stage" ] || [ -L "$ohm_command_stage" ] || rm -rf -- "$ohm_command_stage"
        fi
        ;;
      esac
  fi
  if [ "$ohm_lifecycle_lock_acquired" -eq 1 ] \
    && [ -f "$ohm_lifecycle_lock" ] \
    && [ ! -L "$ohm_lifecycle_lock" ] \
    && [ -f "$ohm_lifecycle_owner" ] \
    && cmp -s "$ohm_lifecycle_owner" "$ohm_lifecycle_lock"; then
    rm -f -- "$ohm_lifecycle_lock" 2>/dev/null || :
    ohm_lifecycle_lock_acquired=0
  fi
  case "${ohm_tmp:-}" in
    "$ohm_tmp_base"/ohm-install.*)
      [ ! -d "$ohm_tmp" ] || rm -rf -- "$ohm_tmp"
      ;;
  esac
}
trap ohm_cleanup 0
trap 'exit 1' HUP INT TERM

ohm_download() {
  ohm_url=$1
  ohm_destination=$2
  ohm_limit=$3
  curl \
    --proto '=https' \
    --proto-redir '=https' \
    --location \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 15 \
    --max-time 300 \
    --max-filesize "$ohm_limit" \
    --retry 2 \
    --output "$ohm_destination" \
    "$ohm_url"
}

ohm_validate_scaffold_destination() {
  ohm_scaffold_path=$1
  ohm_scaffold_label=$2
  if [ -e "$ohm_scaffold_path" ] || [ -L "$ohm_scaffold_path" ]; then
    [ -f "$ohm_scaffold_path" ] && [ ! -L "$ohm_scaffold_path" ] \
      || ohm_fail "$ohm_scaffold_label must be a regular file: $ohm_scaffold_path"
  fi
}

ohm_json_string() {
  awk '
    BEGIN { ORS = ""; printf "\"" }
    {
      if (NR > 1) printf "\\n"
      for (position = 1; position <= length($0); position += 1) {
        character = substr($0, position, 1)
        if (character == "\\") printf "\\\\"
        else if (character == "\"") printf "\\\""
        else if (character == "\t") printf "\\t"
        else if (character == "\r") printf "\\r"
        else printf "%s", character
      }
    }
    END { print "\"" }
  '
}

ohm_record_field() {
  ohm_record_path=$1
  ohm_record_name=$2
  awk -v name="$ohm_record_name" '
    {
      marker = "\"" name "\":\""
      start = index($0, marker)
      if (start == 0) exit 1
      value = substr($0, start + length(marker))
      finish = index(value, "\"")
      if (finish == 0) exit 1
      print substr(value, 1, finish - 1)
      exit
    }
  ' "$ohm_record_path"
}

ohm_validate_recoverable_standalone_root() {
  ohm_recovery_root=$1
  ohm_recovery_runtime=$2
  [ -d "$ohm_recovery_root" ] && [ ! -L "$ohm_recovery_root" ] \
    || ohm_fail "interrupted standalone uninstall root is unsafe: $ohm_recovery_root"
  [ ! -e "$ohm_recovery_root/.installation.json" ] \
    && [ ! -L "$ohm_recovery_root/.installation.json" ] \
    || ohm_fail "interrupted standalone uninstall belongs to a source-built installation"
  ohm_recovery_runtime_root="$ohm_recovery_root/runtime"
  ohm_recovery_target="$ohm_recovery_runtime_root/$ohm_recovery_runtime"
  [ -d "$ohm_recovery_runtime_root" ] && [ ! -L "$ohm_recovery_runtime_root" ] \
    && [ -d "$ohm_recovery_target" ] && [ ! -L "$ohm_recovery_target" ] \
    || ohm_fail "interrupted standalone uninstall runtime is unsafe: $ohm_recovery_target"
  ohm_recovery_metadata="$ohm_recovery_target/BUILD-METADATA.json"
  [ -f "$ohm_recovery_metadata" ] && [ ! -L "$ohm_recovery_metadata" ] \
    || ohm_fail "interrupted standalone uninstall metadata is unsafe: $ohm_recovery_metadata"
  ohm_recovery_metadata_size=$(wc -c < "$ohm_recovery_metadata") \
    || ohm_fail "could not inspect interrupted standalone uninstall metadata"
  [ "$ohm_recovery_metadata_size" -le 65536 ] \
    || ohm_fail "interrupted standalone uninstall metadata is unsafe: $ohm_recovery_metadata"
  ohm_recovery_version=${ohm_recovery_runtime#ohm-v}
  ohm_recovery_version=${ohm_recovery_version%-$ohm_platform-$ohm_arch}
  grep -Eq '"product"[[:space:]]*:[[:space:]]*"ohm"' "$ohm_recovery_metadata" \
    && grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$ohm_recovery_version"'"' "$ohm_recovery_metadata" \
    && grep -Eq '"platform"[[:space:]]*:[[:space:]]*"'"$ohm_platform"'"' "$ohm_recovery_metadata" \
    && grep -Eq '"arch"[[:space:]]*:[[:space:]]*"'"$ohm_arch"'"' "$ohm_recovery_metadata" \
    || ohm_fail "interrupted standalone uninstall metadata does not identify this installation"
  ohm_recovery_runtime_launcher="$ohm_recovery_target/bin/ohm"
  ohm_recovery_launcher="$ohm_recovery_root/bin/ohm"
  [ -f "$ohm_recovery_runtime_launcher" ] && [ ! -L "$ohm_recovery_runtime_launcher" ] \
    && [ -L "$ohm_recovery_launcher" ] \
    && [ "$(readlink "$ohm_recovery_launcher")" = "$ohm_install_root/runtime/$ohm_recovery_runtime/bin/ohm" ] \
    || ohm_fail "interrupted standalone uninstall launcher ownership check failed"
}

ohm_recover_interrupted_standalone_uninstall() {
  ohm_uninstall_record="$ohm_install_root.uninstall.json"
  ohm_uninstall_tombstone="$ohm_install_root.uninstalling"
  if [ ! -e "$ohm_uninstall_record" ] && [ ! -L "$ohm_uninstall_record" ]; then
    [ ! -e "$ohm_uninstall_tombstone" ] && [ ! -L "$ohm_uninstall_tombstone" ] \
      || ohm_fail "standalone uninstall tombstone exists without its recovery record: $ohm_uninstall_tombstone"
    return
  fi
  [ -f "$ohm_uninstall_record" ] && [ ! -L "$ohm_uninstall_record" ] \
    || ohm_fail "standalone uninstall transaction is unsafe: $ohm_uninstall_record"
  ohm_uninstall_record_size=$(wc -c < "$ohm_uninstall_record") \
    || ohm_fail "could not inspect standalone uninstall transaction"
  [ "$ohm_uninstall_record_size" -le 16384 ] \
    && [ "$(awk 'END { print NR }' "$ohm_uninstall_record")" -eq 1 ] \
    && grep -Eq '^\{"product":"ohm","schemaVersion":1,"distribution":"standalone","phase":"(prepared|isolated|command-removed)","runtime":"ohm-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)"\}$' "$ohm_uninstall_record" \
    || ohm_fail "standalone uninstall transaction is invalid: $ohm_uninstall_record"
  ohm_uninstall_runtime=$(ohm_record_field "$ohm_uninstall_record" runtime) \
    || ohm_fail "standalone uninstall transaction is invalid: $ohm_uninstall_record"
  case "$ohm_uninstall_runtime" in
    *-$ohm_platform-$ohm_arch) ;;
    *) ohm_fail "standalone uninstall transaction targets another platform" ;;
  esac
  if { [ -e "$ohm_install_root" ] || [ -L "$ohm_install_root" ]; } \
    && { [ -e "$ohm_uninstall_tombstone" ] || [ -L "$ohm_uninstall_tombstone" ]; }; then
    ohm_fail "interrupted standalone uninstall has both active and tombstone roots"
  fi
  if [ -e "$ohm_uninstall_tombstone" ] || [ -L "$ohm_uninstall_tombstone" ]; then
    ohm_validate_recoverable_standalone_root "$ohm_uninstall_tombstone" "$ohm_uninstall_runtime"
    mv "$ohm_uninstall_tombstone" "$ohm_install_root" \
      || ohm_fail "could not restore the interrupted standalone uninstall"
  elif [ -e "$ohm_install_root" ] || [ -L "$ohm_install_root" ]; then
    ohm_validate_recoverable_standalone_root "$ohm_install_root" "$ohm_uninstall_runtime"
  fi
  rm -f -- "$ohm_uninstall_record" \
    || ohm_fail "could not finish standalone uninstall recovery"
}

ohm_lock_pid() {
  awk '
    match($0, /"pid":[0-9]+/) {
      value = substr($0, RSTART, RLENGTH)
      sub(/^"pid":/, "", value)
      print value
      exit
    }
  ' "$1"
}

ohm_acquire_lifecycle_lock() {
  ohm_lock_attempt=0
  ohm_invalid_lock_snapshot="$ohm_tmp/lifecycle-lock.invalid.snapshot"
  while [ "$ohm_lock_attempt" -lt 30 ]; do
    if (set -C; printf '%s\n' "$ohm_lifecycle_contents" > "$ohm_lifecycle_lock") 2>/dev/null; then
      ohm_lifecycle_lock_acquired=1
      chmod 600 "$ohm_lifecycle_lock" \
        || ohm_fail "could not secure the standalone lifecycle lock"
      return
    fi

    ohm_lock_snapshot="$ohm_tmp/lifecycle-lock.snapshot"
    if [ -f "$ohm_lifecycle_lock" ] \
      && [ ! -L "$ohm_lifecycle_lock" ] \
      && cp "$ohm_lifecycle_lock" "$ohm_lock_snapshot" 2>/dev/null; then
      ohm_existing_pid=$(ohm_lock_pid "$ohm_lock_snapshot")
      case "$ohm_existing_pid" in
        ''|*[!0-9]*) ohm_existing_pid= ;;
      esac
      if [ -n "$ohm_existing_pid" ] && ! kill -0 "$ohm_existing_pid" 2>/dev/null; then
        rm -f -- "$ohm_invalid_lock_snapshot"
        ohm_lock_quarantine="$ohm_lifecycle_lock.stale.$$.$ohm_lock_attempt"
        if mv "$ohm_lifecycle_lock" "$ohm_lock_quarantine" 2>/dev/null; then
          if cmp -s "$ohm_lock_snapshot" "$ohm_lock_quarantine"; then
            rm -f -- "$ohm_lock_quarantine"
            continue
          fi
          if [ ! -e "$ohm_lifecycle_lock" ] && [ ! -L "$ohm_lifecycle_lock" ]; then
            mv "$ohm_lock_quarantine" "$ohm_lifecycle_lock" 2>/dev/null || :
          fi
        fi
      elif [ -z "$ohm_existing_pid" ]; then
        if [ -f "$ohm_invalid_lock_snapshot" ] \
          && cmp -s "$ohm_invalid_lock_snapshot" "$ohm_lock_snapshot"; then
          ohm_lock_quarantine="$ohm_lifecycle_lock.stale.$$.$ohm_lock_attempt"
          if mv "$ohm_lifecycle_lock" "$ohm_lock_quarantine" 2>/dev/null; then
            if cmp -s "$ohm_lock_snapshot" "$ohm_lock_quarantine"; then
              rm -f -- "$ohm_lock_quarantine" "$ohm_invalid_lock_snapshot"
              continue
            fi
            if [ ! -e "$ohm_lifecycle_lock" ] && [ ! -L "$ohm_lifecycle_lock" ]; then
              mv "$ohm_lock_quarantine" "$ohm_lifecycle_lock" 2>/dev/null || :
            fi
          fi
        else
          cp "$ohm_lock_snapshot" "$ohm_invalid_lock_snapshot" 2>/dev/null || :
        fi
      else
        rm -f -- "$ohm_invalid_lock_snapshot"
      fi
    else
      rm -f -- "$ohm_invalid_lock_snapshot"
    fi
    ohm_lock_attempt=$((ohm_lock_attempt + 1))
    sleep 1
  done
  ohm_fail "timed out waiting for another ohm lifecycle operation at $ohm_install_root"
}

ohm_asset_root="$ohm_release_root/download/$ohm_tag"
ohm_checksums="$ohm_tmp/SHA256SUMS"
ohm_archive="ohm-v$ohm_version-$ohm_platform-$ohm_arch.tar.gz"
ohm_archive_path="$ohm_tmp/$ohm_archive"
ohm_download "$ohm_asset_root/SHA256SUMS" "$ohm_checksums" 1048576 \
  || ohm_fail "could not download SHA256SUMS"
ohm_download "$ohm_asset_root/$ohm_archive" "$ohm_archive_path" 1073741824 \
  || ohm_fail "could not download $ohm_archive"

ohm_expected=$(
  awk -v name="$ohm_archive" '
    $2 == name {
      count += 1
      value = $1
    }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "$ohm_checksums"
) || ohm_fail "SHA256SUMS must list $ohm_archive exactly once"
printf '%s\n' "$ohm_expected" | grep -Eq '^[a-f0-9]{64}$' \
  || ohm_fail "SHA256SUMS contains an invalid digest for $ohm_archive"

if command -v sha256sum >/dev/null 2>&1; then
  ohm_hash_tool=sha256sum
  ohm_actual=$(sha256sum "$ohm_archive_path" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  ohm_hash_tool=shasum
  ohm_actual=$(shasum -a 256 "$ohm_archive_path" | awk '{ print $1 }')
elif command -v openssl >/dev/null 2>&1; then
  ohm_hash_tool=openssl
  ohm_actual=$(openssl dgst -sha256 "$ohm_archive_path" | awk '{ print $NF }')
else
  ohm_fail "sha256sum, shasum, or openssl is required to verify the release"
fi
[ "$ohm_actual" = "$ohm_expected" ] || ohm_fail "checksum mismatch for $ohm_archive"

ohm_archive_root=${ohm_archive%.tar.gz}
ohm_listing="$ohm_tmp/archive.list"
ohm_verbose_listing="$ohm_tmp/archive.verbose.list"
tar -tzf "$ohm_archive_path" > "$ohm_listing" \
  || ohm_fail "$ohm_archive is not a readable tar.gz archive"
tar -tvzf "$ohm_archive_path" > "$ohm_verbose_listing" \
  || ohm_fail "$ohm_archive metadata could not be inspected"
while IFS= read -r ohm_entry_metadata; do
  case "$ohm_entry_metadata" in
    -*|d*) ;;
    *) ohm_fail "$ohm_archive contains an unsupported entry type" ;;
  esac
done < "$ohm_verbose_listing"
while IFS= read -r ohm_entry; do
  [ -n "$ohm_entry" ] || ohm_fail "$ohm_archive contains an empty path"
  case "$ohm_entry" in
    "$ohm_archive_root"|"$ohm_archive_root/"|"$ohm_archive_root/"*) ;;
    *) ohm_fail "$ohm_archive contains a path outside its release root" ;;
  esac
  case "$ohm_entry" in
    */../*|*/..|../*|*/./*|*/.|./*|*//*)
      ohm_fail "$ohm_archive contains an unsafe path"
      ;;
  esac
done < "$ohm_listing"

ohm_extract="$ohm_tmp/extract"
mkdir -m 700 "$ohm_extract"
tar -xzf "$ohm_archive_path" -C "$ohm_extract" \
  || ohm_fail "could not extract $ohm_archive"
ohm_payload="$ohm_extract/$ohm_archive_root"
[ -d "$ohm_payload" ] && [ ! -L "$ohm_payload" ] \
  || ohm_fail "$ohm_archive is missing its release root"
for ohm_required in bin/ohm BUILD-METADATA.json lib/node_modules/ohm/resources/AGENTS.md lib/node_modules/ohm/resources/config.example.json; do
  [ -f "$ohm_payload/$ohm_required" ] && [ ! -L "$ohm_payload/$ohm_required" ] \
    || ohm_fail "$ohm_archive is missing $ohm_required"
done

ohm_install_root="$HOME/.ohm"
ohm_lifecycle_lock="$ohm_install_root.lifecycle.lock"
ohm_lock_seed="$ohm_tmp/lifecycle-lock.seed"
ohm_lifecycle_owner="$ohm_tmp/lifecycle-lock.owner"
printf '%s\n%s\n%s\n' "$$" "$ohm_tmp" "$ohm_expected" > "$ohm_lock_seed"
case "$ohm_hash_tool" in
  sha256sum) ohm_lock_digest=$(sha256sum "$ohm_lock_seed" | awk '{ print $1 }') ;;
  shasum) ohm_lock_digest=$(shasum -a 256 "$ohm_lock_seed" | awk '{ print $1 }') ;;
  openssl) ohm_lock_digest=$(openssl dgst -sha256 "$ohm_lock_seed" | awk '{ print $NF }') ;;
esac
ohm_lock_token=$(printf '%s\n' "$ohm_lock_digest" | awk '{ print substr($0, 1, 32) }')
ohm_lock_root=$(printf '%s\n' "$ohm_install_root" | ohm_json_string)
ohm_lifecycle_contents=$(printf \
  '{"schemaVersion":1,"pid":%s,"token":"%s","createdAt":0,"installRoot":%s}' \
  "$$" "$ohm_lock_token" "$ohm_lock_root")
printf '%s\n' "$ohm_lifecycle_contents" > "$ohm_lifecycle_owner"
ohm_acquire_lifecycle_lock
ohm_recover_interrupted_standalone_uninstall

mkdir -p -m 700 "$ohm_install_root"
[ -d "$ohm_install_root" ] && [ ! -L "$ohm_install_root" ] \
  || ohm_fail "standalone installation root is not a safe directory: $ohm_install_root"
for ohm_source_owned_path in \
  .installation.json \
  .install-transaction.json \
  .app-install \
  .build-install \
  .app-previous \
  app
do
  if [ -e "$ohm_install_root/$ohm_source_owned_path" ] \
    || [ -L "$ohm_install_root/$ohm_source_owned_path" ]; then
    ohm_fail "a source-built installation owns $ohm_install_root; preserve ~/.ohm and follow the state-preserving transition docs before changing installation methods"
  fi
done

ohm_runtime_leases="$ohm_install_root/.runtime-leases"
if [ -e "$ohm_runtime_leases" ] || [ -L "$ohm_runtime_leases" ]; then
  [ -d "$ohm_runtime_leases" ] && [ ! -L "$ohm_runtime_leases" ] \
    || ohm_fail "standalone runtime lease path is unsafe: $ohm_runtime_leases"
  ohm_runtime_lease_entries=$(LC_ALL=C ls -A "$ohm_runtime_leases") \
    || ohm_fail "could not inspect standalone runtime leases"
  if [ -n "$ohm_runtime_lease_entries" ]; then
    while IFS= read -r ohm_runtime_lease_entry; do
      printf '%s\n' "$ohm_runtime_lease_entry" | grep -Eq '^[a-f0-9]{32}\.json$' \
        || ohm_fail "standalone runtime lease entry is unsafe: $ohm_runtime_lease_entry"
      ohm_runtime_lease_path="$ohm_runtime_leases/$ohm_runtime_lease_entry"
      [ -f "$ohm_runtime_lease_path" ] && [ ! -L "$ohm_runtime_lease_path" ] \
        || ohm_fail "standalone runtime lease entry is unsafe: $ohm_runtime_lease_entry"
      ohm_runtime_lease_size=$(wc -c < "$ohm_runtime_lease_path") \
        || ohm_fail "could not inspect standalone runtime lease: $ohm_runtime_lease_entry"
      [ "$ohm_runtime_lease_size" -le 16384 ] \
        || ohm_fail "standalone runtime lease entry is unsafe: $ohm_runtime_lease_entry"
      ohm_runtime_lease_snapshot="$ohm_tmp/runtime-lease.$ohm_runtime_lease_entry"
      cp "$ohm_runtime_lease_path" "$ohm_runtime_lease_snapshot" \
        || ohm_fail "could not inspect standalone runtime lease: $ohm_runtime_lease_entry"
      [ "$(awk 'END { print NR }' "$ohm_runtime_lease_snapshot")" -eq 1 ] \
        && grep -Eq '^\{"schemaVersion":1,"pid":[1-9][0-9]*,"lease":"[a-f0-9]{32}","createdAt":[0-9]+,"installationId":"[a-f0-9]{32}"\}$' "$ohm_runtime_lease_snapshot" \
        || ohm_fail "standalone runtime lease entry is invalid: $ohm_runtime_lease_entry"
      ohm_runtime_lease_pid=$(ohm_lock_pid "$ohm_runtime_lease_snapshot")
      ohm_runtime_lease_name=$(awk '
        match($0, /"lease":"[a-f0-9]+"/) {
          value = substr($0, RSTART, RLENGTH)
          sub(/^"lease":"/, "", value)
          sub(/"$/, "", value)
          print value
          exit
        }
      ' "$ohm_runtime_lease_snapshot")
      [ "$ohm_runtime_lease_entry" = "$ohm_runtime_lease_name.json" ] \
        || ohm_fail "standalone runtime lease entry is invalid: $ohm_runtime_lease_entry"
      if kill -0 "$ohm_runtime_lease_pid" 2>/dev/null; then
        ohm_fail "close every running ohm process before updating the standalone installation"
      fi
      cmp -s "$ohm_runtime_lease_snapshot" "$ohm_runtime_lease_path" \
        || ohm_fail "standalone runtime lease changed while the installation was being updated"
      rm -f -- "$ohm_runtime_lease_path" \
        || ohm_fail "could not remove stale standalone runtime lease: $ohm_runtime_lease_entry"
    done <<EOF
$ohm_runtime_lease_entries
EOF
  fi
fi

ohm_runtime_root="$ohm_install_root/runtime"
ohm_target="$ohm_runtime_root/$ohm_archive_root"
mkdir -p -m 700 "$ohm_runtime_root"
[ -d "$ohm_runtime_root" ] && [ ! -L "$ohm_runtime_root" ] \
  || ohm_fail "standalone runtime root is not a safe directory: $ohm_runtime_root"

ohm_runtime_transaction_record="$ohm_runtime_root/.ohm-install-transaction.json"

ohm_write_runtime_transaction() {
  ohm_runtime_transaction_phase=$1
  ohm_runtime_transaction_runtime=$2
  ohm_runtime_transaction_stage=$3
  ohm_runtime_transaction_backup=$4
  ohm_runtime_transaction_previous=$5
  ohm_runtime_transaction_record_temp=$(mktemp "$ohm_runtime_root/.ohm-install-record.XXXXXX") \
    || ohm_fail "could not stage the standalone runtime transaction"
  printf '{"product":"ohm","schemaVersion":1,"distribution":"standalone","phase":"%s","runtime":"%s","stage":"%s","backup":%s,"hadPrevious":%s}\n' \
    "$ohm_runtime_transaction_phase" \
    "$ohm_runtime_transaction_runtime" \
    "$ohm_runtime_transaction_stage" \
    "$ohm_runtime_transaction_backup" \
    "$ohm_runtime_transaction_previous" > "$ohm_runtime_transaction_record_temp" \
    || ohm_fail "could not write the standalone runtime transaction"
  chmod 600 "$ohm_runtime_transaction_record_temp" \
    || ohm_fail "could not secure the standalone runtime transaction"
  mv -f "$ohm_runtime_transaction_record_temp" "$ohm_runtime_transaction_record" \
    || ohm_fail "could not publish the standalone runtime transaction"
  ohm_runtime_transaction_record_temp=
  if [ "$ohm_runtime_transaction_phase" = committed ]; then
    ohm_transaction_committed=1
  fi
  ohm_runtime_transaction_active=1
}

ohm_remove_recovery_tree() {
  ohm_recovery_tree=$1
  ohm_recovery_prefix=$2
  case "$ohm_recovery_tree" in
    "$ohm_runtime_root"/"$ohm_recovery_prefix".*) ;;
    *) ohm_fail "standalone runtime transaction path is unsafe: $ohm_recovery_tree" ;;
  esac
  if [ -e "$ohm_recovery_tree" ] || [ -L "$ohm_recovery_tree" ]; then
    [ -d "$ohm_recovery_tree" ] && [ ! -L "$ohm_recovery_tree" ] \
      || ohm_fail "standalone runtime transaction path is unsafe: $ohm_recovery_tree"
    rm -rf -- "$ohm_recovery_tree" \
      || ohm_fail "could not remove standalone runtime transaction residue: $ohm_recovery_tree"
  fi
}

ohm_recover_runtime_transaction() {
  if [ ! -e "$ohm_runtime_transaction_record" ] && [ ! -L "$ohm_runtime_transaction_record" ]; then
    return
  fi
  [ -f "$ohm_runtime_transaction_record" ] && [ ! -L "$ohm_runtime_transaction_record" ] \
    || ohm_fail "standalone runtime transaction is unsafe: $ohm_runtime_transaction_record"
  ohm_runtime_record_size=$(wc -c < "$ohm_runtime_transaction_record") \
    || ohm_fail "could not inspect standalone runtime transaction"
  [ "$ohm_runtime_record_size" -le 16384 ] \
    && [ "$(awk 'END { print NR }' "$ohm_runtime_transaction_record")" -eq 1 ] \
    && grep -Eq '^\{"product":"ohm","schemaVersion":1,"distribution":"standalone","phase":"(prepared|previous-isolated|replacement-installed|committed)","runtime":"ohm-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)","stage":"\.ohm-stage\.[A-Za-z0-9]+","backup":(null|"\.ohm-backup\.[A-Za-z0-9]+"),"hadPrevious":(true|false)\}$' "$ohm_runtime_transaction_record" \
    || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
  ohm_runtime_record_phase=$(ohm_record_field "$ohm_runtime_transaction_record" phase) \
    || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
  ohm_runtime_record_runtime=$(ohm_record_field "$ohm_runtime_transaction_record" runtime) \
    || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
  ohm_runtime_record_stage=$(ohm_record_field "$ohm_runtime_transaction_record" stage) \
    || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
  case "$ohm_runtime_record_runtime" in
    *-$ohm_platform-$ohm_arch) ;;
    *) ohm_fail "standalone runtime transaction targets another platform" ;;
  esac
  if grep -q '"hadPrevious":true}' "$ohm_runtime_transaction_record"; then
    ohm_runtime_record_had_previous=1
    ohm_runtime_record_backup=$(ohm_record_field "$ohm_runtime_transaction_record" backup) \
      || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
  else
    ohm_runtime_record_had_previous=0
    grep -q '"backup":null,"hadPrevious":false}' "$ohm_runtime_transaction_record" \
      || ohm_fail "standalone runtime transaction is invalid: $ohm_runtime_transaction_record"
    ohm_runtime_record_backup=
  fi
  ohm_runtime_record_target="$ohm_runtime_root/$ohm_runtime_record_runtime"
  ohm_runtime_record_stage_parent="$ohm_runtime_root/$ohm_runtime_record_stage"
  if [ -e "$ohm_runtime_record_target" ] || [ -L "$ohm_runtime_record_target" ]; then
    [ -d "$ohm_runtime_record_target" ] && [ ! -L "$ohm_runtime_record_target" ] \
      || ohm_fail "standalone runtime transaction target is unsafe: $ohm_runtime_record_target"
  fi
  if [ "$ohm_runtime_record_had_previous" -eq 1 ]; then
    ohm_runtime_record_backup_parent="$ohm_runtime_root/$ohm_runtime_record_backup"
    ohm_runtime_record_backup_target="$ohm_runtime_record_backup_parent/$ohm_runtime_record_runtime"
    if [ -e "$ohm_runtime_record_backup_parent" ] || [ -L "$ohm_runtime_record_backup_parent" ]; then
      [ -d "$ohm_runtime_record_backup_parent" ] && [ ! -L "$ohm_runtime_record_backup_parent" ] \
        || ohm_fail "standalone runtime transaction backup is unsafe: $ohm_runtime_record_backup_parent"
    fi
    if [ -e "$ohm_runtime_record_backup_target" ] || [ -L "$ohm_runtime_record_backup_target" ]; then
      [ -d "$ohm_runtime_record_backup_target" ] && [ ! -L "$ohm_runtime_record_backup_target" ] \
        || ohm_fail "standalone runtime transaction backup is unsafe: $ohm_runtime_record_backup_target"
      if [ "$ohm_runtime_record_phase" = committed ]; then
        ohm_remove_recovery_tree "$ohm_runtime_record_backup_parent" .ohm-backup
      else
        if [ -e "$ohm_runtime_record_target" ] || [ -L "$ohm_runtime_record_target" ]; then
          rm -rf -- "$ohm_runtime_record_target" \
            || ohm_fail "could not discard an interrupted standalone runtime replacement"
        fi
        mv "$ohm_runtime_record_backup_target" "$ohm_runtime_record_target" \
          || ohm_fail "could not restore the previous standalone runtime"
        rmdir "$ohm_runtime_record_backup_parent" \
          || ohm_fail "standalone runtime backup contains unexpected residue: $ohm_runtime_record_backup_parent"
      fi
    elif [ ! -e "$ohm_runtime_record_target" ] && [ ! -L "$ohm_runtime_record_target" ]; then
      ohm_fail "standalone runtime transaction lost both its target and backup"
    elif [ -e "$ohm_runtime_record_backup_parent" ] || [ -L "$ohm_runtime_record_backup_parent" ]; then
      rmdir "$ohm_runtime_record_backup_parent" \
        || ohm_fail "standalone runtime backup contains unexpected residue: $ohm_runtime_record_backup_parent"
    fi
  fi
  ohm_remove_recovery_tree "$ohm_runtime_record_stage_parent" .ohm-stage
  rm -f -- "$ohm_runtime_transaction_record" \
    || ohm_fail "could not finish standalone runtime transaction recovery"
}

ohm_recover_runtime_transaction

ohm_stage_parent=$(mktemp -d "$ohm_runtime_root/.ohm-stage.XXXXXX") \
  || ohm_fail "could not stage the standalone runtime"
ohm_staged_target="$ohm_stage_parent/$ohm_archive_root"
mv "$ohm_payload" "$ohm_staged_target" \
  || ohm_fail "could not stage the verified standalone runtime"

ohm_is_managed_runtime_link() {
  ohm_managed_root=$1
  ohm_managed_link=$2
  case "$ohm_managed_link" in
    "$ohm_managed_root"/*/bin/ohm) ;;
    *) return 1 ;;
  esac
  ohm_managed_relative=${ohm_managed_link#"$ohm_managed_root/"}
  ohm_managed_runtime=${ohm_managed_relative%/bin/ohm}
  case "$ohm_managed_runtime" in
    */*|.|..) return 1 ;;
  esac
  printf '%s\n' "$ohm_managed_runtime" \
    | grep -Eq '^ohm-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)$'
}

ohm_launcher_dir="$ohm_install_root/bin"
ohm_launcher="$ohm_launcher_dir/ohm"
mkdir -p -m 700 "$ohm_launcher_dir"
[ -d "$ohm_launcher_dir" ] && [ ! -L "$ohm_launcher_dir" ] \
  || ohm_fail "launcher directory is not a safe directory: $ohm_launcher_dir"
if [ -e "$ohm_launcher" ] || [ -L "$ohm_launcher" ]; then
  if [ -L "$ohm_launcher" ]; then
    ohm_previous_target=$(readlink "$ohm_launcher")
    ohm_is_managed_runtime_link "$ohm_runtime_root" "$ohm_previous_target" \
      || ohm_fail "refusing to replace an unmanaged command: $ohm_launcher"
  else
    ohm_fail "refusing to replace an unmanaged command: $ohm_launcher"
  fi
fi
ohm_link_stage=$(mktemp -d "$ohm_launcher_dir/.ohm-link.XXXXXX") \
  || ohm_fail "could not stage the ohm command"
ohm_launcher_backup="$ohm_link_stage/previous"
if [ -e "$ohm_launcher" ] || [ -L "$ohm_launcher" ]; then
  cp -P "$ohm_launcher" "$ohm_launcher_backup" \
    || ohm_fail "could not stage the previous ohm command"
  ohm_launcher_had_previous=1
fi
ln -s "$ohm_target/bin/ohm" "$ohm_link_stage/ohm"

ohm_command_dir="$HOME/.local/bin"
ohm_command="$ohm_command_dir/ohm"
mkdir -p -m 700 "$ohm_command_dir"
[ -d "$ohm_command_dir" ] && [ ! -L "$ohm_command_dir" ] \
  || ohm_fail "command directory is not a safe directory: $ohm_command_dir"
if [ -e "$ohm_command" ] || [ -L "$ohm_command" ]; then
  if [ -L "$ohm_command" ]; then
    ohm_previous_command_target=$(readlink "$ohm_command")
    if [ "$ohm_previous_command_target" != "$ohm_launcher" ]; then
      if ohm_is_managed_runtime_link "$ohm_runtime_root" "$ohm_previous_command_target"; then
        :
      else
        ohm_fail "refusing to replace an unmanaged command: $ohm_command"
      fi
    fi
  elif [ -f "$ohm_command" ]; then
    ohm_launcher_escaped=$(
      printf '%s\n' "$ohm_launcher" \
        | awk '{ gsub(/\047/, "\047\"\047\"\047"); printf "%s", $0 }'
    )
    ohm_managed_command_expected="$ohm_tmp/managed-command"
    printf '#!/usr/bin/env sh\n# ohm managed command\nexec '\''%s'\'' "$@"\n' \
      "$ohm_launcher_escaped" > "$ohm_managed_command_expected"
    cmp -s "$ohm_command" "$ohm_managed_command_expected" \
      || ohm_fail "refusing to replace an unmanaged command: $ohm_command"
  else
    ohm_fail "refusing to replace an unmanaged command: $ohm_command"
  fi
fi
ohm_command_stage=$(mktemp -d "$ohm_command_dir/.ohm-command.XXXXXX") \
  || ohm_fail "could not stage the ohm command"
ohm_command_backup="$ohm_command_stage/previous"
if [ -e "$ohm_command" ] || [ -L "$ohm_command" ]; then
  cp -P "$ohm_command" "$ohm_command_backup" \
    || ohm_fail "could not stage the previous ohm command"
  ohm_command_had_previous=1
fi
ln -s "$ohm_launcher" "$ohm_command_stage/ohm"

ohm_home=${OHM_HOME:-"$HOME/.ohm"}
mkdir -p -m 700 "$ohm_home"
[ -d "$ohm_home" ] && [ ! -L "$ohm_home" ] \
  || ohm_fail "ohm home is not a safe directory: $ohm_home"
ohm_validate_scaffold_destination "$ohm_home/AGENTS.md" "Agent instructions"
ohm_validate_scaffold_destination "$ohm_home/config.json" "ohm configuration"
ohm_resources="$ohm_target/lib/node_modules/ohm/resources"

ohm_backup_parent=
ohm_runtime_transaction_stage_name=${ohm_stage_parent##*/}
ohm_runtime_transaction_backup_json=null
ohm_runtime_transaction_previous=false
if [ -e "$ohm_target" ] || [ -L "$ohm_target" ]; then
  [ -d "$ohm_target" ] && [ ! -L "$ohm_target" ] \
    || ohm_fail "existing standalone runtime is not a safe ohm installation: $ohm_target"
  ohm_backup_parent=$(mktemp -d "$ohm_runtime_root/.ohm-backup.XXXXXX") \
    || ohm_fail "could not stage the previous standalone runtime"
  ohm_backup="$ohm_backup_parent/$ohm_archive_root"
  ohm_runtime_transaction_backup_name=${ohm_backup_parent##*/}
  ohm_runtime_transaction_backup_json="\"$ohm_runtime_transaction_backup_name\""
  ohm_runtime_transaction_previous=true
  ohm_write_runtime_transaction \
    prepared \
    "$ohm_archive_root" \
    "$ohm_runtime_transaction_stage_name" \
    "$ohm_runtime_transaction_backup_json" \
    "$ohm_runtime_transaction_previous"
  mv "$ohm_target" "$ohm_backup" \
    || ohm_fail "could not stage the previous standalone runtime"
  ohm_runtime_commit_started=1
  ohm_write_runtime_transaction \
    previous-isolated \
    "$ohm_archive_root" \
    "$ohm_runtime_transaction_stage_name" \
    "$ohm_runtime_transaction_backup_json" \
    "$ohm_runtime_transaction_previous"
  if ! mv "$ohm_staged_target" "$ohm_target"; then
    if mv "$ohm_backup" "$ohm_target"; then
      rm -rf -- "$ohm_stage_parent" "$ohm_backup_parent"
      ohm_stage_parent=
      ohm_backup_parent=
      ohm_runtime_commit_started=0
      ohm_fail "could not replace the standalone runtime; the previous runtime was restored"
    fi
    ohm_fail "could not replace the standalone runtime; backup preserved at $ohm_backup"
  fi
  ohm_write_runtime_transaction \
    replacement-installed \
    "$ohm_archive_root" \
    "$ohm_runtime_transaction_stage_name" \
    "$ohm_runtime_transaction_backup_json" \
    "$ohm_runtime_transaction_previous"
else
  ohm_write_runtime_transaction \
    prepared \
    "$ohm_archive_root" \
    "$ohm_runtime_transaction_stage_name" \
    "$ohm_runtime_transaction_backup_json" \
    "$ohm_runtime_transaction_previous"
  ohm_runtime_commit_started=1
  mv "$ohm_staged_target" "$ohm_target" \
    || ohm_fail "could not install the standalone runtime"
  ohm_write_runtime_transaction \
    replacement-installed \
    "$ohm_archive_root" \
    "$ohm_runtime_transaction_stage_name" \
    "$ohm_runtime_transaction_backup_json" \
    "$ohm_runtime_transaction_previous"
fi
rmdir "$ohm_stage_parent"
ohm_stage_parent=

if [ ! -e "$ohm_home/AGENTS.md" ] && [ ! -L "$ohm_home/AGENTS.md" ]; then
  ohm_created_agents=1
  cp "$ohm_resources/AGENTS.md" "$ohm_home/AGENTS.md" \
    || ohm_fail "could not create $ohm_home/AGENTS.md"
  chmod 600 "$ohm_home/AGENTS.md" \
    || ohm_fail "could not secure $ohm_home/AGENTS.md"
else
  ohm_validate_scaffold_destination "$ohm_home/AGENTS.md" "Agent instructions"
fi
if [ ! -e "$ohm_home/config.json" ] && [ ! -L "$ohm_home/config.json" ]; then
  ohm_created_settings=1
  cp "$ohm_resources/config.example.json" "$ohm_home/config.json" \
    || ohm_fail "could not create $ohm_home/config.json"
  chmod 600 "$ohm_home/config.json" \
    || ohm_fail "could not secure $ohm_home/config.json"
else
  ohm_validate_scaffold_destination "$ohm_home/config.json" "ohm configuration"
fi

ohm_launcher_commit_started=1
mv -f "$ohm_link_stage/ohm" "$ohm_launcher" \
  || ohm_fail "could not install the ohm launcher"
ohm_command_commit_started=1
mv -f "$ohm_command_stage/ohm" "$ohm_command" \
  || ohm_fail "could not install the ohm command"
if ! ohm_installed_version=$("$ohm_command" --version); then
  ohm_fail "the installed ohm command failed its version check"
fi
[ "$ohm_installed_version" = "$ohm_version" ] \
  || ohm_fail "the installed ohm command reported an unexpected version"
ohm_write_runtime_transaction \
  committed \
  "$ohm_archive_root" \
  "$ohm_runtime_transaction_stage_name" \
  "$ohm_runtime_transaction_backup_json" \
  "$ohm_runtime_transaction_previous"
if [ -n "$ohm_backup_parent" ]; then
  rm -rf -- "$ohm_backup_parent"
  ohm_backup_parent=
fi
rm -f -- "$ohm_runtime_transaction_record"
ohm_runtime_transaction_active=0
rm -rf -- "$ohm_link_stage"
ohm_link_stage=
rm -rf -- "$ohm_command_stage"
ohm_command_stage=

printf 'ohm %s was installed from its verified GitHub standalone release.\n' "$ohm_version"
printf 'ohm home: %s\n' "$ohm_install_root"
printf 'Runtime: %s\n' "$ohm_target"
printf 'Command: %s\n' "$ohm_command"
case ":${PATH:-}:" in
  *":$ohm_command_dir:"*) ;;
  *) printf 'Add %s to PATH, then run ohm.\n' "$ohm_command_dir" ;;
esac
