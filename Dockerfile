# cysu-engine: the engine itself, as a container. It drives the HOST's Docker
# (through the mounted Docker socket) to start the worker containers built
# from image/. Run it the way `cysu engine` does (docs/INSTALL.md):
#
#   docker run -d --name cysu-engine --restart unless-stopped --init \
#     -p 127.0.0.1:8787:8787 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v cysu-engine-data:/data -v cysu-engine-agent:/run/cysu-engine \
#     cysu-engine:dev
#
#   docker build -t cysu-engine:dev .

# Only the docker command-line client is needed (the daemon is the host's).
FROM docker:29-cli AS dockercli

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/cyber-supplies/cysu-engine" \
      org.opencontainers.image.description="Cyber Supplies Engine: runs workspaces in Docker; used from the cysu CLI"
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# The worker image this engine starts for stages and the assistant. Local
# builds use the locally built one; the release workflow passes the
# published image of the same version.
ARG WORKER_IMAGE=cysu-engine-workspace:dev

WORKDIR /opt/cysu-engine
COPY package.json openapi.yaml README.md ./
COPY server/ ./server/
COPY docs/ ./docs/

# Inside the container it listens on all interfaces, but the run command only
# publishes it on the host's 127.0.0.1. The agent socket lives in the
# cysu-engine-agent volume, which the assistant's containers mount too.
ENV CYSU_ENGINE_IMAGE=${WORKER_IMAGE} \
    HOST=0.0.0.0 \
    PORT=8787 \
    CYSU_ENGINE_DATA=/data \
    CYSU_ENGINE_AGENT_SOCKET=/run/cysu-engine/agent.sock \
    CYSU_ENGINE_AGENT_VOLUME=cysu-engine-agent
VOLUME ["/data", "/run/cysu-engine"]
EXPOSE 8787
CMD ["node", "server/index.js"]
