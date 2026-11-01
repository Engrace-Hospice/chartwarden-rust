# syntax=docker/dockerfile:1.7
# ChartWarden Rust API image (CW-RUST-M02 P1). Build context: rust/.
#
# Base images MUST be pinned by digest. The defaults below are placeholders until the image workflow's
# `resolve-digests` mode prints the real digests (this repo's build sandbox cannot reach any registry);
# the workflow's `build-push` mode refuses to build while any FROM is unpinned.
# Builder and runtime are both Debian 13, so the binary's glibc matches the runtime.
ARG RUST_IMAGE=rust:1.97.0-slim-trixie@sha256:UNPINNED
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:UNPINNED

FROM ${RUST_IMAGE} AS build
# Use the image's toolchain as-is (no rustup download) and prove it is the pinned version.
ENV RUSTUP_TOOLCHAIN=1.97.0 CARGO_TERM_COLOR=never
WORKDIR /src
COPY . .
RUN rustc --version | grep -q ' 1\.97\.0 ' \
 && cargo build --locked --release -p cw-server \
 && mkdir -p /out/run/cw-rust

# Runtime: distroless (no shell, no package manager), non-root.
FROM ${RUNTIME_IMAGE}
COPY --from=build /src/target/release/cw-server /usr/local/bin/cw-server
# Socket directory: owner cw-rust (65532), group 1000 = the `bun` user that runs upstream's `api` image, mode 0750,
# so only `api` can traverse to the socket (spec v0.3 P1). A named volume mounted here inherits this on creation.
COPY --from=build --chown=65532:1000 --chmod=0750 /out/run/cw-rust /run/cw-rust
USER 65532:1000
ENV CW_RUST_SOCKET=/run/cw-rust/cw-rust.sock
ENTRYPOINT ["/usr/local/bin/cw-server"]
