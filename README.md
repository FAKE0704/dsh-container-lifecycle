# dsh-container-lifecycle

Stage A 容器执行世界的生命周期插件（设计：`container-provider-design/design.md` §4）。

一个插件拥有连接的全部前提，不碰任何 seam：镜像 digest 钉定（漂移拒用）→ 有标签容器（sshd 入口 / 同路径 bind-mount / 仅回环端口 / 宿主 uid 映射）→ helper 闭包注入与 SHA-256（缓存化，重生秒级）→ 临时 host key 钉入插件自有 known_hosts → `~/.ssh/config` 托管块（BEGIN/END 标记，幂等替换）→ 运行时插入原版 `dsh-ssh` 连接行（helperHash 由实际工件计算，不做模板渲染）。

## 已知边界（如实）

- **桌面/CLI（Electron 宿主）流通道不可用**：上游 BoringSSL 缺 TLS1.2 PSK 套件（A0 F1，见 #9120 讨论）。headless 会话请用纯 OpenSSL node 宿主启动；修复前这是硬边界。
- headless CLI 的启动进程需具备 `~/.ssh/config` 写权限（用户终端或桌面宿主满足；从沙箱化 agent 会话内启动会被拒，fail-loud）。
- 版本走廊：dsh `>=0.2.2-rc.1 <0.2.2-rc.2`，ssh 家族精确锁 `0.2.2-rc.1`。

## 沙箱模式语义（与 dsh-docker-policy-ceiling 组合时）

默认不装天花 = **跟随上游 ssh 语义**：`danger-full-access` 在容器内裸跑（不包装 argv），容器边界不因此扩大。装上 `dsh-docker-policy-ceiling` 则**比上游更严**——resolve 层拒绝该模式，单布尔 `allowDangerFullAccess` 恢复上游语义。详见该插件 README（设计 §6.2）。

状态：A1（核心生命周期）+ A2（ceiling 组合）已完成，A3 前不发布。进度与证据见 `container-provider-design/a1/A1-RESULTS.md` 与 `a2/A2-RESULTS.md`。
