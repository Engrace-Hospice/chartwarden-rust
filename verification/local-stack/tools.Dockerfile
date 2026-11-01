# Tools image for the M02 local stack: Bun (same version as CI) + git, running as uid 1000 (the `bun` user), like
# upstream's api container. Local, throwaway test tooling only; never published.
FROM oven/bun:1.4.4
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /work /out \
 && chown 1000:1000 /work /out
USER 1000:1000
