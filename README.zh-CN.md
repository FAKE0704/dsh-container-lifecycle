# dsh-container-lifecycle（中文说明）

[English README](./README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区插件：让一个 profile 的 shell、文件系统和沙箱服务不再直接跑在你的机器上，而是在一个由本插件全程管理的 Docker 容器里运行。

整条连接链路由这一个插件负责：镜像按 digest 锁定 → 创建带标签的容器（sshd / 相同路径挂载 / 端口仅绑定 127.0.0.1 / 宿主用户 ID 映射）→ 注入 helper 依赖包并计算哈希 → 容器启动时生成的临时主机密钥写入插件自有的 `known_hosts` → 托管 `~/.ssh/config` 配置块 → 最后在运行时以算好的 helper 哈希插入原版 `dsh-ssh` 连接。不修改任何上游代码，也不代理任何流量——ssh 传输用的就是未经改动的上游包。

> **状态：实验性（Stage A）。** 独立作者的社区插件——不属于 DeepSeek Harness，未经 DeepSeek 团队审查或背书。只在一个 DSH 版本上测过（见[版本兼容范围](#版本兼容范围)）。

> ⚠️ **桌面端限制（上游缺陷，如实说明）：** DSH 的 Electron 宿主（桌面应用及其 CLI）目前无法建立 dsh-ssh 的流式连接——Electron 内置的 BoringSSL 缺少传输层协商所需的 TLS 1.2 PSK 加密套件（[上游讨论 #9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)）。在这些宿主上，本插件会遇到与其它 dsh-ssh 用法完全相同的问题。目前验证可用的宿主是用普通 OpenSSL Node 启动的 headless CLI（配方见英文 README）。如果上游补上这些加密套件，桌面端无需任何改动即可使用。

## 功能

- 真实 agent 会话的 `bash` / `fs` 工具在**镜像已锁定的 Debian 容器**内执行；你的工作区以**完全相同的路径**挂载进容器（宿主上的 `/Users/you/work`，在容器内就是同一个路径）。
- 重启自动恢复：容器带专属标签，宿主重启后被自动接管复用；临时主机密钥自动重新锁定。
- 防镜像漂移：镜像按 digest 锁定（从仓库拉取的用 repo digest，本地构建的用镜像 ID）；同一标签的镜像被重建后会**拒绝启动**，报错同时给出新旧两个 digest 和明确的重新绑定方法。helper **入口文件**按 SHA-256 记录哈希并在每次加载时复核；其依赖包整体按精确版本锁定、在容器内安装。
- 两个以只读为主的工具：`container-status`（查看锁定 / 容器 / helper / ssh 配置块的状态）、`container-dispose`（需审批确认后才执行的清理）。
- 首次使用自动构建：镜像标签不存在时，自动用内置的 `docker/Dockerfile` 构建（apt 镜像源可配置）并锁定构建结果。

## 安装（已验证路径：headless CLI）

在 macOS（Docker Desktop）上端到端验证过。`DSH_HOME` 默认为 `~/.dsh`；下面的 profile 名为 `headless`，首次使用会自动套用 headless 模板。

三步流程（准备 profile → 安装 → 启动会话）与英文 README 完全一致，中文用户注意：

- 第 1 步粘贴块里的 `cordis.patch.yml` 写你自己的模型配置（provider / model）。
- `allowBuilds: false` 三项是刻意为之：原生模块（`node-pty` / `koffi` / `dsh-subprocess-local`）**只在容器内构建**，从不在宿主上构建——否则 pnpm 11 会把被拦截的构建脚本当作安装失败。
- 首次启动会构建镜像（需要能拉取 `node:24-bookworm-slim` 基础镜像）、创建容器、在容器内安装 helper、写入托管的 ssh 配置块；第一次要几分钟，之后都在秒级。
- 国内网络可在配置里加 `aptMirror: mirrors.tuna.tsinghua.edu.cn`（只影响首次构建）。
- 完整的会话实录（真实会话在容器内自证运行环境）见英文 README「Verified transcript」一节。

## 配置（默认值）

```yaml
- id: dsh-container-lifecycle
  config:
    alias: dsh-container      # 容器名 + ssh Host 别名
    image: dsh-container-sshd:a1
    port: 2223                # sshd 绑定的回环端口（仅 127.0.0.1）
    aptMirror: ""             # 如 mirrors.tuna.tsinghua.edu.cn（仅首次构建）
    workspace: ""             # 默认为进程工作目录（按相同路径挂载）
    imageRebind: false        # 故意重建镜像后的一次性重新锁定
```

端口被占用时会报出指明配置项的专属错误。同一标签的镜像被重建后会被拒绝启动并给出两个 digest；将 `imageRebind` 设为 `true` 一次即可采纳新 digest（容器会随之重建——沿用旧容器会执行旧代码）。

## 版本兼容范围

| 组件 | 本版本锁定 | 说明 |
|---|---|---|
| DSH 运行时 | `>=0.2.2-rc.1 <0.2.2-rc.2`（`engines.dsh`） | 在 0.2.2-rc.1、macOS arm64 + Docker Desktop 上实测 |
| ssh 系列（`@deepseek-ai/dsh-ssh`、`-subprocess-ssh`、`-sandbox-ssh`、`-fs-ssh`） | 精确 `0.2.2-rc.1` | rc.2 的 peer 依赖与 rc.1 运行时不兼容；精确锁定保证版本诚实 |
| helper 依赖包（13 个 dsh 系列包 + cordis，从本插件自身依赖解析） | 精确锁定（系列包 `0.2.2-rc.1`、cordis `4.1.0`） | 宿主与容器内版本一致；容器内对入口文件按 SHA-256 复核 |
| `@deepseek-ai/cordis` | 精确 `4.1.0` | |
| 容器基础镜像 | `node:24-bookworm-slim`（首次使用时构建） | glibc 2.36 ≥ 基线 2.28 |

版本策略：DSH 每发布一个新版本，先更新锁定、重跑一遍既定检查（安装 → 容器内会话 → 重启接管 → 拒绝漂移镜像），再放宽兼容范围。`0.2.2-rc.2` 被刻意排除（rc.1 运行时上的 peer 依赖不匹配）。

## 设计与佐证

- 配套插件（可选，容器环境推荐）：[dsh-docker-policy-ceiling](https://github.com/FAKE0704/dsh-docker-policy-ceiling)——即使走 ssh 传输，也把沙箱权限上限保持在 `workspace-write`。
- `evidence/` 目录：与上游相关的加载器时序问题（运行时 `ctx.plugin()` 插入后的服务级联）复现脚本。
- 信任链（digest 锁定 / 主机密钥锁定 / helper 哈希 / `BatchMode` + `StrictHostKeyChecking`——这两个 ssh 开关来自本插件锁定的原版 dsh-ssh 命令行）刻意**不开放配置**——安全边界不因配置而松动。

## 许可

MIT。独立社区插件；与 DeepSeek 无隶属关系、未获其背书。「DeepSeek Harness」及 `@deepseek-ai/` 前缀的包名归上游所有。
