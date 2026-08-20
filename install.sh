#!/bin/bash
# =============================================================================
# install.sh — dsh-ssh-remote 一键安装（DSH 0.1.0-rc.8）
#
# 设计原则：不新增「SSH 专用模式」。SSH 工具加入所有**现有模式**
# （standard / code / minimal / cordis），本地与远程都是同一套模式，
# 只是多了一组 rw_* 工具、工作路径可指向远程服务器。
#
# 自动完成：
#   1. 定位 DSH 全局安装目录（npm root -g）
#   2. 在插件仓库目录安装依赖（ssh2 / schemastery）
#   3. 将插件 symlink 进 profile 的 node_modules（preset bare name 可解析）
#   4. 对每个官方模式：在 ~/.dsh/.agent-presets/<模式名>/ 创建同名 preset，
#      内容 = 官方原版 agent.cordis.yml + preset.yml，并追加 dsh-ssh-remote
#      工具行（first-root-wins：用户同名 preset 覆盖官方，模式名不变）
#   5. 提示重启 DSH（重启后各模式直接可用，无需切换）
#
# 用法: bash install.sh
# 卸载: bash install.sh --uninstall
# =============================================================================
set -u

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="dsh-ssh-remote"
# 官方已有的模式（即 preset id），全部增强
PRESETS="standard code minimal cordis"

# ── 定位 ──────────────────────────────────────────────────────────────────
GLOBAL_ROOT=$(npm root -g 2>/dev/null || echo "")
if [ -z "$GLOBAL_ROOT" ]; then
  err "无法定位 npm 全局目录（npm root -g 为空）"
  exit 1
fi
DSH_DIR="$GLOBAL_ROOT/@deepseek-ai/dsh"
if [ ! -d "$DSH_DIR" ]; then
  alt="$HOME/.local/lib/node_modules/@deepseek-ai/dsh"
  [ -d "$alt" ] && DSH_DIR="$alt"
fi
if [ ! -f "$DSH_DIR/package.json" ]; then
  err "未找到 DSH 安装目录（找过 $DSH_DIR）"
  echo "  请先安装: npm install -g @deepseek-ai/dsh"
  exit 1
fi
VERSION=$(node -e "console.log(require('$DSH_DIR/package.json').version)" 2>/dev/null)
ok "DSH: $DSH_DIR (v$VERSION)"

PROFILE="$HOME/.dsh/profiles/web"
USER_PRESETS="$HOME/.dsh/.agent-presets"

# ── 卸载 ───────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  info "卸载中…"
  rm -f "$PROFILE/node_modules/$PLUGIN_NAME"
  # 从每个 mode preset 移除 SSH 工具行（保留模式本身——其余行是官方原版）
  for p in $PRESETS; do
    f="$USER_PRESETS/$p/agent.cordis.yml"
    if [ -f "$f" ]; then
      python3 - "$f" << 'PYEOF'
import sys
p = sys.argv[1]
with open(p) as f:
    lines = f.readlines()

def find_name_block(lines):
    for i, line in enumerate(lines):
        if "name: 'dsh-ssh-remote'" in line:
            return i
    return None

# 阶段 1: 删除 name 块（及其 - id / 空行 / SSH 注释标题）
name_idx = find_name_block(lines)
if name_idx is not None:
    begin = name_idx
    for k in range(name_idx - 1, max(-1, name_idx - 8), -1):
        t = lines[k].strip()
        if t == '- id: ssh-remote' or t == '' or t.startswith('# ── SSH 远程工作区') or t.startswith('# SSH 远程工作区'):
            begin = k
            continue
        break
    end = name_idx + 1
    while end < len(lines):
        cur = lines[end]
        if cur.startswith('  ') or cur.startswith('\t') or cur.strip() == '':
            end += 1
        else:
            break
    lines = lines[:begin] + lines[end:]

# 阶段 2: 清理任何残留的 SSH 注释行（幂等）
lines = [l for l in lines if not (l.strip().startswith('# ── SSH 远程工作区') or l.strip().startswith('# SSH 远程工作区'))]

with open(p, 'w') as f:
    f.writelines(lines)
PYEOF
      ok "已从 $p 移除 SSH 工具行"
    fi
  done
  info "重启生效: kill \$(pgrep -f 'dsh web') 2>/dev/null; dsh web"
  exit 0
fi

# ── 1. 安装依赖（自包含）───────────────────────────────────────────────────
info "安装插件依赖 (ssh2 / schemastery)…"
if [ ! -d "$SCRIPT_DIR/node_modules/ssh2" ]; then
  (cd "$SCRIPT_DIR" && npm install --no-save --silent 2>&1 | tail -2) || true
  [ -d "$SCRIPT_DIR/node_modules/ssh2" ] && ok "依赖就位" || { err "依赖安装失败，请手动: cd $SCRIPT_DIR && npm install"; exit 1; }
else
  ok "依赖已存在"
fi

# ── 2. symlink 进 profile node_modules ────────────────────────────────────
mkdir -p "$PROFILE/node_modules"
if [ -e "$PROFILE/node_modules/$PLUGIN_NAME" ]; then
  warn "$PLUGIN_NAME 已存在，移除旧项重链"
  rm -rf "$PROFILE/node_modules/$PLUGIN_NAME"
fi
if ln -sfn "$SCRIPT_DIR" "$PROFILE/node_modules/$PLUGIN_NAME"; then
  ok "symlink: $PROFILE/node_modules/$PLUGIN_NAME → $SCRIPT_DIR"
else
  err "无法注册到 profile node_modules"; exit 1
fi

# ── 3. 增强每个官方模式（同名用户 preset 覆盖，模式名不变）────────────────
echo ""
info "增强现有模式（不新增模式，SSH 工具加入每个模式）:"
for p in $PRESETS; do
  OFFICIAL_YML="$DSH_DIR/config/agent-presets/$p/agent.cordis.yml"
  OFFICIAL_META="$DSH_DIR/config/agent-presets/$p/preset.yml"
  TARGET_DIR="$USER_PRESETS/$p"
  mkdir -p "$TARGET_DIR"

  # agent.cordis.yml：首次 = 官方原版；以后保留
  if [ ! -f "$TARGET_DIR/agent.cordis.yml" ] && [ -f "$OFFICIAL_YML" ]; then
    cp "$OFFICIAL_YML" "$TARGET_DIR/agent.cordis.yml"
    ok "  $p: 用户 preset 基于官方原版创建"
  elif [ ! -f "$TARGET_DIR/agent.cordis.yml" ]; then
    warn "  $p: 官方 preset 文件缺失（$OFFICIAL_YML），跳过"
    continue
  fi

  # preset.yml 元数据：继承官方（模式名/描述不变）
  if [ ! -f "$TARGET_DIR/preset.yml" ] && [ -f "$OFFICIAL_META" ]; then
    cp "$OFFICIAL_META" "$TARGET_DIR/preset.yml"
  fi

  # 追加 SSH 插件行（幂等）
  if ! grep -q "name: '$PLUGIN_NAME'" "$TARGET_DIR/agent.cordis.yml" 2>/dev/null; then
    cat >> "$TARGET_DIR/agent.cordis.yml" << EOF

# ── SSH 远程工作区（dsh-ssh-remote 插件）───────────────────────────────────
- id: ssh-remote
  name: '$PLUGIN_NAME'
  config: {}
EOF
    ok "  $p: 已追加 SSH 工具"
  else
    info "  $p: 已含 SSH 工具（幂等跳过）"
  fi
done

# ── 4. 移除旧的「SSH 增强模式」（若有，避免残留误导）────────────────────
if [ -d "$USER_PRESETS/ssh-enhanced" ]; then
  rm -rf "$USER_PRESETS/ssh-enhanced"
  warn "已移除旧「SSH 增强模式」（设计中已不再需要单独模式）"
fi

# ── 完成 ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "1. 重启 DSH:  ${YELLOW}kill \$(pgrep -f 'dsh web') 2>/dev/null; dsh web${NC}"
echo -e "2. 浏览器打开 DSH Web → 新建会话 → 选你平时用的模式即可"
echo -e "   （standard/code/minimal 都已内置 SSH 工具，无需切换新模式）"
echo -e "3. 设置 → 远程工作区 管理服务器；对话里用 rw_connect / rw_exec 等工具"
echo ""
info "卸载: bash install.sh --uninstall"
echo ""