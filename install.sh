#!/bin/bash
# =============================================================================
# install.sh — dsh-ssh-remote 一键安装（DSH 0.1.0-rc.8）
#
# 自动完成：
#   1. 定位 DSH 全局安装目录（npm root -g）
#   2. 在插件仓库目录安装依赖（ssh2 / schemastery）
#   3. 将插件 symlink 进 profile 的 node_modules（让 preset 的 bare name 可解析）
#   4. 创建用户 preset ~/.dsh/.agent-presets/ssh-enhanced/
#        - 基于官方 standard preset（继承全部官方工具）
#        - 追加 dsh-ssh-remote 一行（挂载进 agent scope）
#   5. 提示重启 DSH 并选择「SSH 增强模式」
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
PRESET_ID="ssh-enhanced"
PLUGIN_NAME="dsh-ssh-remote"

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
PRESET_DIR="$HOME/.dsh/.agent-presets/$PRESET_ID"

# ── 卸载 ───────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  info "卸载中…"
  rm -f "$PROFILE/node_modules/$PLUGIN_NAME"
  rm -f "$PROFILE/node_modules/.pnpm/$PLUGIN_NAME" 2>/dev/null
  rm -rf "$PRESET_DIR"
  # 从 profile package.json 去掉依赖（若有）
  if [ -f "$PROFILE/package.json" ]; then
    python3 - "$PROFILE/package.json" << 'PYEOF' 2>/dev/null || true
import json, sys
p = sys.argv[1]
with open(p) as f: d = json.load(f)
deps = d.get('dependencies', {})
if PLUGIN in deps:
    del deps[PLUGIN]
    with open(p, 'w') as f: json.dump(d, f, indent=2)
    print('removed from profile deps')
PYEOF
  fi
  ok "已移除 symlink 与 preset"
  info "重启生效: kill \$(pgrep -f 'dsh web') 2>/dev/null; dsh web"
  exit 0
fi

# ── 1. 安装依赖（在本仓库目录，使插件自包含）──────────────────────────────
info "安装插件依赖 (ssh2 / schemastery)…"
if [ ! -d "$SCRIPT_DIR/node_modules/ssh2" ]; then
  (cd "$SCRIPT_DIR" && npm install --no-save --silent 2>&1 | tail -2) || { warn "依赖安装输出见上（可重试 npm install）"; }
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
  if cp -R "$SCRIPT_DIR/lib" "$PROFILE/node_modules/$PLUGIN_NAME" 2>/dev/null; then
    ok "（symlink 失败，改用复制方式）$PLUGIN_NAME → profile node_modules"
  else
    err "无法注册到 profile node_modules"; exit 1
  fi
fi

# ── 3. preset：基于官方 standard 追加 SSH 行 ───────────────────────────────
OFFICIAL_PRESET="$DSH_DIR/config/agent-presets/standard/agent.cordis.yml"
mkdir -p "$PRESET_DIR"
if [ ! -f "$PRESET_DIR/agent.cordis.yml" ]; then
  if [ -f "$OFFICIAL_PRESET" ]; then
    cp "$OFFICIAL_PRESET" "$PRESET_DIR/agent.cordis.yml"
    ok "base preset 来自官方 standard (继承全部官方工具)"
  else
    warn "官方 standard preset 未找到（$OFFICIAL_PRESET），创建最小 preset"
    printf -- "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n" > "$PRESET_DIR/agent.cordis.yml"
  fi
else
  info "preset 已存在，保留"
fi

# 追加 SSH 插件行（幂等：已存在则不重复）
if ! grep -q "name: '$PLUGIN_NAME'" "$PRESET_DIR/agent.cordis.yml" 2>/dev/null; then
  cat >> "$PRESET_DIR/agent.cordis.yml" << EOF

# ── SSH 远程工作区（dsh-ssh-remote 插件）───────────────────────────────────
- id: ssh-remote
  name: '$PLUGIN_NAME'
  config: {}
EOF
  ok "agent.cordis.yml 已追加 $PLUGIN_NAME"
else
  info "agent.cordis.yml 已含 $PLUGIN_NAME（幂等跳过）"
fi

# preset.yml 元数据
if [ ! -f "$PRESET_DIR/preset.yml" ]; then
  cat > "$PRESET_DIR/preset.yml" << 'EOF'
name: SSH 增强模式
description: 标准编码 Agent + 多机 SSH 远程工作区（同时连接多台服务器）。
order: 50
EOF
  ok "preset.yml 已创建"
fi

# ── 完成 ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "1. 重启 DSH:  ${YELLOW}kill \$(pgrep -f 'dsh web') 2>/dev/null; dsh web${NC}"
echo -e "2. 浏览器打开 DSH Web → 新建会话 → 选择预设「${YELLOW}SSH 增强模式${NC}」"
echo -e "3. 在对话里用 rw_connect 添加服务器，或用设置面板 → 远程工作区 管理机器"
echo ""
info "卸载: bash install.sh --uninstall"
echo ""