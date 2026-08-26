# dsh-ssh-remote
> 📖 [English](README.md)


DeepSeek Harness (DSH) 的 SSH 远程工作区插件——**多机并行版**：管理多台服务器、**同时保持多个 SSH 连接**，在每台上选择远程工作区，Agent 可直接查看 / 编辑 / 执行远程文件。

> 适配版本：**`@deepseek-ai/dsh@0.1.1-rc.2`**（profile 上运行的 DSH Web）

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
| 新增工具 | — | `rw_switch`（切换 current）、`rw_disconnect`（断开指定机） |
| rc.2 适配 | ❌ peerDeps 仍为 `^0.1.0-rc.6`，装上会破坏 scope 链 | ✅ 按 rc.2 **用户 preset** 挂载，进入 agent scope，不破坏核心功能 |

### 贡献归属

- 底层 SSH 引擎、SFTP 同步、机器注册表、多数 `rw_*` 工具与前端设置面板：来自 **flymysql/dsh-remote**
- 多池并行改造、`machineId` 参数、`rw_switch`、rc.2 preset 适配：本仓库（cslht11）的增量修改
- 上游如有新版本，欢迎优先参考上游变更并合并：<https://github.com/flymysql/dsh-remote>

### vendored 组件（`vendor/` 目录）

本仓库同时收录了 **chenw2759-wq/dsh-IDE**（BSD-3-Clause）的两个已构建包，用于在同一个安装里提供 IDE 风格右侧面板与 SSH 引擎：

| 目录 | 包名 | 来源 | 协议 |
|---|---|---|---|
| `vendor/dsh-aionui-panel` | `@deepseek-ai/dsh-client-ui-aionui-panel` | [chenw2759-wq/dsh-IDE](https://github.com/chenw2759-wq/dsh-IDE) | BSD-3-Clause |
| `vendor/dsh-ssh` | `@deepseek-ai/dsh-ssh` | [chenw2759-wq/dsh-IDE](https://github.com/chenw2759-wq/dsh-IDE) | BSD-3-Clause |

说明：
- `dsh-aionui-panel` 提供右侧面板（文件树 / 预览 / 编辑 / 终端 / diff）。其面板设计参考 [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)（Apache-2.0）重新实现，详见其 LICENSE。
- `dsh-ssh` 提供 SSH 引擎（连接池、隧道、网页终端）与 `ssh_*` agent 工具。
- 每个 vendored 目录都保留了 dsh-IDE 原始的 BSD-3-Clause LICENSE。完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

与主插件一起安装：

```bash
dsh plugin --profile web add file:$(pwd)/vendor/dsh-aionui-panel
dsh plugin --profile web add file:$(pwd)/vendor/dsh-ssh
```

---

## ✨ 功能

- **多机 SSH 注册表**：任意多台服务器（host/port/user + 密码或私钥 + 口令），存于 `~/.dsh/remote-workspaces/machines.json`
- **同时连接多台**：每台机器独立连接池，互不干扰
- **远程工作区**：为每台机器选择远程目录（自动补全/浏览），本地镜像 `~/.dsh/remote-workspaces/<host>/...`
- **双向 SFTP 同步**：`rw_sync`（远程→镜像）、`rw_push`（镜像→远程）
- **Agent 远程操作工具**（`rw_*` 系列）：
  - `rw_info` — 查看**全部**已注册机器及连接状态、当前工作区
  - `rw_connect` / `rw_switch` — 注册 / 连接 / 切换机器
  - `rw_pick_workspace` — 为指定机器设置远程工作区目录
  - `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_exec` — 浏览、读、写、执行远程文件/命令
  - `rw_sync` / `rw_push` — 远程↔本地镜像 双向 SFTP 同步
  - `rw_disconnect` — 断开指定机器（其他机器不受影响）
- **设置面板**：Settings → 远程工作区（多机增删改查、当前机、测试连接）

---

## 🚀 安装（一键脚本，推荐）

适配 DSH **0.1.1-rc.2**。在一台装好 DSH 的机器上，只需三步：

```bash
# 1) 克隆本项目
git clone https://github.com/cslht11/dsh-ssh-remote.git
cd dsh-ssh-remote

# 2) 一键安装（自动装依赖 + 注册 symlink + 创建 SSH 增强预设）
bash install.sh

# 3) 重启 DSH
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```

然后重启 DSH、打开 DSH Web → **新建会话 → 选你平时用的模式即可**（standard / code / minimal / cordis 都已内置 `rw_*` 工具，无需切换新模式）。

> **install.sh 自动做了什么：**
> 1. 定位 DSH 全局安装目录（`npm root -g`）
> 2. 在本仓库目录安装依赖（ssh2 / schemastery 等），使插件自包含
> 3. 将插件 symlink 到 `~/.dsh/profiles/web/node_modules/dsh-ssh-remote`（让 preset 的 bare name 可解析）
> 4. **增强每个官方模式**：对 standard / code / minimal / cordis 各建**同名用户 preset**（首次复制官方原版 agent.cordis.yml + preset.yml，再追加 dsh-ssh-remote 插件行；first-root-wins：用户 preset 覆盖官方，模式名不变）——SSH 工具直接出现在你现有的每个模式里
> 5. 移除旧的「SSH 增强模式」（首个版本遗留，现已不需要单独模式）
>
> 脚本幂等：重复运行不会重复添加；卸载用 `bash install.sh --uninstall`（会从各模式移除 SSH 行并删除 symlink）。

---

## 🛠 手动安装（想自己控制每一步时）

与 `install.sh` 等价，分步如下：

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
ln -sfn "$PWD" ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
```

### 第 3 步：增强每个官方模式（SSH 工具加入现有模式）
对你要用的每个模式（standard / code / minimal / cordis）逐个执行：把官方 preset 复制到用户 preset 目录 `~/.dsh/.agent-presets/<模式名>/`，再追加插件行。以全部四个为例：
```bash
GLOBAL_ROOT=$(npm root -g)
for p in standard code minimal cordis; do
  mkdir -p ~/.dsh/.agent-presets/$p
  # 首次：复制官方原版（之后保留，不覆盖）
  [ -f ~/.dsh/.agent-presets/$p/agent.cordis.yml ] || \
    cp "$GLOBAL_ROOT/@deepseek-ai/dsh/config/agent-presets/$p/agent.cordis.yml" \
       ~/.dsh/.agent-presets/$p/agent.cordis.yml
  [ -f ~/.dsh/.agent-presets/$p/preset.yml ] || \
    cp "$GLOBAL_ROOT/@deepseek-ai/dsh/config/agent-presets/$p/preset.yml" \
       ~/.dsh/.agent-presets/$p/preset.yml
  # 追加 SSH 插件行（幂等）
  grep -q "name: 'dsh-ssh-remote'" ~/.dsh/.agent-presets/$p/agent.cordis.yml || \
    cat >> ~/.dsh/.agent-presets/$p/agent.cordis.yml << 'EOF'

# ── SSH 远程工作区（dsh-ssh-remote 插件）───────────────────────────────────
- id: ssh-remote
  name: 'dsh-ssh-remote'
  config: {}
EOF
done
```
> 原理与 `install.sh` 第 4 步一致：用户 preset 与官方**同名**（first-root-wins 覆盖），模式名不变、工具自动多一组。

### 第 4 步：重启
```bash
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```
打开 DSH Web → 新会话直接选你平时用的模式（standard / code / minimal / cordis 任选，均已含 `rw_*` 工具）。

---

## 🛠 使用示例

### 对话方式（模型直接驱动 SSH）

```
我在 192.168.1.10 和 192.168.1.20 有两台服务器，帮我：
1. rw_connect 添加 192.168.1.10（root，密钥 /Users/me/.ssh/id_rsa）
2. rw_connect 添加 192.168.1.20（root，密码 xxx）
3. rw_pick_workspace (machineId=<第一台id>, path=/srv/app)
4. rw_exec (machineId=<第一台id>, command='docker compose ps')
5. rw_list_dir (machineId=<第一台id>, path=/srv/app) 看文件
6. rw_read_file (machineId=<第一台id>, path=/srv/app/src/main.py)
7. rw_write_file (machineId=<第一台id>, path=/srv/app/config.yml, content='...')
8. rw_sync (machineId=<第一台id>) 把远程工作区镜像到本地 ~/.dsh/remote-workspaces/
```

### 工具一览（都支持 `machineId` 指定目标机，不传 = 当前机）

| 工具 | 作用 |
|---|---|
| `rw_info` | 查看**全部**已注册机器及连接状态、当前工作区 |
| `rw_connect` | 注册/连接一台机器（新机器传 host/user/password/privateKeyPath） |
| `rw_switch` | 切换当前机器（后续不传 machineId 时默认用它） |
| `rw_pick_workspace` | 为指定机器设置远程工作区目录 |
| `rw_list_dir` / `rw_read_file` | 浏览 / 读取远程文件 |
| `rw_write_file` | 直接写远程文件（自动建父目录） |
| `rw_exec` | 在远程执行 shell 命令 |
| `rw_sync` / `rw_push` | 远程↔本地镜像 双向 SFTP 同步 |
| `rw_disconnect` | 断开指定机器（其他机器不受影响） |

### 设置面板方式

浏览器 DSH Web → **设置 → 远程工作区**：增删改查机器、测试连接、切换当前机。

---

## 🔄 适配其他 DSH 版本 / 其他设备

**本插件适配 `@deepseek-ai/dsh@0.1.1-rc.2`**（以 `~/.dsh/.agent-presets/` 下**同名用户 preset 覆盖**机制挂载进现有模式）。换到其他版本时：

1. **DSH 官方升级后**：通常 preset 机制不变，`bash install.sh --uninstall && bash install.sh` 重装即可（脚本幂等，会检测版本）。
2. **其他设备部署**：任意机器上 `git clone` → `bash install.sh` → 重启 DSH 即可，无需手动复制任何文件（依赖、symlink、preset 全部自动完成）。
3. **多台机器**：插件的机器注册表存在 `~/.dsh/remote-workspaces/machines.json`，每台设备独立维护；如需多设备共享同一批机器，可手动把该文件复制到新设备。

---

## ↩️ 卸载

```bash
# 一键卸载（推荐）
bash install.sh --uninstall

# 或手动：删除 symlink，再从各模式 preset 移除 SSH 插件行
rm -f ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
# 然后用编辑器在各 ~/.dsh/.agent-presets/<模式名>/agent.cordis.yml 中删除
# 末尾的「SSH 远程工作区」插件块；模式本身保留（其余行是官方原版）
```

---

## 🔗 相关

- 补丁集仓库（输入历史 + 编辑重发）：<https://github.com/cslht11/dsh-custom-patches>
- 上游 dsh-remote：<https://github.com/flymysql/dsh-remote>
- DeepSeek Harness 官方：<https://github.com/deepseek-ai/deepseek-harness>
