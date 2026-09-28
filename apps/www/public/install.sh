#!/bin/sh
set -eu

fail() { printf 'codesesh: %s\n' "$*" >&2; exit 1; }

install_codesesh() {
  version=${CODESESH_VERSION:-}
  install_dir=${CODESESH_INSTALL_DIR:-"$HOME/.local/bin"}
  releases=https://github.com/xingkaixin/codesesh/releases
  case "$install_dir" in /*) ;; *) fail 'CODESESH_INSTALL_DIR must be an absolute path.' ;; esac
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64|Darwin/aarch64) target=aarch64-apple-darwin ;;
    Darwin/x86_64) target=x86_64-apple-darwin ;;
    Linux/x86_64)
      target=x86_64-unknown-linux-gnu
      libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Linux requires glibc 2.35 or later; musl is not supported.'
      printf '%s\n' "$libc" | awk '$1 == "glibc" { split($2, v, "."); if (v[1] > 2 || (v[1] == 2 && v[2] >= 35)) ok = 1 } END { exit !ok }' || fail 'Linux requires glibc 2.35 or later.'
      ;;
    *) fail 'Supported platforms: macOS arm64/x64 and Linux x64 (glibc 2.35+).' ;;
  esac
  for tool in curl tar mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Missing required command: $tool"; done
  if command -v sha256sum >/dev/null 2>&1; then
    hash_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    hash_tool=shasum
  else
    fail 'SHA-256 verification requires sha256sum or shasum.'
  fi
  if [ -z "$version" ]; then
    latest=$(curl -fsSL --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "$releases/latest")
    version=${latest##*/}
  fi
  version=${version#v}
  printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Expected a stable version such as 1.1.1.'
  destination=$install_dir/codesesh
  [ ! -L "$destination" ] || fail "Refusing to replace a symlink: $destination. Update through its original package manager."
  [ ! -d "$destination" ] || fail "Destination is a directory: $destination"
  if [ -x "$destination" ] && [ "$("$destination" --version 2>/dev/null || true)" = "codesesh $version" ]; then
    printf 'CodeSesh %s is already installed at %s\n' "$version" "$destination"
    return
  fi
  temp_dir=$(mktemp -d)
  staged=
  trap 'rm -rf "$temp_dir"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
  trap 'exit 1' HUP INT TERM
  archive=codesesh-$version-$target.tar.gz
  base=$releases/download/v$version
  printf 'Downloading CodeSesh %s (%s)…\n' "$version" "$target"
  curl -fsSL --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$temp_dir/SHA256SUMS"
  expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$temp_dir/SHA256SUMS")
  [ "${#expected}" -eq 64 ] || fail "Missing or invalid checksum for $archive"
  case "$expected" in *[!a-f0-9]*) fail 'Invalid SHA-256 checksum.' ;; esac
  curl -fsSL --proto '=https' --tlsv1.2 "$base/$archive" -o "$temp_dir/$archive"
  if [ "$hash_tool" = sha256sum ]; then
    actual=$(sha256sum "$temp_dir/$archive" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$temp_dir/$archive" | awk '{print $1}')
  fi
  [ "$actual" = "$expected" ] || fail 'Checksum mismatch; existing installation was not changed.'
  tar -xzf "$temp_dir/$archive" -C "$temp_dir" codesesh
  [ -f "$temp_dir/codesesh" ] && [ ! -L "$temp_dir/codesesh" ] || fail 'Archive does not contain a regular codesesh executable.'
  chmod 755 "$temp_dir/codesesh"
  [ "$("$temp_dir/codesesh" --version)" = "codesesh $version" ] || fail 'Downloaded executable failed its version check.'
  mkdir -p "$install_dir"
  staged=$(mktemp "$install_dir/.codesesh.XXXXXX")
  cp "$temp_dir/codesesh" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$destination"
  staged=
  printf 'Installed CodeSesh %s at %s\n' "$version" "$destination"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) printf 'Add %s to PATH in your shell configuration.\n' "$install_dir" ;;
  esac
  current=$(command -v codesesh || true)
  if [ -n "$current" ] && [ "$current" != "$destination" ]; then
    printf 'Your PATH currently selects %s. Adjust PATH to use %s.\n' "$current" "$destination"
  fi
  printf 'Run codesesh to start. Run this installer again to update; restart any running CodeSesh process afterward.\n'
}

install_codesesh
