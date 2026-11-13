#!/bin/bash
# sshd-in-container entrypoint for the Stage A lifecycle.
# - regenerate ephemeral host keys on every start (identity = container lifecycle;
#   the lifecycle owner re-pins known_hosts after every start/recreate)
# - install the public key handed via AUTHORIZED_KEY env (injected at docker create)
# - map the agent user to HOST_UID/HOST_GID when given, so the identical-path
#   bind mount's host-owned files are writable by the session user
# - harden: no password login, no root login, no MOTD noise
set -euo pipefail

rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
ssh-keygen -A >/dev/null

if [ -n "${AUTHORIZED_KEY:-}" ]; then
  printf '%s\n' "$AUTHORIZED_KEY" > /home/agent/.ssh/authorized_keys
fi

if [ -n "${HOST_UID:-}" ] && [ "${HOST_UID}" != "$(id -u agent)" ]; then
  # Deliberate host-uid mapping (Hermes docker_run_as_host_user precedent).
  # /home/agent and /opt/dsh follow the new uid; the bind mount never does —
  # its files keep host ownership, which is exactly what makes them writable.
  # node:24-bookworm-slim ships user "node" at uid 1000 — the default first
  # uid on most Linux hosts; move it aside or usermod aborts (set -e) before
  # sshd ever starts and first use dies in the sshd wait loop.
  if [ "$(id -u node 2>/dev/null || true)" = "${HOST_UID}" ]; then
    usermod -u 2000 node
  fi
  usermod -u "$HOST_UID" agent
  chown -R "$HOST_UID" /home/agent /opt/dsh
fi
if [ -n "${HOST_GID:-}" ] && [ "${HOST_GID}" != "$(id -g agent)" ]; then
  # A colliding gid (macOS staff=20 maps onto an existing Debian group) must
  # not abort startup: numeric ownership below is what the bind mount needs.
  groupmod -g "$HOST_GID" agent || true
  chown -R "$HOST_UID:${HOST_GID}" /home/agent /opt/dsh || chown -R "$HOST_UID" /home/agent /opt/dsh
fi

chown agent:agent /home/agent/.ssh/authorized_keys 2>/dev/null || true
chmod 600 /home/agent/.ssh/authorized_keys 2>/dev/null || true

# Sanitize shipped config: pubkey-only, no root, no DNS lookups (speed), verbose logs.
cat > /etc/ssh/sshd_config.d/10-stagea.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UseDNS no
LogLevel VERBOSE
AllowAgentForwarding no
# A0 finding F2: Debian OpenSSH 9.2 gates direct-streamlocal@openssh.com under
# the LOCAL TCP forwarding permission — AllowStreamLocalForwarding yes alone is
# not enough. `local` permits only -L forwards (dsh-ssh program streams); -R
# stays blocked.
AllowTcpForwarding local
AllowStreamLocalForwarding yes
X11Forwarding no
EOF

exec /usr/sbin/sshd -D -e
