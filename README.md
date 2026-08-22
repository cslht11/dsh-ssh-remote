# dsh-ssh-remote

DeepSeek Harness (DSH) SSH Remote Workspace Plugin — **multi-machine parallel edition**: manage multiple servers, **maintain multiple SSH connections simultaneously**, pick a remote workspace on each, and let your Agent directly view / edit / execute remote files.

> Target version: **`@deepseek-ai/dsh@0.1.1-rc.2`** (DSH Web running on profile)

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
- Multi-pool parallel refactor, `machineId` parameter, `rw_switch`, rc.2 preset adaptation: incremental changes by this repo (cslht11)
- When upstream publishes new versions, we优先参考上游变更并合并: <https://github.com/flymysql/dsh-remote>

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

Targets DSH **0.1.1-rc.2**. On a machine with DSH installed, three steps:

```bash
# 1) Clone this repo
git clone https://github.com/cslht11/dsh-ssh-remote.git
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

## 🛠 Manual Installation (step-by-step)

Equivalent to `install.sh`, for users who want control:

### Step 1: Clone and install plugin dependencies
```bash
git clone https://github.com/cslht11/dsh-ssh-remote.git
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

**This plugin targets `@deepseek-ai/dsh@0.1.1-rc.2`** (mounted into existing modes via **same-named user preset** override under `~/.dsh/.agent-presets/`). For other versions:

1. **After official DSH upgrade**: usually preset mechanism unchanged; `bash install.sh --uninstall && bash install.sh` to reinstall (script is idempotent, detects version).
2. **Deploying to another machine**: `git clone` → `bash install.sh` → restart DSH; no manual file copying needed (deps, symlink, presets all automated).
3. **Multiple machines**: plugin's machine registry lives in `~/.dsh/remote-workspaces/machines.json`, maintained independently per machine; to share the same machine list across devices, manually copy that file.

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

- Patches repo (input history + edit & regenerate): <https://github.com/cslht11/dsh-custom-patches>
- Upstream dsh-remote: <https://github.com/flymysql/dsh-remote>
- DeepSeek Harness official: <https://github.com/deepseek-ai/deepseek-harness>
