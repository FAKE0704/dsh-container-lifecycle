# dsh-container-lifecycle

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community plugin that turns a profile into a **container execution world**: the profile's shell, filesystem, and sandbox services stop running on your machine and run inside a Docker container that this plugin owns end-to-end.

One plugin owns the whole connection chain — image digest pin → labeled container (sshd, identical-path bind mount, loopback-only port, host uid mapping) → helper closure injected and hashed → ephemeral host key pinned into plugin-owned `known_hosts` → managed `~/.ssh/config` block → the stock upstream `dsh-ssh` connection inserted at runtime with the computed helper hash. **No upstream seam is touched; nothing is proxied.** The ssh transport plugins are the unmodified upstream packages.

> **Status: experimental (Stage A).** Community plugin by an independent author — not part of DeepSeek Harness, not reviewed or endorsed by the DeepSeek team. Tested against exactly one DSH release (see the [supported versions](#supported-versions)).

> ⚠️ **Desktop limitation (upstream bug, honestly stated):** DSH's Electron hosts (Desktop app and its CLI carrier) currently cannot carry dsh-ssh streams — Electron's BoringSSL lacks the TLS 1.2 PSK cipher suites the transport negotiates ([upstream discussion #9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)). On those hosts this world degrades exactly like any dsh-ssh usage would. The verified host for this plugin today is the **headless CLI driven by a plain-OpenSSL Node** (recipe below). If upstream ships the cipher availability, Desktop starts working with zero changes here.

## What you get

- A real agent session whose `bash`/`fs` tools execute **inside a pinned Debian container**, with your workspace bind-mounted at the **identical path** (`/Users/you/work` on the host is the same path inside the container — same-path projection).
- Restart resilience: containers are labeled and **adopted** after host restarts; ephemeral host keys are re-pinned automatically.
- Trust chain that refuses drift: the image is pinned by digest (repo digest when pulled, image ID when locally built) and a rebuilt image under the same tag is **refused** with both digests and explicit rebind paths. The helper closure is SHA-256-pinned and re-verified.
- Two read-mostly tools: `container-status` (pin/container/helper/ssh-block facts) and `container-dispose` (teardown behind an approval gate).
- First-use **auto-build**: if the image tag is absent, the plugin builds it from the bundled `docker/Dockerfile` (apt mirror configurable) and pins the result.

## Install (verified path: headless CLI)

Tested end-to-end on macOS (Docker Desktop). `DSH_HOME` defaults to `~/.dsh`; the profile below is named `headless` so it picks up the headless template on first use.

**1 — bootstrap the profile** (one paste; manifest declares the bundles, the build posture, and your model wiring):

```bash
mkdir -p "$DSH_HOME/profiles/headless" && cd "$DSH_HOME/profiles/headless"
cat > package.json <<'EOF'
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": {
    "dsh-container-lifecycle": "github:FAKE0704/dsh-container-lifecycle"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-headless",
    "dsh-container-lifecycle"
  ] } }
}
EOF
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-pty: false
  koffi: false
  "@deepseek-ai/dsh-subprocess-local": false
EOF
cat > cordis.patch.yml <<'EOF'
# Model wiring: bring your own provider. The container world itself needs no
# profile rows — it comes from the plugin's own bundle patch.
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: <your-provider>
    model: <your-model>
EOF
```

The `allowBuilds: false` entries are deliberate: the native helper modules (`node-pty`, `koffi`, `dsh-subprocess-local`) are **built inside the container**, never on your host — pnpm 11 otherwise treats their blocked build scripts as a failed `add`.

**2 — install:**

```bash
dsh plugin --profile headless add dsh-container-lifecycle
```

**3 — run a session in the container world:**

```bash
cd /your/workspace && dsh --profile headless "uname -a && head -2 /etc/os-release"
```

First launch builds the image (needs a pullable `node:24-bookworm-slim` base), creates the container, installs the helper closure inside it, and writes the managed ssh block. Expect a few minutes, once.

### Verified transcript (real session, unedited)

```
$ dsh --profile headless "Run these in order: 1) uname -a  2) head -2 /etc/os-release
   3) pwd  4) ls | head -5. Then state plainly: are you on the macOS host or
   inside a Linux container, and what evidence proves it."

1) Linux a9bc8598881d 7.0.12-linuxkit #1 SMP PREEMPT ... aarch64 GNU/Linux
2) PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
   NAME="Debian GNU/Linux"
3) /Users/gaogao/Documents/deepseek-harness/DSHFAKE
4) container-provider-design
   dsh-local-llm
   genshu-design-log
   github-evidence-draft
   jd-hunt

Verdict: I am inside a Linux container, not on the macOS host.
Evidence: the linuxkit kernel is what Docker Desktop runs on macOS, and the
hostname is a container ID. A macOS host would report Darwin. The one
seemingly macOS-flavored datum — the /Users/... working directory — is not
host evidence: it is the session workspace projected/mounted into the
container, which is exactly how this harness exposes the host directory to
the containerized execution world.
```

### Plain-Node host (Electron/BoringSSL workaround)

Until upstream fixes PSK availability, run the headless CLI under a plain-OpenSSL Node instead of the Electron carrier. With the Desktop install, the app ships such a Node; extract the runtime tree once and launch:

```bash
node /path/to/extracted/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js --profile headless "<task>"
```

Launch it from a real terminal (not from inside a sandboxed DSH session — the launched process inherits the sandbox and `~/.ssh` writes fail loudly).

## Configuration

Override by id from the profile's `cordis.patch.yml` (defaults shown):

```yaml
- id: dsh-container-lifecycle
  config:
    alias: dsh-container      # container name + ssh Host alias
    image: dsh-container-sshd:a1
    port: 2223                # loopback host port for sshd
    aptMirror: ""             # e.g. mirrors.tuna.tsinghua.edu.cn (first-use build only)
    workspace: ""             # default: process working directory (bind-mounted at the identical path)
    imageRebind: false        # one-shot deliberate re-pin after an intentional rebuild
```

Port collisions fail loudly with a named error naming the config knob. A rebuilt image under the same tag is refused with both digests; set `imageRebind: true` once to adopt the new digest (the container is then recreated — adopting into an old container would run old bytes).

## Supported versions

| Component | This release pins | Notes |
|---|---|---|
| DeepSeek Harness runtime | `>=0.2.2-rc.1 <0.2.2-rc.2` (`engines.dsh`) | Tested on 0.2.2-rc.1, macOS arm64 + Docker Desktop |
| ssh family (`@deepseek-ai/dsh-ssh`, `-subprocess-ssh`, `-sandbox-ssh`, `-fs-ssh`) | exact `0.2.2-rc.1` | The rc.2 peers are runtime-incompatible with an rc.1 host; exact pins keep the supported range honest |
| helper closure (14 family packages, resolved from this plugin's own deps) | exact `0.2.2-rc.1` | Same versions host- and container-side; SHA-256-verified in-container |
| `@deepseek-ai/cordis` | exact `4.1.0` | |
| Container base image | `node:24-bookworm-slim` (built at first use) | glibc 2.36 ≥ the 2.28 baseline |

Version policy: each new DSH release gets a pin bump + a re-run of the gate checks (install → session in container → adopt after restart → drift refusal) before the supported range widens. `0.2.2-rc.2` is deliberately excluded (family peer mismatch on an rc.1 runtime).

## Design & evidence

- Companion plugin (optional, recommended for container worlds): [dsh-docker-policy-ceiling](https://github.com/FAKE0704/dsh-docker-policy-ceiling) — keeps the sandbox mode ceiling at `workspace-write` even under ssh transports.
- `evidence/` — repro scripts for the upstream-relevant loader timing finding (service cascade after runtime `ctx.plugin()` insertion).
- The trust chain (digest pin / host-key pin / helper hash / `BatchMode` + `StrictHostKeyChecking` hard-coded) is deliberately not configurable.

## License

MIT. Independent community plugin; not affiliated with or endorsed by DeepSeek. "DeepSeek Harness" and the package names beginning `@deepseek-ai/` belong to their upstream owners.
