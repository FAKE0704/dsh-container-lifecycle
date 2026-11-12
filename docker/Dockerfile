FROM node:24-bookworm-slim

# Stage A lifecycle image: Node base (helper node-script launch kind) + sshd.
# Node lives at /usr/local/bin/node; glibc 2.36 satisfies the 2.28 baseline.
# APT_MIRROR (optional, e.g. mirrors.tuna.tsinghua.edu.cn) reroutes apt for
# throttled routes; empty keeps upstream deb.debian.org.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources || true; fi

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /workspace /home/agent/.ssh /opt/dsh \
 && useradd -m -s /bin/bash agent \
 && chown agent:agent /home/agent/.ssh /opt/dsh /workspace \
 && chmod 700 /home/agent/.ssh

# procps: pgrep for the lifecycle's sshd readiness probe.

# Ephemeral host keys are generated at container start (never baked in);
# the lifecycle owner reads them back via docker exec and pins known_hosts.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
