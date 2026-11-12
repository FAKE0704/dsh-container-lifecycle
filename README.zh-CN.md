# dsh-container-lifecycle（中文说明）

[English README](./README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区插件：把一个 profile 变成**容器执行世界**——profile 的 shell、文件系统、沙箱服务不再跑在你的机器上，而是跑在一个由本插件全权管理的 Docker 容器里。

一个插件 owning 整条连接链：镜像 digest 钉定 → 带标签容器（sshd / 同路径 bind mount / 仅回环端口 / 宿主 uid 映射）→ helper 闭包注入并哈希 → 临时 host key 钉进插件自有的 `known_hosts` → `~/.ssh/config` 托管块 → 运行时以算好的 helper 哈希插入原版 `dsh-ssh` 连接行。**不碰任何上游接缝，不做任何代理**——ssh 传输插件就是未经修改的上游包。

> **状态：实验性（Stage A）。** 独立作者的社区插件——不属于 DeepSeek Harness，未经 DeepSeek 团队审查或背书。只在一个 DSH 版本上测过（见[版本走廊](#版本走廊)）。

> ⚠️ **桌面端限制（上游缺陷，如实说明）：** DSH 的 Electron 宿主（桌面应用及其 CLI 载体）目前无法承载 dsh-ssh 流——Electron 的 BoringSSL 缺少传输协商所需的 TLS 1.2 PSK 密码套件（[上游讨论 #9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)）。在这些宿主上，本世界会退化成与任何 dsh-ssh 用法相同的样子。当前验证过的宿主是**纯 OpenSSL Node 驱动的 headless CLI**（配方见英文 README）。若上游补上该密码套件，桌面端无需任何改动即可工作。

## 你会得到什么

- 真实 agent 会话的 `bash`/`fs` 工具在**钉定的 Debian 容器内**执行，工作区以**完全相同的路径** bind-mount 进容器（同路径投影）。
- 重启韧性：容器带标签，宿主重启后被**收养**；临时 host key 自动重钉。
- 拒绝漂移的信任链：镜像按 digest 钉定（拉取的用 repo digest，本地构建的用 image ID）；同标签重建的镜像会被**拒绝**，报出两个 digest 与明确的 rebind 路径。helper 闭包按 SHA-256 钉定并在容器内复验。
- 两个以只读为主的工具：`container-status`（pin/容器/helper/ssh 块事实）、`container-dispose`（审批门后的拆除）。
- 首用**自动构建**：镜像标签缺失时，用内置 `docker/Dockerfile` 构建（apt 镜像源可配）并钉定结果。

## 安装（已验证路径：headless CLI）

在 macOS（Docker Desktop）上端到端验证。`DSH_HOME` 默认 `~/.dsh`。三步（粘贴块、安装、启动）与实测转录见英文 README；中文用户只需注意：

- 第 1 步粘贴块里的 `cordis.patch.yml` 写你自己的模型接线（provider/model）。
- `allowBuilds: false` 三项是刻意的：native 模块（`node-pty`/`koffi`/`dsh-subprocess-local`）**在容器内构建**，从不在宿主上构建——否则 pnpm 11 会把被拦的构建脚本当作 `add` 失败。
- 首次启动会构建镜像（需要能拉取 `node:24-bookworm-slim`）、创建容器、在容器内装 helper、写托管 ssh 块；首次约几分钟，之后秒级。
- 国内网络可在 patch 里加 `aptMirror: mirrors.tuna.tsinghua.edu.cn`（仅影响首次构建）。

## 配置（默认值）

```yaml
- id: dsh-container-lifecycle
  config:
    alias: dsh-container      # 容器名 + ssh Host 别名
    image: dsh-container-sshd:a1
    port: 2223                # sshd 的回环宿主端口
    aptMirror: ""             # 如 mirrors.tuna.tsinghua.edu.cn（仅首用构建）
    workspace: ""             # 默认：进程工作目录（按同路径 bind-mount）
    imageRebind: false        # 故意重建镜像后的一次性重钉
```

端口冲突会以具名错误报出并指明配置项。同标签重建镜像会被拒绝并给出两个 digest；设 `imageRebind: true` 一次以采纳新 digest（容器随之重建——收养旧容器会跑旧字节）。

## 版本走廊

| 组件 | 本版钉定 | 说明 |
|---|---|---|
| DSH 运行时 | `>=0.2.2-rc.1 <0.2.2-rc.2`（`engines.dsh`） | 在 0.2.2-rc.1、macOS arm64 + Docker Desktop 上实测 |
| ssh family（`@deepseek-ai/dsh-ssh`、`-subprocess-ssh`、`-sandbox-ssh`、`-fs-ssh`） | 精确 `0.2.2-rc.1` | rc.2 peers 与 rc.1 运行时不兼容；精确钉定保证走廊诚实 |
| helper 闭包（14 个 family 包，从本插件自身依赖解析） | 精确 `0.2.2-rc.1` | 宿主与容器同版；容器内按 SHA-256 复验 |
| `@deepseek-ai/cordis` | 精确 `4.1.0` | |
| 容器基础镜像 | `node:24-bookworm-slim`（首用时构建） | glibc 2.36 ≥ 基线 2.28 |

走廊政策：每个新 DSH 版本先钉定 + 重跑门检查（安装 → 容器内会话 → 重启收养 → 拒漂移）再放宽走廊。`0.2.2-rc.2` 被刻意排除（rc.1 运行时上的 family peer 不匹配）。

## 设计与证据

- 伴生插件（可选，容器世界推荐）：[dsh-docker-policy-ceiling](https://github.com/FAKE0704/dsh-docker-policy-ceiling)——ssh 传输下仍把沙箱模式天花保持在 `workspace-write`。
- `evidence/`——上游相关的 loader 时序发现（运行时 `ctx.plugin()` 插入后的服务级联）复现脚本。
- 信任链（digest 钉定 / host key 钉定 / helper 哈希 / 硬编码 `BatchMode` + `StrictHostKeyChecking`）刻意**不做**配置面。

## 许可

MIT。独立社区插件；与 DeepSeek 无隶属关系、未获其背书。「DeepSeek Harness」及 `@deepseek-ai/` 前缀的包名归上游所有。
