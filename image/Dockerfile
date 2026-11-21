# cysu-engine workspace image: what every workflow run executes in.
# Node + Go + Python + ProjectDiscovery tools + cysu CLI + Codex + Claude Code.
#
#   docker build -t cysu-engine-workspace:dev image
#   (release target: docker buildx build --platform linux/amd64 image)

# ---- ProjectDiscovery tools, built once ------------------------------------
# Compiled on the build machine for the target platform. Static binaries (CGO off).
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
      org.opencontainers.image.description="Cyber Supplies Engine worker: Node, Go, Python, ProjectDiscovery, cysu CLI, Codex, Claude Code"

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl wget ca-certificates git jq unzip less vim-tiny \
      dnsutils iputils-ping netcat-openbsd iproute2 iptables \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# The published engine intentionally grants only a small capability set. Run
# apt downloads as root so package installation works without DAC_OVERRIDE or
# FOWNER in worker-only updates.
RUN printf 'APT::Sandbox::User "root";\n' > /etc/apt/apt.conf.d/99cysu-root \
 && chown -R root:root /var/lib/apt/lists /var/cache/apt/archives

# Go toolchain (for agents that build or `go install` tools themselves)
COPY --from=gotoolchain /usr/local/go /usr/local/go
COPY --from=pd /go/bin/ /usr/local/bin/
ENV PATH="/usr/local/go/bin:${PATH}"

# Stages use the engine CLI cache, with this baseline as fallback.
# Provider harness versions are pinned and tested together.
ARG CODEX_VERSION=0.167.0
ARG CLAUDE_CODE_VERSION=2.1.325
RUN npm install -g @cyber-supplies/cysu@latest @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && cysu help >/dev/null

# Daybreak (stage setting `daybreak`) needs Codex >= 0.166, which added
# --cyber-access-program to `codex exec` and `exec resume`. Fail the build
# rather than ship an image whose stages would reject the flag.
RUN v=$(codex --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) \
 && printf '0.166.0\n%s\n' "$v" | sort -C -V \
 || { echo "Codex ${v:-unknown} is too old: Daybreak needs 0.166.0 or newer" >&2; exit 1; } \
 && codex exec --help | grep -q -- '--cyber-access-program' \
 && codex exec resume --help | grep -q -- '--cyber-access-program' \
 || { echo "This Codex has no --cyber-access-program flag (needed for Daybreak)" >&2; exit 1; }

# Compatibility path for profile state, credentials and the persisted Claude
# volume. The agent runs as root with HOME=/home/runner.
RUN useradd -m -u 10001 -s /bin/bash runner \
 && mkdir -p /workspace /home/runner/.claude \
 && chown -R root:root /workspace /home/runner \
 && chmod 0700 /home/runner/.claude
COPY --chmod=755 entrypoint.sh /usr/local/bin/cysu-entrypoint
COPY --chmod=755 codex-diagnostics.py /opt/cysu/codex-diagnostics.py
COPY --chmod=755 egress-guard.sh /usr/local/bin/cysu-egress-guard
# Engine linked: a skill added to linked workers only (see entrypoint.sh).
COPY engine-history /opt/cysu/engine-history-skill

# The cysu skill, from the public cysu-cli repo. It is kept OUTSIDE the home
# directory and copied into ~/.codex/skills and ~/.agents/skills at container
# start: `cysu profiles install` swaps those folders with rename(), which
# fails (EXDEV) on directories that come from an image layer (overlayfs).
RUN git clone -q --depth 1 https://github.com/cyber-supplies/cysu-cli.git /tmp/cysu-cli \
 && mkdir -p /opt/cysu \
 && cp -R /tmp/cysu-cli/skill/cysu /opt/cysu/skill \
 && chmod -R a+rX /opt/cysu \
 && rm -rf /tmp/cysu-cli

# The entrypoint installs the egress firewall, then keeps the agent as root.
# The existing engine starts containers with --cap-drop ALL and only
# NET_ADMIN,CHOWN,SETUID,SETGID,KILL plus no-new-privileges.
USER root
WORKDIR /workspace
ENTRYPOINT ["cysu-entrypoint"]
