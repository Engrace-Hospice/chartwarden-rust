#!/usr/bin/env bash
# CW-RUST-M02 AT-M02-07: every supply-chain check, fail-closed. Run from rust/.
# A failure to fetch the advisory database makes cargo-deny / cargo-audit exit non-zero, which fails this script.
set -euo pipefail
cd "$(dirname "$0")/.."

want=$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)
have=$(rustc --version | awk '{print $2}')
[ "$want" = "$have" ] || { echo "toolchain mismatch: rust-toolchain.toml=$want rustc=$have"; exit 1; }

cargo build --locked --workspace
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo deny --locked check
cargo audit --deny warnings

# The cargo-audit ignore for RUSTSEC-2023-0071 is valid only while `rsa` is not compiled.
# Fail closed: if the dependency graph cannot be inspected, the gate fails. `cargo tree -i` exits 0 and prints
# "nothing to print" when the crate is absent, so we check the exit status first, then the package list.
if ! tree_out=$(cargo tree --locked -i rsa --all-features --target all --prefix none --format '{p}' 2>&1); then
  echo "cannot inspect the dependency graph (cargo tree failed):"; echo "$tree_out"; exit 1
fi
if grep -qE '^rsa v' <<<"$tree_out"; then
  echo "rsa is now part of the build: remove the RUSTSEC-2023-0071 ignore and deal with the advisory"; exit 1
fi
if ! grep -q 'nothing to print' <<<"$tree_out"; then
  echo "unexpected cargo tree output; refusing to assume rsa is absent:"; echo "$tree_out"; exit 1
fi
echo "supply chain: ok (toolchain $have)"
