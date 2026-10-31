# ChartWarden Rust

Incremental Rust backend migration for ChartWarden, governed by ADR-0060 and CW-RUST-M00.

The existing `Engrace-Hospice/chartwarden` repository is the source of truth. This repository does not replace, remove, or modify its tests.

## Initial scope

- M00: reproducible, read-only inventory of a pinned upstream checkout
- M01: independently reproduce and fix critical upstream blockers before affected domain migration
- M02: authenticated, tenant-scoped, read-only Rust vertical slice

See `docs/adr/ADR-0060.md` and `docs/specs/CW-RUST-M00.md` as they are added.
