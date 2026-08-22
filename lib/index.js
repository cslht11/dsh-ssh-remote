// dsh-ssh-remote — SSH 远程工作区插件（多机并行版）
//
// 基于 dsh-remote (MIT, flymysql) 0.5.10 改造：单连接池 → 多池并行。
// 上游: https://github.com/flymysql/dsh-remote  (Copyright (c) 2026 dsh-remote contributors)
// 许可: MIT — 见仓库 LICENSE。
//
// 主要差异（本仓库增量修改，归属 cslht11）：
//   • 每台注册的机器都有自己的 SshPool，可同时保持多个 SSH 连接
//   • 工具与 JSON 路由均支持指定目标机器（machineId；不传 = current 机）
//   • /dsh-ssh-remote/status 返回全部机器及其连接状态
//   • 新增 rw_switch / rw_info 全量 / rw_disconnect(指定机)
//   • 按 rc.2 用户 preset 挂载，进入 agent scope（上游仍停留 rc.6）
//
// 底层 helpers（shq / normalizeRemotePath / mirror / syncTree / pushTree /
// machines registry / SshPool）来自上游 dsh-remote，未改动。

// ── helpers 部分由 dsh-remote 原版提供（见下方引用）────────────────────────
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ssh2 from 'ssh2'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { searchTree } from './search.js'
import { ForwardManager } from './forwards.js'

const { Client } = ssh2

export const name = 'dsh-ssh-remote'

export const inject = ['tools', 'systemPrompt', 'webServer']

export const Config = z.object({
  host: z.string().default(''),
  port: z.number().step(1).min(1).max(65535).default(22),
  username: z.string().default(''),
  password: z.string().default(''),
  privateKeyPath: z.string().default(''),
  passphrase: z.string().default(''),
  workspace: z.string().default(''),
  commandTimeoutMs: z.number().step(1).min(1000).default(20000),
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  maxOutputChars: z.number().step(1).min(1024).default(200000),
})

// ── shell / path helpers ───────────────────────────────────────────────────

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function normalizeRemotePath(p) {
  const parts = []
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

function remoteDirname(p) {
  const norm = normalizeRemotePath(p)
  if (norm === '/') return '/'
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '/' : norm.slice(0, idx)
}

function truncate(s, max) {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated: ${s.length - max} more chars]`
}

// ── 跨平台路径/命令 helpers（Linux/macOS/Windows 统一）───────────────────

/**
* 把通用路径（/C/Users/x 或 C:/Users/x 或 /home/x）转成执行命令用的形式。
* - POSIX 主机：保持 /home/x 原样
* - Windows 主机：/C/Users/x → C:\Users\x；C:/Users/x → C:\Users\x
* @param p 用户提供的路径
* @param os 'posix' | 'windows' | undefined（undefined 时按有盘符前缀判断）
*/
function cmdPath(p, os) {
  let s = String(p || '')
  if (!s) return s
  const isWinLike = os === 'windows' || (/^\/[A-Za-z]\//.test(s)) || (/^[A-Za-z]:[\\/]/.test(s))
  if (!isWinLike) return s // POSIX 路径或纯相对
  // 统一成 Windows 风格
  let out = s
  if (/^\/[A-Za-z]\//.test(out)) out = out.slice(1)              // /C/Users/x -> C/Users/x
  out = out.replace(/\//g, '\\')                                 // C/Users/x -> C:\Users\x
  if (!/^[A-Za-z]:/.test(out)) out = out.charAt(0).toUpperCase() + ':' + out.slice(1) // C->C:
  return out
}

/** Windows cmd 引号包裹（用于带空格的路径）。 */
function cmdq(s) {
  return '"' + String(s).replace(/"/g, '""') + '"'
}

/**
* 探测远程主机操作系统。
* 返回 'windows'（ver/echo %OS% 存在）或 'posix'（uname 存在）或 'unknown'。
*/
async function detectOs(pool, timeoutMs) {
  try {
    // 同时探测：Windows 的 ver / %OS%，POSIX 的 uname
    const res = await pool.exec('ver >nul 2>&1 && echo WINDOWS_OK || (uname -s 2>/dev/null && echo POSIX_OK)', timeoutMs || 8000)
    const out = String(res.stdout || '') + String(res.stderr || '')
    if (/WINDOWS_OK/.test(out)) return 'windows'
    if (/POSIX_OK/.test(out)) return 'posix'
    if (/^win/i.test(out.trim())) return 'windows'
    if (/linux|darwin|freebsd/i.test(out)) return 'posix'
  } catch {}
  return 'unknown'
}

/** POSIX 目录列表（原上游实现，解析成 {type,name}）。 */
function parsePosixList(stdout) {
  const items = []
  for (const line of String(stdout || '').split('\n')) {
    const idx = line.indexOf('\t')
    if (idx < 0) continue
    const type = line.slice(0, idx)
    const name = line.slice(idx + 1)
    if (name === '.' || name === '..' || !name) continue
    items.push({ type: type === 'd' ? 'dir' : 'file', name })
  }
  return items
}

/** Windows cmd 'dir' 输出解析成 {type,name}。 */
function parseWinDir(stdout) {
  const items = []
  const lines = String(stdout || '').split('\n')
  let inList = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (/^\s*卷 /.test(line) || /^\s*驱动器 /.test(line)) { inList = false; continue }
    if (/^\s*目录/.test(line)) { inList = false; continue }
    if (/^\s*$/.test(line)) { continue }
    const m = line.match(/^(\S{3,8}\s+\S+\s+\S+\s+)(.+)$/)
    if (m && /^[0-9]{2}\//.test(line.trim())) {
      const name = m[2].trim()
      if (!name || name === '.' || name === '..') continue
      items.push({ type: /<DIR>/.test(line) ? 'dir' : 'file', name })
      continue
    }
    if (/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}/.test(line.trim())) {
      const name = line.trim().replace(/^.+?\s+(.+)$/, '$1').trim()
      if (!name || name === '.' || name === '..') continue
      items.push({ type: /<DIR>/.test(line) ? 'dir' : 'file', name })
      continue
    }
  }
  return items
}

// ── local mirror helpers ───────────────────────────────────────────────────

const remotePathBase = (p) => {
  const norm = normalizeRemotePath(p).replace(/\/+$/, '')
  const base = norm.split('/').pop()
  return base || 'workspace'
}

function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(homedir(), '.dsh', 'remote-workspaces', tag)
}

function mirrorDirFor(remotePath, host, user, port) {
  const base = remotePathBase(remotePath)
  return path.join(mirrorRootFor(host, user, port), base)
}

function ensureMirror(remotePath, host, user, port) {
  const dir = mirrorDirFor(remotePath, host, user, port)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({ host, port, username: user, remotePath, createdAt: new Date().toISOString() }, null, 2),
  )
  return dir
}

async function syncTree(sftp, remoteDir, localDir, maxDepth, maxFiles) {
  const entries = await sftp.readdir(remoteDir).then(
    (list) => list,
    () => [],
  )
  let files = 0
  const touched = []
  for (const e of entries) {
    const name = String(e.filename)
    if (name === '.' || name === '..') continue
    const rp = remoteDir === '/' ? '/' + name : remoteDir + '/' + name
    const lp = path.join(localDir, name)
    const isDir = e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()
    if (isDir) {
      if (maxDepth <= 0) continue
      mkdirSync(lp, { recursive: true })
      const sub = await syncTree(sftp, rp, lp, maxDepth - 1, maxFiles)
      files += sub.files
      touched.push(...sub.touched)
      continue
    }
    if (files >= maxFiles) break
    try {
      const buf = await sftp.readFile(rp)
      writeFileSync(lp, buf)
      touched.push(rp)
      files++
    } catch {
      /* skip unreadable */
    }
  }
  return { files, touched }
}

async function pushTree(sftp, localDir, remoteDir, remoteBaseDir, maxFiles) {
  const entries = readdirSync(localDir, { withFileTypes: true }).filter((e) => e.name !== '.dsh-remote-meta.json')
  let files = 0
  const pushed = []
  for (const e of entries) {
    if (e.isDirectory()) {
      const rp = remoteDir === '/' ? '/' + e.name : remoteDir + '/' + e.name
      try {
        await sftp.mkdir(rp)
      } catch { /* already exists */ }
      const sub = await pushTree(sftp, path.join(localDir, e.name), rp, remoteBaseDir, maxFiles)
      files += sub.files
      pushed.push(...sub.pushed)
      continue
    }
    if (files >= maxFiles) break
    const lp = path.join(localDir, e.name)
    const rp = remoteDir === '/' ? '/' + e.name : remoteDir + '/' + e.name
    try {
      const buf = readFileSync(lp)
      await sftp.writeFile(rp, buf)
      pushed.push(rp)
      files++
    } catch {
      /* skip unreadable / unwritable */
    }
  }
  return { files, pushed }
}

// ── persistent multi-machine registry ─────────────────────────────────────

const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(homedir(), '.dsh', 'remote-workspaces', MACHINES_FILE)
function loadMachines() {
  try {
    const j = JSON.parse(readFileSync(machinesFile(), 'utf8'))
    if (Array.isArray(j.list)) return { list: j.list, currentId: j.currentId || (j.list[0] && j.list[0].id) || null }
  } catch {}
  return { list: [], currentId: null }
}
function saveMachines(list, currentId) {
  try { mkdirSync(path.dirname(machinesFile()), { recursive: true }) } catch {}
  writeFileSync(machinesFile(), JSON.stringify({ list, currentId }, null, 2))
}
function sanitizeMachine(m) {
  if (!m) return m
  const { password, ...rest } = m
  return { ...rest, passwordSet: !!(m.password && m.password.length) }
}
function machineId() { return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) }

// ── SSH pool (key OR password) — 每台机器一个实例 ─────────────────────────

class SshPool {
  constructor(config) {
    this.config = config
    this.client = null
    this.connecting = null
    this.onReady = null      // hook: (client) => {} — called after each connect
    this.onCloseHook = null  // hook: () => {} — called on close
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace }) {
    if (host !== undefined) this.config.host = String(host)
    if (port !== undefined && Number(port)) this.config.port = Number(port)
    if (username !== undefined) this.config.username = String(username)
    if (password !== undefined && password !== null) this.config.password = String(password)
    if (privateKeyPath !== undefined) this.config.privateKeyPath = String(privateKeyPath)
    if (passphrase !== undefined) this.config.passphrase = String(passphrase)
    if (workspace !== undefined) this.config.workspace = String(workspace)
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    this.connecting = this._doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        if (this.client === client) this.client = null
        reject(err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        this.client = client
        if (this.onReady) this.onReady(client)
        resolve(client)
      })
      client.on('error', fail)
      client.on('close', () => {
        if (this.client === client) this.client = null
        fail(new Error('ssh connection closed'))
      })

      const opts = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: this.config.connectTimeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      }
      if (this.config.password) {
        opts.password = this.config.password
      } else {
        const keyPath = this.resolveKeyPath()
        if (!keyPath) {
          return fail(new Error('no credentials: set a password or a privateKeyPath to connect'))
        }
        let key
        try {
          key = readFileSync(keyPath)
        } catch (err) {
          return fail(new Error(`cannot read private key "${keyPath}": ${err && err.message}`))
        }
        opts.privateKey = key
        opts.passphrase = this.config.passphrase || undefined
      }
      client.connect(opts)
    })
  }

  exec(command, timeoutMs) {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
            let stdout = ''
            let stderr = ''
            let settled = false
            let exitCode = null
            let exitSignal = null
            const hardCap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
            const settle = () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve({
                code: exitCode,
                signal: exitSignal,
                stdout: truncate(stdout, this.config.maxOutputChars),
                stderr: truncate(stderr, this.config.maxOutputChars),
              })
            }
            const timer = setTimeout(() => {
              if (settled) return
              exitCode = -1
              exitSignal = 'TIMEOUT'
              try { stream.close() } catch {}
              settle()
            }, timeoutMs || this.config.commandTimeoutMs)
            stream.on('close', (code, signal) => {
              if (settled) return
              exitCode = code
              exitSignal = signal
              settle()
            })
            stream.on('data', (d) => {
              if (stdout.length < hardCap) stdout += d
            })
            stream.stderr.on('data', (d) => {
              if (stderr.length < hardCap) stderr += d
            })
            stream.on('error', (e) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              reject(new Error('ssh stream error: ' + ((e && e.message) || e)))
            })
          })
        }),
    )
  }

  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
            resolve({
              readdir: (dir) => new Promise((r2, j2) => sftp.readdir(dir, (e, list) => (e ? j2(e) : r2(list)))),
              stat: (p) => new Promise((r2, j2) => sftp.stat(p, (e, st) => (e ? j2(e) : r2(st)))),
              lstat: (p) => new Promise((r2, j2) => sftp.lstat(p, (e, st) => (e ? j2(e) : r2(st)))),
              mkdir: (dir) => new Promise((r2, j2) => sftp.mkdir(dir, (e) => (e ? j2(e) : r2()))) ,
              readFile: (p) => new Promise((r2, j2) => sftp.readFile(p, (e, buf) => (e ? j2(e) : r2(buf)))),
              writeFile: (p, data) => new Promise((r2, j2) => sftp.writeFile(p, data, (e) => (e ? j2(e) : r2()))),
              rmdir: (dir) => new Promise((r2, j2) => sftp.rmdir(dir, (e) => (e ? j2(e) : r2()))),
              unlink: (p) => new Promise((r2, j2) => sftp.unlink(p, (e) => (e ? j2(e) : r2()))),
              rename: (from, to) => new Promise((r2, j2) => sftp.rename(from, to, (e) => (e ? j2(e) : r2()))),
              realpath: (p) => new Promise((r2, j2) => sftp.realpath(p, (e, resolved) => (e ? j2(e) : r2(resolved)))),
            })
          })
        }),
    )
  }

  close() {
    const client = this.client
    this.client = null
    if (this.onCloseHook) this.onCloseHook()
    if (client) {
      try { client.end() } catch {}
    }
  }
}

// ── 多池 apply ─────────────────────────────────────────────────────────────
// 与单池版的关键差异：
//   pools: Map<id, { machine, pool }> —— 每台注册机器一个独立 SshPool，
//          互不干扰，可同时保持连接。
//   currentId 只决定“未指定 machineId 时的默认目标”。

export async function apply(ctx, config) {
  // ── registry ─────────────────────────────────────────────────────────────
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)

  // 每台机器的独立连接池（懒创建）
  const pools = new Map()
  const poolFor = (machine) => {
    if (!machine || !machine.id) return null
    let entry = pools.get(machine.id)
    if (!entry) {
      entry = {
        // 不回显密码：构建与 machine 同源但分开的配置对象
        machine,
        pool: new SshPool({
          host: machine.host,
          port: Number(machine.port) || 22,
          username: machine.username || '',
          password: machine.password || '',
          privateKeyPath: machine.privateKeyPath || '',
          passphrase: machine.passphrase || '',
          workspace: machine.workspace || '',
          commandTimeoutMs: config.commandTimeoutMs,
          connectTimeoutMs: config.connectTimeoutMs,
          maxOutputChars: config.maxOutputChars,
        }),
      }
      pools.set(machine.id, entry)
    }
    return entry.pool
  }
  // 确保所有已注册机器都有池实例（用于状态展示）
  for (const m of machines) poolFor(m)

  const currentMachine = () => {
    if (store.currentId) {
      const i = machineIndex(store.currentId)
      if (i >= 0) return machines[i]
    }
    if (config.host) {
      return { id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase, workspace: config.workspace }
    }
    return null
  }

  /** 解析工具/路由里传入的 machineId；为 undefined/null/'' 时回退到 current 机。 */
  const resolveMachine = (id) => {
    if (id) {
      const i = machineIndex(String(id))
      if (i >= 0) return machines[i]
      return null
    }
    return currentMachine()
  }

  const setCurrent = (id) => {
    const i = machineIndex(id)
    if (i < 0) return false
    store.currentId = id
    saveMachines(machines, id)
    return true
  }

  // If no stored current, adopt a CLI-provided default as an ad-hoc machine.
  if (!store.currentId && config.host) {
    const adhoc = { id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase, workspace: config.workspace }
    machines.push(adhoc)
    store.currentId = adhoc.id
    saveMachines(machines, store.currentId)
  }

  const statusFor = (machine) => {
    if (!machine) return null
    const pool = poolFor(machine)
    const ws = (machine.workspace || '').trim()
    return {
      id: machine.id,
      name: machine.name || machine.host,
      host: machine.host,
      port: Number(machine.port) || 22,
      username: machine.username || '',
      connected: !!(pool && pool.client),
      workspace: ws,
      localMirror: ws ? mirrorDirFor(ws, machine.host, machine.username, machine.port) : '',
      isCurrent: store.currentId === machine.id,
      passwordSet: !!machine.password,
    }
  }

  const statusAll = () => ({
    currentId: store.currentId || null,
    machines: machines.map((m) => statusFor(m)).filter(Boolean),
  })

  const run = async (machine, cmd, opts = {}) => {
    const pool = poolFor(machine)
    const res = await pool.exec(cmd, opts.timeoutMs || config.commandTimeoutMs)
    const parts = []
    if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
    if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
    if (!parts.length) parts.push('(no output)')
    let text = parts.join('\n')
    if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${opts.timeoutMs ?? config.commandTimeoutMs}ms]`
    else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
    return text
  }

  // ── 系统探测（懒缓存到 machine.os；未知时探测，成功后复用）────────────
  const ensureOs = async (machine) => {
    if (machine.os === 'windows' || machine.os === 'posix') return machine.os
    const os = await detectOs(poolFor(machine), Math.min(config.commandTimeoutMs, 8000))
    machine.os = os
    return os
  }

  const listDirStructured = async (machine, p, timeoutMs) => {
    const os = await ensureOs(machine)
    const target = p || '/'
    if (os === 'windows') {
      // Windows: cmd /c dir 输出带类型（<DIR> / 文件）与大小
      const winPath = cmdPath(target, 'windows')
      const cmd = `cmd /c dir ${cmdq(winPath)}`
      const res = await poolFor(machine).exec(cmd, timeoutMs || config.commandTimeoutMs)
      if (res.code !== 0 && res.stderr && !String(res.stdout || '').includes('\\')) {
        throw new Error('ls failed: ' + (res.stderr || '').trim())
      }
      const items = parseWinDir(res.stdout)
      return { path: target, items }
    }
    // POSIX（Linux/macOS）原上游实现
    const cmd =
      `cd ${shq(target)} 2>/dev/null && for f in .[!.]* *; do ` +
      `[ -e "$f" ] || [ -L "$f" ] || continue; ` +
      `if [ -d "$f" ]; then printf 'd\\t%s\\n' "$f"; else printf 'f\\t%s\\n' "$f"; fi; done`
    const res = await poolFor(machine).exec(cmd, timeoutMs || config.commandTimeoutMs)
    if (res.code !== 0 && res.stderr) {
      throw new Error('ls failed: ' + (res.stderr || '').trim())
    }
    return { path: target, items: parsePosixList(res.stdout) }
  }

  /** 判断远程路径是否是目录（跨平台）。 */
  const isRemoteDir = async (machine, p) => {
    const os = await ensureOs(machine)
    if (os === 'windows') {
      const winPath = cmdPath(p, 'windows')
      const res = await poolFor(machine).exec(`cmd /c if exist ${cmdq(winPath + '\\')} (echo DIR) else (echo NOTDIR)`)
      return String(res.stdout || '').includes('DIR')
    }
    const res = await poolFor(machine).exec(`if [ -d ${shq(p)} ]; then echo DIR; else echo NOTDIR; fi`)
    return String(res.stdout || '').trim() === 'DIR'
  }

  // 工具公共参数：machineId（any machine）——目标是“在哪台机器上执行”。
  const machineParam = {
    machineId: { type: 'string', description: 'Target machine id (optional; default = current machine). Get ids from rw_info / rw_switch.' },
  }

  const renderErr = (err) => ({ kind: 'error', text: String((err && err.message) || err) })


  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
  const okOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
    render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'ok' : 'failed') }],
  }

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show ALL registered remote machines and their connection status, plus the current machine and its remote workspace. Call this first to orient, or when a remote_* call fails to check connectivity.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute() {
        const all = statusAll()
        const lines = []
        if (!all.machines.length) {
          lines.push('No machines registered. Use rw_connect to add + connect one.')
          return { text: lines.join('\n') }
        }
        lines.push(`Registered machines: ${all.machines.length}`)
        for (const s of all.machines) {
          lines.push(`  [${s.isCurrent ? '*' : ' '}] ${s.id}  ${s.name}  (${s.username}@${s.host}:${s.port})  connected: ${s.connected ? 'yes' : 'no'}${s.workspace ? '  ws: ' + s.workspace : ''}`)
        }
        lines.push('')
        const cur = currentMachine()
        if (cur) {
          const s = statusFor(cur)
          lines.push(`Current remote workspace: ${s.workspace || '(none — call rw_pick_workspace to set one)'}`)
          lines.push(`Connected: ${s.connected ? 'yes' : 'no'}`)
          if (s.host && s.workspace) {
            try {
              const res = await poolFor(cur).exec('echo ok; hostname; pwd', Math.min(config.commandTimeoutMs, 8000))
              if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
              else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
              else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
            } catch (err) {
              lines.push('Ping: FAILED — ' + ((err && err.message) || err))
            }
          } else {
            lines.push('No host + workspace configured for current machine — call rw_connect with a host to get started.')
          }
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_connect',
      description:
        'Register (and connect) a NEW remote machine, or reconnect an existing one by machineId. Provide host (required), user, optional password or privateKeyPath/port. Once connected, call rw_pick_workspace to pick the workspace directory this session should work in.',
      parameters: {
        machineId: machineParam.machineId,
        host: { type: 'string', description: 'Remote host IP or hostname (required for new machines)' },
        username: { type: 'string', description: 'SSH user (default root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        let machine
        if (args.machineId) {
          const i = machineIndex(String(args.machineId))
          if (i < 0) throw new Error('rw_connect: unknown machineId ' + args.machineId)
          machine = machines[i]
          // 更新连接参数（可选覆盖）
          if (args.host) machine.host = String(args.host).trim()
          if (args.username) machine.username = String(args.username)
          if (args.port) machine.port = Number(args.port) || 22
          if (args.password !== undefined) machine.password = args.password
          if (args.privateKeyPath !== undefined) machine.privateKeyPath = String(args.privateKeyPath)
          // 重新配置池
          poolFor(machine).setTarget({
            host: machine.host,
            username: machine.username,
            port: machine.port,
            password: machine.password || undefined,
            privateKeyPath: machine.privateKeyPath || undefined,
          })
        } else {
          const host = String(args.host || '').trim()
          if (!host) throw new Error('rw_connect: host is required (or pass an existing machineId)')
          machine = {
            id: machineId(),
            name: host,
            host,
            port: Number(args.port) || 22,
            username: String(args.username || '').trim() || 'root',
            password: args.password || '',
            privateKeyPath: String(args.privateKeyPath || '').trim(),
            passphrase: '',
            workspace: '',
          }
          machines.push(machine)
          poolFor(machine)
        }
        try {
          const res = await poolFor(machine).exec('echo ok; hostname', 8000)
          if (res.code !== 0 && !res.stdout) return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          // 连接成功后设为 current
          setCurrent(machine.id)
          return { text: `Connected to ${machine.host} as ${machine.username} (id ${machine.id}).\nhostname: ${res.stdout.replace(/\s+/g, ' ').trim()}\n\npick a workspace with rw_pick_workspace (machineId=${machine.id}, path=<abs>).` }
        } catch (err) {
          throw err
        }
      },
    }),

    defineTool({
      name: 'rw_switch',
      description:
        'Switch the current machine (used when no machineId is passed to other tools). Optional: connect it if not already connected.',
      parameters: {
        machineId: { type: 'string', required: true, description: 'Target machine id (from rw_info)' },
        connect: { type: 'boolean', description: 'Also establish the SSH connection now (default true)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const ok = setCurrent(String(args.machineId || ''))
        if (!ok) throw new Error('rw_switch: unknown machineId ' + args.machineId)
        const machine = currentMachine()
        const doConnect = args.connect !== false
        if (doConnect && machine) {
          try {
            await poolFor(machine).exec('echo ok', Math.min(config.commandTimeoutMs, 8000))
          } catch (err) {
            return { text: `switched to ${machine.id} (${machine.host}) but connect failed: ${(err && err.message) || err}` }
          }
        }
        return { text: `Switched current machine to ${machine.id} (${machine.username}@${machine.host}:${machine.port}).\nWorkspace: ${machine.workspace || '(none)'}` }
      },
    }),

    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Set the remote workspace directory for a machine (default: current) — the directory this session should treat as its working root on that remote. Verifies it exists. Use rw_list_dir to browse first if unsure.',
      parameters: {
        machineId: machineParam.machineId,
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/code/project' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_pick_workspace: no machine — connect/register one first (rw_connect)')
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        const ok = await isRemoteDir(machine, p)
        if (!ok) return { text: `not a directory (or missing) on ${p} (machine ${machine.id})` }
        machine.workspace = p
        saveMachines(machines, store.currentId)
        const local = ensureMirror(p, machine.host, machine.username, machine.port)
        return {
          text: `Remote workspace set to ${p} on ${machine.username}@${machine.host} (id ${machine.id}).\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync (machineId=${machine.id}) to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download a remote workspace into its local mirror directory over SFTP (bounded). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them. Target: current machine unless machineId given.',
      parameters: {
        machineId: machineParam.machineId,
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 5)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 500)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_sync: no machine — connect/register one first')
        const p = (machine.workspace || '').trim()
        if (!p) throw new Error('rw_sync: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, machine.host, machine.username, machine.port)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 5, 1), 8)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        let sftp
        try {
          sftp = await poolFor(machine).sftp()
        } catch (err) {
          return { text: 'sftp unavailable: ' + ((err && err.message) || err) }
        }
        const { files, touched } = await syncTree(sftp, p, local, depth, maxFiles)
        return { text: `Downloaded ${files} file(s) from ${p} → ${local}${files >= maxFiles ? ' (hit download cap)' : ''}.` }
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of a remote workspace back to the remote host over SFTP (bounded). Use after editing files in the local mirror. Target: current machine unless machineId given.',
      parameters: {
        machineId: machineParam.machineId,
        maxFiles: { type: 'integer', description: 'Max files to upload (default 500)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_push: no machine — connect/register one first')
        const p = (machine.workspace || '').trim()
        if (!p) throw new Error('rw_push: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, machine.host, machine.username, machine.port)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        let sftp
        try {
          sftp = await poolFor(machine).sftp()
        } catch (err) {
          return { text: 'sftp unavailable: ' + ((err && err.message) || err) }
        }
        const { files } = await pushTree(sftp, local, p, p, maxFiles)
        return { text: `Uploaded ${files} file(s) from ${local} → ${p}.` }
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; if omitted, lists the workspace of the target machine (default: current).',
      parameters: {
        machineId: machineParam.machineId,
        path: { type: 'string', description: 'Absolute remote path (default: target workspace)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_list_dir: no machine — connect/register one first')
        const p = args.path ? normalizeRemotePath(String(args.path)) : (machine.workspace || '').trim()
        if (!p) throw new Error('rw_list_dir: no path and no workspace set for the target machine')
        if ((await ensureOs(machine)) === 'windows') {
          return { text: await run(machine, `cmd /c dir ${cmdq(cmdPath(p, 'windows'))}`) }
        }
        return { text: await run(machine, `ls -la --color=never ${shq(p)}`) }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine. Path is absolute. Target: current machine unless machineId given.',
      parameters: {
        machineId: machineParam.machineId,
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_read_file: no machine — connect/register one first')
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        let raw
        if ((await ensureOs(machine)) === 'windows') {
          // Windows: findstr /n 输出带行号（1: 开头）；再手工切片 from..to
          const all = await run(machine, `cmd /c findstr /n ".*" ${cmdq(cmdPath(p, 'windows'))}`, { timeoutMs: config.commandTimeoutMs })
          raw = all.split('\n').filter((l) => /^\d+:/.test(l))
            .slice(from - 1, to).map((l) => l.replace(/^\d+:/, '')).join('\n')
        } else {
          raw = await run(machine, `sed -n '${from},${to}p' -- ${shq(p)}`, { timeoutMs: config.commandTimeoutMs })
        }
        const numbered = raw.split('\n').map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Target: current machine unless machineId given.',
      parameters: {
        machineId: machineParam.machineId,
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_exec: no machine — connect/register one first')
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        return { text: await run(machine, cmd, { timeoutMs: config.commandTimeoutMs }) }
      },
    }),

    defineTool({
      name: 'rw_write_file',
      description:
        'Write text to a file on the remote host (creating parent directories if needed). Path is absolute. Use this to create or overwrite a remote file directly. Target: current machine unless machineId given.',
      parameters: {
        machineId: machineParam.machineId,
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'File content to write (overwrites existing file)' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'written' : 'failed') }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine || !machine.host) throw new Error('rw_write_file: no machine — connect/register one first')
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        let sftp
        try {
          sftp = await poolFor(machine).sftp()
        } catch (err) {
          throw new Error('rw_write_file: sftp unavailable: ' + ((err && err.message) || err))
        }
        const mkdir = args.mkdir !== false
        if (mkdir) {
          const parent = remoteDirname(p)
          const segs = parent.split('/').filter(Boolean)
          let cur = ''
          for (const s of segs) {
            cur += '/' + s
            try { await sftp.mkdir(cur) } catch { /* exists or no perms */ }
          }
        }
        const buf = Buffer.from(content, 'utf8')
        await sftp.writeFile(p, buf)
        const bytes = Buffer.byteLength(content, 'utf8')
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p} (machine ${machine.id})` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
        'Close the SSH connection of one machine (default: current), releasing its pool. Other machines stay connected. Useful to rotate connections or after a long idle.',
      parameters: {
        machineId: machineParam.machineId,
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const machine = resolveMachine(args.machineId)
        if (!machine) return { ok: true, text: 'no machine selected to disconnect' }
        const pool = poolFor(machine)
        if (pool) pool.close()
        return { ok: true, text: `disconnected ${machine.id} (${machine.host})` }
      },
    }),
  // ── 从上游 dsh-remote 0.8.7 合并的工具 ─────────────────────────────────
    defineTool({
      name: 'rw_stat',
      description: 'Show detailed stat of a remote file or directory: type, size, mtime, mode (SFTP attrs). Use to verify a remote path exists or to compare files.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote path' } },
      output: textOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p) throw new Error('rw_stat: path is required')
        const s = await poolFor(machine).sftp(); let st
        try { st = await s.stat(p) } catch (err) { throw new Error('rw_stat: not found or unreadable: ' + ((err && err.message) || err)) }
        const type = st.isDirectory && st.isDirectory() ? 'directory' : (st.isSymbolicLink && st.isSymbolicLink() ? 'symlink' : 'file')
        return { text: `path: ${p}\ntype: ${type}\nsize: ${st.size} bytes\nmtime: ${new Date(st.mtime * 1000).toISOString()}\nmode: ${typeof st.mode === 'number' ? st.mode.toString(8) : '?'}` }
      },
    }),

    defineTool({
      name: 'rw_edit',
      description: 'Edit a remote text file by replacing literal text (read-modify-write with mtime optimistic lock). Path is absolute.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote file path' }, old: { type: 'string', required: true, description: 'Literal text to replace' }, new: { type: 'string', required: true, description: 'Replacement text' }, count: { type: 'integer', description: 'How many occurrences to replace (default: error if text appears more than once)' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p || p === '/') throw new Error('rw_edit: a file path is required')
        const oldS = String(args.old ?? ''); const newS = String(args.new ?? '')
        if (oldS === '') throw new Error('rw_edit: old text must not be empty')
        const s = await poolFor(machine).sftp(); const st0 = await s.stat(p)
        const buf = await s.readFile(p); const content = buf.toString('utf-8')
        const count = args.count == null ? 0 : Math.max(Number(args.count) || 1, 1)
        const idxs = []; let from = 0; let hit
        while ((hit = content.indexOf(oldS, from)) !== -1) { idxs.push(hit); from = hit + oldS.length }
        if (!idxs.length) throw new Error(`rw_edit: old text not found in ${p}`)
        if (count === 0 && idxs.length > 1) throw new Error(`rw_edit: "old" appears ${idxs.length} times in ${p} — pass count=<n> to pick`)
        const n = count === 0 ? 1 : Math.min(count, idxs.length); let out = content
        for (let i = n - 1; i >= 0; i--) out = out.slice(0, idxs[i]) + newS + out.slice(idxs[i] + oldS.length)
        const st1 = await s.stat(p)
        if (st1.size !== st0.size || st1.mtime !== st0.mtime) throw new Error(`rw_edit: ${p} changed on the remote while editing (conflict) — re-read and retry`)
        await s.writeFile(p, Buffer.from(out, 'utf-8'))
        return { ok: true, text: `edited ${p}: replaced ${n} occurrence(s)` }
      },
    }),

    defineTool({
      name: 'rw_append',
      description: 'Append text to a remote file (creates it when missing). Path is absolute.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote file path' }, content: { type: 'string', required: true, description: 'Text to append' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p || p === '/') throw new Error('rw_append: a file path is required')
        const s = await poolFor(machine).sftp(); const buf = Buffer.from(String(args.content ?? ''), 'utf-8')
        let existing = Buffer.alloc(0)
        try { existing = await s.readFile(p) } catch {}
        await s.writeFile(p, Buffer.concat([existing, buf]))
        return { ok: true, text: `appended ${buf.length} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_mkdir',
      description: 'Create a remote directory (recursive). Path is absolute.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote directory path' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p || p === '/') throw new Error('rw_mkdir: a directory path is required')
        const s = await poolFor(machine).sftp(); await s.mkdir(p)
        return { ok: true, text: `created directory ${p}` }
      },
    }),

    defineTool({
      name: 'rw_remove',
      description: 'Remove a remote file or directory (recursive, bounded). Path is absolute.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote path' }, recursive: { type: 'boolean', description: 'Recursively delete a directory' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p || p === '/') throw new Error('rw_remove: a path is required')
        const s = await poolFor(machine).sftp(); let st
        try { st = await s.stat(p) } catch { return { ok: true, text: `path not found: ${p}` } }
        if (st.isDirectory && st.isDirectory()) {
          if (!args.recursive) throw new Error(`rw_remove: ${p} is a directory — pass recursive=true to delete its tree`)
          const entries = await s.readdir(p)
          for (const e of entries) {
            const cp = p.replace(/\/+$/, '') + '/' + e.filename
            const st2 = await s.lstat(cp)
            if (st2.isDirectory && st2.isDirectory()) {
              const sub = async (dir, depth) => {
                if (depth > 100) return
                const items = await s.readdir(dir)
                for (const item of items) {
                  const fp = dir.replace(/\/+$/, '') + '/' + item.filename
                  const st3 = await s.lstat(fp)
                  if (st3.isDirectory && st3.isDirectory()) await sub(fp, depth + 1)
                  else await s.unlink(fp)
                }
                await s.rmdir(dir)
              }
              await sub(cp, 1)
            } else await s.unlink(cp)
          }
          await s.rmdir(p)
        } else { await s.unlink(p) }
        return { ok: true, text: `removed ${p}` }
      },
    }),

    defineTool({
      name: 'rw_move',
      description: 'Move or rename a remote file or directory. Both paths are absolute.',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Source absolute remote path' }, dest: { type: 'string', required: true, description: 'Destination absolute remote path' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); const d = normalizeRemotePath(String(args.dest || ''))
        if (!p || !d || p === '/') throw new Error('rw_move: both path and dest are required')
        const s = await poolFor(machine).sftp(); await s.rename(p, d)
        return { ok: true, text: `moved ${p} → ${d}` }
      },
    }),

    defineTool({
      name: 'rw_search',
      description: 'Search files on the remote host by glob pattern (e.g. "*.ts", "src/**/*.test.js"). Uses SFTP tree walk (works on any OS). Results capped at 100 entries.',
      parameters: { machineId: machineParam.machineId, pattern: { type: 'string', required: true, description: 'Glob pattern to match file basenames (e.g. "*.ts", "**/*.md")' }, path: { type: 'string', description: 'Root directory to search (default: current remote workspace)' } },
      output: textOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { text: 'no machine' }
        const s = await poolFor(machine).sftp()
        const dir = args.path ? normalizeRemotePath(String(args.path)) : machine.workspace || '/'
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set')
        const results = await searchTree(s, dir, { pattern, maxResults: 100, includeDirs: false })
        if (!results.length) return { text: `no matches for "${pattern}" under ${dir}` }
        return { text: `found ${results.length} file(s) under ${dir}:\n` + results.map((r) => `${r.type === 'directory' ? '📁' : '📄'} ${r.path}`).join('\n') }
      },
    }),

    defineTool({
      name: 'rw_download',
      description: 'Download a remote file to the local mirror (or custom localPath). Bounded by maxFileBytes (default 50MB).',
      parameters: { machineId: machineParam.machineId, path: { type: 'string', required: true, description: 'Absolute remote file path' }, localPath: { type: 'string', description: 'Local destination path (default: mirror under remote-workspaces)' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const p = normalizeRemotePath(String(args.path || '')); if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        const s = await poolFor(machine).sftp(); const st = await s.stat(p)
        if (st.size > 52428800) throw new Error(`rw_download: file is ${st.size} bytes (over 50MB cap)`)
        const buf = await s.readFile(p)
        const localDir = args.localPath ? path.dirname(args.localPath) : mirrorRootFor(machine.host, machine.username, machine.port)
        mkdirSync(localDir, { recursive: true })
        const localFile = args.localPath || path.join(localDir, path.basename(p))
        writeFileSync(localFile, buf)
        return { ok: true, text: `downloaded ${p} (${buf.length} bytes) → ${localFile}` }
      },
    }),

    defineTool({
      name: 'rw_upload',
      description: 'Upload a local file to the remote host. Both localPath and a remote path are required.',
      parameters: { machineId: machineParam.machineId, localPath: { type: 'string', required: true, description: 'Local file path' }, remotePath: { type: 'string', required: true, description: 'Absolute remote file path' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine' }
        const rp = normalizeRemotePath(String(args.remotePath || '')); const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        const buf = readFileSync(lp); const s = await poolFor(machine).sftp(); await s.writeFile(rp, buf)
        return { ok: true, text: `uploaded ${lp} (${buf.length} bytes) → ${rp} (machine ${machine.id})` }
      },
    }),

    defineTool({
      name: 'rw_forward',
      description: 'Manage SSH port forwards. Direction "local" listens on 127.0.0.1:<listenPort> on THIS machine and forwards through SSH to <targetHost>:<targetPort> on the remote. Direction "reverse" asks the REMOTE to listen on 127.0.0.1:<listenPort> and pipes back to <targetHost>:<targetPort> on this machine.',
      parameters: { machineId: machineParam.machineId, listenPort: { type: 'integer', required: true, description: 'Port to listen on (127.0.0.1)' }, targetHost: { type: 'string', description: 'Forward target host (default 127.0.0.1)' }, targetPort: { type: 'integer', description: 'Forward target port (default: same as listenPort)' }, direction: { type: 'string', default: 'local', enum: ['local', 'reverse'], description: 'local=listen on this machine, reverse=listen on remote' }, remove: { type: 'boolean', description: 'Remove this forward definition' }, action: { type: 'string', enum: ['start', 'stop', 'remove'], description: 'Manage an existing forward by id' }, id: { type: 'string', description: 'Forward id to manage' } },
      output: okOut,
      async execute(args) {
        const machine = resolveMachine(args.machineId); if (!machine) return { ok: true, text: 'no machine selected' }
        updateForwardPool()
        if (args.action) {
          if (args.action === 'start') { await forwards.startById(String(args.id)); return { ok: true, text: 'forward started' } }
          if (args.action === 'stop') { forwards.stopById(String(args.id)); return { ok: true, text: 'forward stopped' } }
          if (args.action === 'remove') { forwards.removeById(String(args.id)); return { ok: true, text: 'forward removed' } }
        }
        if (args.remove) { forwards.removeById(String(args.id || '')); return { ok: true, text: 'forward removed' } }
        const d = forwards.define({ direction: args.direction === 'reverse' ? 'reverse' : 'local', listenPort: Number(args.listenPort), targetHost: args.targetHost || '127.0.0.1', targetPort: Number(args.targetPort) || Number(args.listenPort), autoStart: true })
        if (forwards.pool && forwards.pool.client) forwards.attach(forwards.pool.client)
        return { ok: true, text: `forward ${d.direction} 127.0.0.1:${d.listenPort} -> ${d.targetHost}:${d.targetPort} created (id=${d.id})` }
      },
    }),
  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }

  // ── system-prompt injection: list all machines + current workspace ────────
  ctx.systemPrompt.section({
    name: 'dsh-ssh-remote',
    order: 88,
    text: () => {
      const all = statusAll()
      const lines = ['## Remote machines (SSH)']
      if (!all.machines.length) {
        lines.push('No machines registered yet — use rw_connect to add one.')
        return lines.join('\n')
      }
      for (const s of all.machines) {
        lines.push(`- [${s.isCurrent ? '*' : ' '}] ${s.id}  ${s.name}  (${s.username}@${s.host}:${s.port})  ${s.connected ? 'connected' : 'not connected'}${s.workspace ? '  ws=' + s.workspace : ''}`)
      }
      lines.push('')
      lines.push('Use the rw_* tools (rw_list_dir / rw_read_file / rw_exec / rw_write_file) to inspect and act on files on the remote hosts. Pass machineId=<id> to target a specific machine; without it, the current machine (*) is used.')
      return lines.join('\n')
    },
  })

  // ── slash command: /remote shows all machines ─────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show all registered remote machines, their connection status, and how to use remote tools.',
      handler: (invocation) => {
        const all = statusAll()
        const lines = []
        if (!all.machines.length) {
          return { kind: 'success', text: 'No machines registered. Use rw_connect or the 设置 → 远程工作区 panel.' }
        }
        for (const s of all.machines) {
          lines.push(`[${s.isCurrent ? '*' : ' '}] ${s.id}  ${s.name}  (${s.username}@${s.host}:${s.port})  connected: ${s.connected ? 'yes' : 'no'}${s.workspace ? '  ws=' + s.workspace : ''}`)
        }
        lines.push('')
        lines.push('Tools: rw_info / rw_connect / rw_switch / rw_pick_workspace / rw_list_dir / rw_read_file / rw_write_file / rw_exec / rw_sync / rw_push / rw_disconnect. Pass machineId to target a specific machine.')
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  }

  // ── JSON endpoints for settings UI ────────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(chunks.join('')))
    })

  

  // ── forwards manager + audit log ──────────────────────────────────────────
  const forwardsFile = () => path.join(homedir(), '.dsh', 'remote-workspaces', 'forwards.json')
  const auditFile = () => path.join(homedir(), '.dsh', 'remote-workspaces', 'audit.log')
  const forwards = new ForwardManager(null, { file: forwardsFile() })

  const audit = (op, cmd, code) => {
    if (!config.auditLog) return
    try {
      const m = currentMachine()
      const line = new Date().toISOString() + ' ' + (m ? m.id + '@' + m.host : '?') + ' ' + op + ' ' + (code != null ? 'exit=' + code : '') + ' ' + cmd + '\n'
      appendFileSync(auditFile(), line, 'utf8')
    } catch {}
  }
  const readAudit = (limit) => {
    try {
      const lines = readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean)
      return lines.slice(-limit)
    } catch { return [] }
  }

  // 更新 ForwardManager 绑定的 pool（跟随 currentMachine）
  const updateForwardPool = () => {
    const m = currentMachine()
    if (!m) { forwards.pool = null; return }
    const p = poolFor(m)
    if (p && p !== forwards.pool) {
      forwards.detach()
      forwards.pool = p
      p.onReady = (client) => forwards.attach(client)
      p.onCloseHook = () => forwards.detach()
      if (p.client) forwards.attach(p.client)
    }
  }
  updateForwardPool()
  setInterval(updateForwardPool, 5000)
const routes = [
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        return sendJson(res, 200, statusAll())
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          let machine
          if (payload.machineId) {
            const i = machineIndex(String(payload.machineId))
            if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
            machine = machines[i]
            poolFor(machine).setTarget({
              host: payload.host || machine.host,
              username: payload.username || machine.username,
              port: payload.port || machine.port,
              password: payload.password !== undefined && payload.password !== '' ? payload.password : undefined,
              privateKeyPath: payload.privateKeyPath || machine.privateKeyPath,
              workspace: payload.workspace !== undefined ? payload.workspace : machine.workspace,
            })
          } else {
            const host = String(payload.host || '').trim()
            if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
            machine = {
              id: machineId(),
              name: String(payload.name || '').trim() || host,
              host,
              port: Number(payload.port) || 22,
              username: String(payload.username || '').trim() || 'root',
              password: payload.password || '',
              privateKeyPath: String(payload.privateKeyPath || '').trim(),
              passphrase: payload.passphrase || '',
              workspace: String(payload.workspace || '').trim(),
            }
            machines.push(machine)
            poolFor(machine)
          }
          await poolFor(machine).exec('echo ok', Math.min(config.commandTimeoutMs, 8000))
          setCurrent(machine.id)
          return sendJson(res, 200, { ok: true, ...statusAll() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/ls',
      handler: async (req, res) => {
        try {
          const m = (req.url || '').match(/path=([^&]*)/)
          const p = m ? decodeURIComponent(m[1]) : (currentMachine()?.workspace || '')
          const machine = currentMachine()
          const out = await listDirStructured(machine, p || '/')
          return sendJson(res, 200, { path: p, items: out.items })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const machine = payload.machineId ? resolveMachine(payload.machineId) : currentMachine()
          if (!machine || !machine.host) return sendJson(res, 400, { ok: false, error: 'no machine' })
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { error: 'path must be an absolute directory' })
          const isDir = await isRemoteDir(machine, p)
          if (!isDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          machine.workspace = p
          saveMachines(machines, store.currentId)
          const local = ensureMirror(p, machine.host, machine.username, machine.port)
          return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...statusAll() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const machine = payload.machineId ? resolveMachine(payload.machineId) : currentMachine()
          if (!machine || !machine.host) return sendJson(res, 400, { ok: false, error: 'no machine' })
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          const pool = poolFor(machine)
          if (pool.client) {
            const isDir = await isRemoteDir(machine, p)
            if (!isDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          }
          const local = ensureMirror(p, machine.host, machine.username, machine.port)
          machine.workspace = p
          saveMachines(machines, store.currentId)
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...statusAll() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const dp = (ctx && ctx.get && ctx.get('directoryPicker')) || (ctx && ctx.directoryPicker) || null
          if (!dp || typeof dp.capability !== 'function') return sendJson(res, 400, { ok: false, error: '本地目录选择器服务不可用（缺少 DSH directory-picker backend）' })
          const cap = await Promise.resolve(dp.capability())
          if (!cap || cap.kind !== 'native' || typeof cap.pick !== 'function') return sendJson(res, 400, { ok: false, error: '本地目录选择器不可用（当前为非原生/浏览后端，请在输入框手动填本地路径）' })
          const pickAbort = new AbortController()
          const signal = pickAbort.signal || null
          const picked = await Promise.resolve(cap.pick(signal))
          pickAbort.abort()
          if (!picked || typeof picked !== 'string') return sendJson(res, 200, { ok: true, cancelled: true })
          return sendJson(res, 200, { ok: true, path: picked })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machines.map(sanitizeMachine), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            if (action === 'add' || action === 'update') {
              const host = String(body.host || '').trim()
              if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
              const rec = {
                id: body.id || machineId(),
                name: String(body.name || '').trim() || host,
                host,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: body.password || '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
              }
              const i = machineIndex(rec.id)
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              if (!store.currentId) { store.currentId = rec.id }
              saveMachines(machines, store.currentId)
              return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              const id = machines[i].id
              pools.get(id)?.pool.close()
              pools.delete(id)
              machines.splice(i, 1)
              if (store.currentId === body.id) store.currentId = machines[0] ? machines[0].id : null
              saveMachines(machines, store.currentId)
              return sendJson(res, 200, { ok: true, machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const probe = new SshPool({
            host: String(body.host || ''),
            port: Number(body.port) || 22,
            username: String(body.username || 'root'),
            password: String(body.password || ''),
            privateKeyPath: String(body.privateKeyPath || ''),
            passphrase: String(body.passphrase || ''),
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
            maxOutputChars: config.maxOutputChars,
          })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', 10000)
          probe.close()
          return sendJson(res, 200, { ok: true, host: probe.config.host, user: probe.config.username, latencyMs: Date.now() - started })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const okSet = setCurrent(String(body.id || ''))
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...statusAll() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/disconnect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const machine = body.machineId ? resolveMachine(body.machineId) : currentMachine()
          if (!machine) return sendJson(res, 200, { ok: true, ...statusAll() })
          pools.get(machine.id)?.pool.close()
          return sendJson(res, 200, { ok: true, ...statusAll() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },    {
      kind: 'exact',
      path: '/dsh-ssh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            const d = forwards.define({ direction: body.direction === 'reverse' ? 'reverse' : 'local', listenPort: Number(body.listenPort), targetHost: body.targetHost || '127.0.0.1', targetPort: Number(body.targetPort) || Number(body.listenPort), autoStart: !!body.autoStart })
            if (forwards.pool && forwards.pool.client) forwards.attach(forwards.pool.client)
            return sendJson(res, 200, { forwards: forwards.list() })
          }
          if (action === 'start') { await forwards.startById(String(body.id)); return sendJson(res, 200, { forwards: forwards.list() }) }
          if (action === 'stop') { forwards.stopById(String(body.id)); return sendJson(res, 200, { forwards: forwards.list() }) }
          if (action === 'remove') { forwards.removeById(String(body.id)); return sendJson(res, 200, { forwards: forwards.list() }) }
          return sendJson(res, 400, { ok: false, error: 'unknown action: ' + action })
        } catch (err) { return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) }) }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-ssh-remote/audit',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://x')
        const limit = parseInt(url.searchParams.get('limit') || '30', 10)
        return sendJson(res, 200, { lines: readAudit(Math.max(limit, 1)) })
      },
    },

  ]

  const disposers = routes.map((r) => webServer.register(r))
  ctx.effect(() => () => {
    for (const [, entry] of pools) entry.pool.close()
    disposers.forEach((d) => d && d())
  }, 'dsh-ssh-remote.routes')
}