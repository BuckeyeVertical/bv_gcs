#!/usr/bin/env bash
# Build the GCS frontend locally, copy it to the Jetson, and rebuild its workspace.
set -euo pipefail

if [[ ${1:-} == --help || $# -gt 2 ]]; then
  echo "Usage: $0 [ssh-host] [remote-workspace]"
  echo "Defaults: the first reachable Jetson link and bv_ws (relative to its home)"
  echo "Run this after syncing the repositories whenever the GCS changes."
  exit 0
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(git -C "$script_dir" rev-parse --show-toplevel)
remote_workspace=${2:-bv_ws}

jetson_reachable() {
  local err
  err=$(ssh -o ConnectTimeout=3 -o BatchMode=yes "$1" true 2>&1 >/dev/null) && return 0
  ! grep -qiE 'timed out|no route|refused|unreachable|could not resolve' <<<"$err"
}

find_jetson() {
  if [[ -n ${1:-} ]]; then
    echo "$1"
    return
  fi

  local host
  for host in jetson-usbc jetson-herelink; do
    if jetson_reachable "$host"; then
      echo "$host"
      return
    fi
  done

  echo "Jetson is not reachable over USB-C or Herelink; pass an SSH host." >&2
  return 1
}

jetson_host=$(find_jetson "${1:-}")
remote_dist="$remote_workspace/src/bv_gcs/web/dist"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required on this computer to build the GCS frontend." >&2
  exit 1
fi

echo "Building the GCS frontend locally..."
npm --prefix "$repo_dir/web" run build

echo "Copying the frontend bundle to $jetson_host:$remote_dist..."
rsync --archive --delete "$repo_dir/web/dist/" "$jetson_host:$remote_dist/"

remote_script='set -euo pipefail
workspace=$1
source /opt/ros/humble/setup.bash
cd -- "$workspace"
colcon build'
printf -v remote_command 'bash -c %q -- %q' \
  "$remote_script" "$remote_workspace"

echo "Building the Jetson workspace..."
ssh "$jetson_host" "$remote_command"

echo "GCS deployed. Restart the mission/GCS process and hard-refresh the browser."
