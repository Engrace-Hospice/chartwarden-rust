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
# (`cargo tree -i` exits 0 with "nothing to print" when the crate is absent, so inspect the output.)
if cargo tree -i rsa --all-features --target all 2>/dev/null | grep -q '^rsa v'; then
  echo "rsa is now part of the build: remove the RUSTSEC-2023-0071 ignore and deal with the advisory"; exit 1
fi
echo "supply chain: ok (toolchain $have)"
