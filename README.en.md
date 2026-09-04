# dsh-ssh-remote
> 📖 [中文版](README.md)


DeepSeek Harness (DSH) SSH Remote Workspace Plugin — **multi-machine parallel edition**: manage multiple servers, **maintain multiple SSH connections simultaneously**, pick a remote workspace on each, and let your Agent directly view / edit / execute remote files.

> Target version: **`@deepseek-ai/dsh@0.1.2-rc.1` (latest)** (DSH Web running on profile). Older DSH versions (0.1.1-rc.2 etc.) are also supported — see "Adapting to Other DSH Versions".

---

## 📌 Upstream & Copyright

### This project is a fork + modification of `dsh-remote`

This project is built on the following open-source project (**not entirely original**), under **MIT License**:

- **Upstream original**: [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote)
- **npm package**: [`dsh-remote`](https://www.npmjs.com/package/dsh-remote)
- **Upstream author**: flymysql (<flyphp@outlook.com>)
- **Upstream version**: `0.5.10` → this repo `0.6.0`
- **License**: MIT License, copyright in [LICENSE](LICENSE) (`Copyright (c) 2026 dsh-remote contributors`)

### What this repo changes

| Dimension | Upstream dsh-remote | This repo dsh-ssh-remote |
|---|---|---|
| Connection model | **Single connection pool** (disconnects old connection when switching machines) | **Multi-pool parallel** (each machine has its own SshPool, simultaneous connections) |
| Target selection | Current machine only | All tools/routes support `machineId` parameter (omitted = current machine) |
| Status view | Single machine status | `rw_info` / `/dsh-ssh-remote/status` lists **all machines** and their connection status |
| New tools | — | `rw_switch` (switch current), `rw_disconnect` (disconnect specific machine) |
| rc.2 compatibility | ❌ peerDeps still `^0.1.0-rc.6`, breaks scope chain when installed | ✅ Mounted via rc.2 **user preset**, enters agent scope without breaking core functionality |

### Contribution attribution

- Underlying SSH engine, SFTP sync, machine registry, most `rw_*` tools, and frontend settings panel: from **flymysql/dsh-remote**
- Multi-pool parallel refactor, `machineId` parameter, `rw_switch`, rc.2 preset adaptation: incremental changes by this repo (chai1110)
- When upstream publishes new versions, we优先参考上游变更并合并: <https://github.com/flymysql/dsh-remote>

### Vendored components (under `vendor/`)

This repo also vendors two built packages from **chenw2759-wq/dsh-IDE** (BSD-3-Clause), to deliver the IDE-style right panel and the SSH engine in the same installation:

| Directory | Package | Origin | License |
|---|---|---|---|
| `vendor/dsh-aionui-panel` | `@deepseek-ai/dsh-client-ui-aionui-panel` | [chenw2759-wq/dsh-IDE](https://github.com/chenw2759-wq/dsh-IDE) | BSD-3-Clause |
| `vendor/dsh-ssh` | `@deepseek-ai/dsh-ssh` | [chenw2759-wq/dsh-IDE](https://github.com/chenw2759-wq/dsh-IDE) | BSD-3-Clause |

Notes:
- `dsh-aionui-panel` provides the right-side panels (file tree / preview / editor / terminal / diff). Its panel design references [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) (Apache-2.0), re-implemented — see its LICENSE.
- `dsh-ssh` provides the SSH engine (connection pool, tunnels, web terminal) and the `ssh_*` agent tools.
- Each vendored directory keeps its original BSD-3-Clause LICENSE from dsh-IDE. Full notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Install them alongside this plugin:

```bash
dsh plugin --profile web add file:$(pwd)/vendor/dsh-aionui-panel
dsh plugin --profile web add file:$(pwd)/vendor/dsh-ssh
```

---

## ✨ Features

- **Multi-machine SSH registry**: Any number of servers (host/port/user + password or private key + passphrase), stored in `~/.dsh/remote-workspaces/machines.json`
- **Simultaneous multi-machine connections**: Each machine has an independent connection pool, no interference
- **Remote workspace**: Select a remote directory per machine (auto-complete/browse), local mirror at `~/.dsh/remote-workspaces/<host>/...`
- **Bidirectional SFTP sync**: `rw_sync` (remote → mirror), `rw_push` (mirror → remote)
- **Agent remote operation tools** (`rw_*` series):
  - `rw_info` — View all machines status + current workspace
  - `rw_connect` / `rw_switch` — Register / connect / switch machine
  - `rw_pick_workspace` — Set remote workspace directory for a specific machine
  - `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_exec` — Browse, read, write, execute remote files/commands
  - `rw_sync` / `rw_push` — Remote ↔ local mirror bidirectional SFTP sync
  - `rw_disconnect` — Disconnect specific machine (other machines unaffected)
- **Settings panel**: Settings → Remote Workspace (add/edit/delete machines, test connection, switch current machine)

---

## 🚀 Installation (one-click script, recommended)

Targets DSH **0.1.2-rc.1** (older 0.1.1-rc.2 etc. are also supported — see "Adapting to Other DSH Versions"). On a machine with DSH installed, three steps:

```bash
# 1) Clone this repo
git clone https://github.com/chai1110/dsh-ssh-remote.git
cd dsh-ssh-remote

# 2) One-click install (auto-installs deps + registers symlink + creates SSH-enhanced presets)
bash install.sh

# 3) Restart DSH
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```

Then restart DSH, open DSH Web → **new session → select your usual mode** (standard / code / minimal / cordis all have `rw_*` tools built-in, no mode switching needed).

> **What install.sh does automatically:**
> 1. Locates DSH global install dir (`npm root -g`)
> 2. Installs dependencies in this repo directory (ssh2 / schemastery), making the plugin self-contained
> 3. Symlinks the plugin to `~/.dsh/profiles/web/node_modules/dsh-ssh-remote` (so preset bare name resolves; baseUrl = profile dir)
> 4. **Enhances each official mode**: creates **same-named user presets** under `~/.dsh/.agent-presets/<mode>/` for standard / code / minimal / cordis (first-run copies official `agent.cordis.yml` + `preset.yml`, then appends dsh-ssh-remote plugin row; first-root-wins: user preset overrides official, mode name unchanged) — SSH tools appear directly in all your existing modes
> 5. Removes the old "SSH Enhanced Mode" (first version leftover, no longer needed as a separate mode)
>
> Script is idempotent: running again won't duplicate entries. Uninstall with `bash install.sh --uninstall` (removes SSH rows from each mode preset and deletes symlink).

---

### Alternative: Install via official DSH plugin command

This plugin also supports the standard DSH plugin system. Install it with `dsh plugin add`:

```bash
# 1) Clone this repo
git clone https://github.com/chai1110/dsh-ssh-remote.git
cd dsh-ssh-remote

# 2) Install via official plugin command
dsh plugin --profile web add file:$(pwd)

# 3) Restart DSH
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```

This method registers the plugin as a profile bundle (the same layer used by `dsh plugin add` for any DSH plugin). It automatically handles dependency resolution, and the plugin's front-end UI components (Settings → 远程工作区 panel) are loaded automatically.

To uninstall:
```bash
dsh plugin --profile web remove dsh-ssh-remote
```

---

## 🛠 Manual Installation (step-by-step)

Equivalent to `install.sh`, for users who want control:

### Step 1: Clone and install plugin dependencies
```bash
git clone https://github.com/chai1110/dsh-ssh-remote.git
cd dsh-ssh-remote
npm install --no-save     # installs ssh2 / schemastery etc.
```

### Step 2: Register into profile's node_modules
So the preset's bare name `dsh-ssh-remote` can be resolved (baseUrl = profile dir):
```bash
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn "$PWD" ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
```

### Step 3: Enhance each official mode (add SSH tools to existing modes)
For each mode you use (standard / code / minimal / cordis), copy the official preset to user preset dir `~/.dsh/.agent-presets/<mode>/`, then append the plugin row. Example for all four:
```bash
GLOBAL_ROOT=$(npm root -g)
for p in standard code minimal cordis; do
  mkdir -p ~/.dsh/.agent-presets/$p
  # First run: copy official original (preserve afterwards, don't overwrite)
  [ -f ~/.dsh/.agent-presets/$p/agent.cordis.yml ] || \
    cp "$GLOBAL_ROOT/@deepseek-ai/dsh/config/agent-presets/$p/agent.cordis.yml" \
       ~/.dsh/.agent-presets/$p/agent.cordis.yml
  [ -f ~/.dsh/.agent-presets/$p/preset.yml ] || \
    cp "$GLOBAL_ROOT/@deepseek-ai/dsh/config/agent-presets/$p/preset.yml" \
       ~/.dsh/.agent-presets/$p/preset.yml
  # Append SSH plugin row (idempotent)
  grep -q "name: 'dsh-ssh-remote'" ~/.dsh/.agent-presets/$p/agent.cordis.yml || \
    cat >> ~/.dsh/.agent-presets/$p/agent.cordis.yml << 'EOF'

# ── SSH Remote Workspace (dsh-ssh-remote plugin) ────────────────────────────
- id: ssh-remote
  name: 'dsh-ssh-remote'
  config: {}
EOF
done
```
> Same principle as `install.sh` step 4: user preset has the **same name** as official (first-root-wins override), mode name unchanged, tools automatically added.

### Step 4: Restart
```bash
kill $(pgrep -f 'dsh web') 2>/dev/null; dsh web
```
Open DSH Web → new session, select any mode you normally use (standard / code / minimal / cordis all now have `rw_*` tools).

---

## 🛠 Usage Examples

### Conversational mode (model-driven SSH)

```
I have two servers at 192.168.1.10 and 192.168.1.20, please:
1. rw_connect add 192.168.1.10 (root, key /Users/me/.ssh/id_rsa)
2. rw_connect add 192.168.1.20 (root, password xxx)
3. rw_pick_workspace (machineId=<first-id>, path=/srv/app)
4. rw_exec (machineId=<first-id>, command='docker compose ps')
5. rw_list_dir (machineId=<first-id>, path=/srv/app) to see files
6. rw_read_file (machineId=<first-id>, path=/srv/app/src/main.py)
7. rw_write_file (machineId=<first-id>, path=/srv/app/config.yml, content='...')
8. rw_sync (machineId=<first-id>) mirror remote workspace to local ~/.dsh/remote-workspaces/
```

### Tool reference (all support `machineId` to target specific machine; omit = current machine)

| Tool | Purpose |
|---|---|
| `rw_info` | View **all** registered machines, connection status, and current workspace |
| `rw_connect` | Register/connect a machine (pass host/user/password/privateKeyPath for new machines) |
| `rw_switch` | Switch current machine (subsequent calls without machineId default to this one) |
| `rw_pick_workspace` | Set remote workspace directory for a specific machine |
| `rw_list_dir` / `rw_read_file` | Browse / read remote files |
| `rw_write_file` | Write remote file directly (auto-creates parent directories) |
| `rw_exec` | Execute shell commands on remote |
| `rw_sync` / `rw_push` | Remote ↔ local mirror bidirectional SFTP sync |
| `rw_disconnect` | Disconnect specific machine (other machines unaffected) |

### Settings panel mode

Browser DSH Web → **Settings → Remote Workspace**: add/edit/delete machines, test connection, switch current machine.

---

## 🔄 Adapting to Other DSH Versions / Other Machines

**This plugin targets latest `@deepseek-ai/dsh@0.1.2-rc.1`, and also works with older 0.1.1-rc.2 etc.** (mounted into existing modes via **same-named user preset** override under `~/.dsh/.agent-presets/`). For other versions:

1. **After official DSH upgrade**: usually preset mechanism unchanged; `bash install.sh --uninstall && bash install.sh` to reinstall (script is idempotent, detects version).
2. **Deploying to another machine**: `git clone` → `bash install.sh` → restart DSH; no manual file copying needed (deps, symlink, presets all automated).
3. **Multiple machines**: plugin's machine registry lives in `~/.dsh/remote-workspaces/machines.json`, maintained independently per machine; to share the same machine list across devices, manually copy that file.

> **Version management**: this repo uses git tags to mark adaptation points (e.g. `v0.1.2-rc.1`). Because the preset-mount mechanism works across DSH versions, **one codebase fits all versions** — after a DSH upgrade just re-run install.sh, no need to checkout a different tag.

---

## ↩️ Uninstall

```bash
# One-click uninstall (recommended)
bash install.sh --uninstall

# Or manually: delete symlink, then remove SSH plugin block from each mode's preset
rm -f ~/.dsh/profiles/web/node_modules/dsh-ssh-remote
# Then edit each ~/.dsh/.agent-presets/<mode>/agent.cordis.yml and delete
# the "SSH Remote Workspace" plugin block at the end; the rest is official original
```

---

## 🔗 Related

- Patches repo (input history + edit & regenerate): <https://github.com/chai1110/dsh-custom-patches>
- Upstream dsh-remote: <https://github.com/flymysql/dsh-remote>
- DeepSeek Harness official: <https://github.com/deepseek-ai/deepseek-harness>

---

## ⚠️ DSH 0.1.2-alpha.2 适配预研（2026-08-30）

> **预发布**（npm `latest` 仍为 `0.1.1-rc.2`），架构级重构，**建议等官方稳定版再升级**。

- 官方重构：`dsh-host-apiproxy` / `dsh-client-runtime` 包消失，功能拆分到 `dsh-base` / `dsh-app-boot` / `dsh-session-*`。
- 本插件的 vendored 组件（easyssh / dsh-ssh / aionui-panel）import 的是 `dsh-ssh` / `dsh-tools` / `dsh-settings` 三个独立包——这三个包在 alpha 下均有 `0.1.2-alpha.2` 版本（不受主包拆包影响），**依赖面兼容风险低**。
- 升级前需验证的接口：`ctx.provide("easysshCore")` / `ctx.get("easysshCore")`（easyssh↔aionui-panel 的服务名）、`settings.section`、`conversation.input.left` 等 slot 在 alpha 下是否保留。
- **已验证的破坏点（预研）**：vendored `dsh-ssh` 从 `dsh-settings` import 的 `installSettingsSection` / `settingsNamespace` 在 alpha **消失**（dsh-settings 0.1.2-alpha.2 中 grep 为 0，rc.2 为 3）→ 升级需改用新设置 API。`dsh-tools` 的 `defineTool` 保留 ✅。
- **设置 API 迁移（alpha）**：`installSettingsSection` → `SettingsProvider.installSection`。替换方式：
  ```js
  // rc.2
  import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
  installSettingsSection(ctx, SSH_SETTINGS_NAMESPACE, Config, config ?? {}, { setSource, onChange });
  // alpha（需 ctx.get("settings") 为 SettingsProvider 实例）
  const settings = ctx.get("settings"); // 或经 inject(["settings"])
  settings.installSection(ctx, SSH_SETTINGS_NAMESPACE, Config, config ?? {}, { setSource, onChange });
  ```
  （agent-loop alpha 里 `ctx.inject(["settings"], (c) => c.settings.installSection(...))` 是官方示例。）
- **slot 兼容验证（alpha）**：插件依赖的所有 slot 在 alpha 均保留 ✅——`conversation.session.header.utilities/actions`、`conversation.input.left/right`、`conversation.composer.bar`、`sidebar.workspaces`、`settings.general.item`。即 easyssh 的挂载点（input.left / header）在 alpha 下继续有效，插件主要适配点就是上面的 settings API 迁移。
- 当前环境保持 rc.2，等稳定版发布后再按本表验证适配。
