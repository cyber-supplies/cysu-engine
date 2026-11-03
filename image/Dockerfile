# cysu-engine workspace image: what every workflow run executes in.
# Node + Go + Python + ProjectDiscovery tools + curl/utilities + cysu CLI + Codex.
#
#   docker build -t cysu-engine-workspace:dev image
#   (multi-arch, as the release workflow does: docker buildx build --platform linux/amd64,linux/arm64 image)

# ---- ProjectDiscovery tools, built once ------------------------------------
# Cross-compiled on the build machine's own platform for the target platform
# (fast; no emulation for arm64 images). Static binaries (CGO off).
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS pd
ARG TARGETOS TARGETARCH
RUN set -e; export GOOS="$TARGETOS" GOARCH="$TARGETARCH" CGO_ENABLED=0; \
    for tool in \
      github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
      github.com/projectdiscovery/httpx/cmd/httpx@latest \
      github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
      github.com/projectdiscovery/katana/cmd/katana@latest \
      github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest; do \
      go install "$tool"; \
    done; \
    # cross-compiled binaries land in /go/bin/<os>_<arch>/
    if [ -d "/go/bin/${GOOS}_${GOARCH}" ]; then mv "/go/bin/${GOOS}_${GOARCH}"/* /go/bin/ && rmdir "/go/bin/${GOOS}_${GOARCH}"; fi

# The Go toolchain itself, for the TARGET platform.
FROM golang:1.26-bookworm AS gotoolchain

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm
LABEL org.opencontainers.image.source="https://github.com/cyber-supplies/cysu-engine" \
      org.opencontainers.image.description="Cyber Supplies Engine worker: Node, Go, Python, ProjectDiscovery, cysu CLI, Codex"

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl wget ca-certificates git jq unzip less vim-tiny \
      dnsutils iputils-ping netcat-openbsd iproute2 iptables \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Go toolchain (for agents that build or `go install` tools themselves)
COPY --from=gotoolchain /usr/local/go /usr/local/go
COPY --from=pd /go/bin/ /usr/local/bin/
ENV PATH="/usr/local/go/bin:${PATH}"

# Cyber Supplies CLI (public npm) + agent harness (Codex for now; Claude/Kimi/GLM later).
# CYSU_VERSION / CODEX_VERSION pin a release when reproducing an older image.
ARG CYSU_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g @cyber-supplies/cysu@${CYSU_VERSION} @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force \
 && cysu help >/dev/null

# Unprivileged user (fixed uid so engine-side files line up); the global
# profile is installed as this user, workspace profiles go in /workspace.
RUN useradd -m -u 10001 -s /bin/bash runner && mkdir -p /workspace && chown runner:runner /workspace
COPY --chmod=755 entrypoint.sh /usr/local/bin/cysu-entrypoint
COPY --chmod=755 egress-guard.sh /usr/local/bin/cysu-egress-guard

# The cysu skill, from the public cysu-cli repo. It is kept OUTSIDE the home
# directory and copied into ~/.codex/skills and ~/.agents/skills at container
# start: `cysu profiles install` swaps those folders with rename(), which
# fails (EXDEV) on directories that come from an image layer (overlayfs).
RUN git clone -q --depth 1 https://github.com/cyber-supplies/cysu-cli.git /tmp/cysu-cli \
 && mkdir -p /opt/cysu \
 && cp -R /tmp/cysu-cli/skill/cysu /opt/cysu/skill \
 && chmod -R a+rX /opt/cysu \
 && rm -rf /tmp/cysu-cli

# The entrypoint starts as root only to install the egress firewall, then
# drops to runner for good. The engine starts containers with
# --cap-drop ALL --cap-add NET_ADMIN,SETUID,SETGID and no-new-privileges.
USER root
WORKDIR /workspace
ENTRYPOINT ["cysu-entrypoint"]
