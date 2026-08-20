# dsh-ssh-remote

DeepSeek Harness (DSH) 的 SSH 远程工作区插件——**多机并行版**：管理多台服务器、**同时保持多个 SSH 连接**，在每台上选择远程工作区，Agent 可直接查看 / 编辑 / 执行远程文件。

> 适配版本：**`@deepseek-ai/dsh@0.1.0-rc.8`**（profile 上运行的 DSH Web）

---

## 📌 上游项目与版权声明

### 本项目是 `dsh-remote` 的 fork + 改造

本项目基于以下开源项目开发（**非完全原创**），遵守其 **MIT License**：

- **上游原版**：[flymysql/dsh-remote](https://github.com/flymysql/dsh-remote)
- **npm 包**：[`dsh-remote`](https://www.npmjs.com/package/dsh-remote)
- **上游作者**：flymysql（<flyphp@outlook.com>）
- **上游版本**：`0.5.10` → 本仓库 `0.6.0`
- **许可**：MIT License，版权见 [LICENSE](LICENSE)（`Copyright (c) 2026 dsh-remote contributors`）

### 本仓库的改造内容

| 维度 | 上游 dsh-remote | 本仓库 dsh-ssh-remote |
|---|---|---|
| 连接模型 | **单连接池**（切换机器时断开旧连接） | **多池并行**（每台机器独立 SshPool，可同时连接） |
| 目标选择 | 仅 current 机 | 所有工具/路由支持 `machineId` 参数（不传 = current 机） |
| 状态查看 | 单机状态 | `rw_info` / `/dsh-ssh-remote/status` 列出**全部机器**及各自连接状态 |
| 新增工具 | — | `rw_switch`（切换 current）、`rw_disconnect(指定机)` |
| rc.8 适配 | ❌ peerDeps 仍为 `^0.1.0-rc.6`，装上会破坏 scope 链 | ✅ 按 rc.8 **用户 preset** 挂载，进入 agent scope，不破坏核心功能 |

### 贡献归属

- 底层 SSH 引擎、SFTP 同步、机器注册表、多数 `rw_*` 工具与前端设置面板：来自 **flymysql/dsh-remote**
- 多池并行改造、`machineId` 参数、`rw_switch`、rc.8 preset 适配：本仓库（cslht11）的增量修改
- 上游如有新版本，欢迎优先参考上游变更并合并：<https://github.com/flymysql/dsh-remote>

---

## ✨ 功能

- **多机 SSH 注册表**：任意多台服务器（host/port/user + 密码或私钥 + 口令），存于 `~/.dsh/remote-workspaces/machines.json`
- **同时连接多台**：每台机器独立连接池，互不干扰
- **远程工作区**：为每台机器选择远程目录（自动补全/浏览），本地镜像 `~/.dsh/remote-workspaces/<host>/...`
- **双向 SFTP 同步**：`rw_sync`（远程→镜像）、`rw_push`（镜像→远程）
- **Agent 远程操作工具**（`rw_*` 系列）：
  - `rw_info` — 查看全部机器状态 + 当前工作区
  - `rw_connect` / `rw_switch` — 注册 / 连接 / 切换机器
  - `rw_pick_workspace` — 为指定机器设置远程工作区
  - `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_exec` — 浏览、读、写、执行远程文件/命令
  - `rw_sync` / `rw_push` — 远程↔本地镜像同步
  - `rw_disconnect` — 断开指定机器（其他机器不受影响）
- **设置面板**：Settings → 远程工作区（多机增删改查、当前机、测试连接）

---

## 🚀 安装（rc.8 正确方式）

rc.8 要求工具插件通过 **用户 preset** 挂载进 agent scope，而不是直接塞 profile bundle。

### 第 1 步：克隆并安装插件依赖

```bash
git clone https://github.com/cslht11/dsh-ssh-remote.git
cd dsh-ssh-remote
npm install --no-save     # 安装 ssh2 / schemastery 等依赖
```

### 第 2 步：注册进 profile 的 node_modules

让 preset 的 bare name `dsh-ssh-remote` 能被解析（baseUrl = profile 目录）：

```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn "$(pwd)" ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
```

### 第 3 步：创建用户 preset（挂载插件进 agent scope）

```bash
mkdir -p ~/.dsh/.agent-presets/ssh-enhanced
cp config/agent-presets/standard/agent.cordis.yml ~/.dsh/.agent-presets/ssh-enhanced/ 2>/dev/null \
  || npm root -g >/dev/null 2>&1
```

（若上面没复制到，从 DSH 安装目录拿官方 standard preset 作为 base：）

```bash
DSH_PKG=$(node -e "console.log(require('@deepseek-ai/dsh/package.json').replace('/package.json',''))")
cp "$DSH_PKG/config/agent-presets/standard/agent.cordis.yml" ~/.dsh/.agent-presets/ssh-enhanced/
```

然后在 `~/.dsh/.agent-presets/ssh-enhanced/agent.cordis.yml` 末尾追加：

```yaml
# ── SSH 远程工作区 ──────────────────────────────────────────────────────────
- id: ssh-remote
  name: 'dsh-ssh-remote'
  config: {}
```

再创建元数据 `~/.dsh/.agent-presets/ssh-enhanced/preset.yml`：

```yaml
name: SSH 增强模式
description: 标准编码 Agent + 多机 SSH 远程工作区。
order: 50
```

### 第 4 步：重启并选择 preset

```bash
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```

浏览器打开 DSH Web → 新会话的 **模型/预设选择** 里选 **「SSH 增强模式」**，即可使用 `rw_*` 工具。

---

## 🛠 使用示例

```
我在 192.168.1.10 和 192.168.1.20 有两台服务器，帮我：
1. rw_connect 添加 192.168.1.10（root，密钥 /Users/me/.ssh/id_rsa）
2. rw_connect 添加 192.168.1.20（root，密码 xxx）
3. rw_pick_workspace (machineId=第一台, path=/srv/app) 
4. rw_exec (machineId=第一台, command='docker compose ps')
5. rw_list_dir 看 /srv/app 的文件
```

---

## ↩️ 卸载

```bash
rm -rf ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
rm -rf ~/.dsh/.agent-presets/ssh-enhanced
```

---

## 🔗 相关

- 补丁集仓库（输入历史 + 编辑重发）：<https://github.com/cslht11/dsh-custom-patches>
- 上游 dsh-remote：<https://github.com/flymysql/dsh-remote>
- DeepSeek Harness 官方：<https://github.com/deepseek-ai/deepseek-harness>