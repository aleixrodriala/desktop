/**
 * WSL utilities and daemon client for GitHub Desktop WSL.
 *
 * Detects WSL paths (\\wsl.localhost\... or \\wsl$\...),
 * converts them to Linux paths, and communicates with the
 * wsl-git-daemon over TCP for git commands and file operations.
 */

import * as net from 'net'

/* ── WSL Path Detection ──────────────────────────────────────────────── */

const WSL_PATH_RE = /^\\\\wsl[.$\\]/i

export function isWSLPath(p: string): boolean {
  return WSL_PATH_RE.test(p)
}

/**
 * Parse a Windows WSL UNC path into distro name and Linux path.
 * \\wsl.localhost\Ubuntu-24.04\home\user → { distro: 'Ubuntu-24.04', linuxPath: '/home/user' }
 */
export function parseWSLPath(winPath: string): {
  distro: string
  linuxPath: string
} {
  let start: string
  if (winPath.toLowerCase().startsWith('\\\\wsl.localhost\\')) {
    start = winPath.slice(16)
  } else if (winPath.toLowerCase().startsWith('\\\\wsl$\\')) {
    start = winPath.slice(7)
  } else {
    throw new Error(`Not a WSL path: ${winPath}`)
  }

  const slashIdx = start.indexOf('\\')
  if (slashIdx === -1) {
    return { distro: start, linuxPath: '/' }
  }

  const distro = start.slice(0, slashIdx)
  const linuxPath = start.slice(slashIdx).replace(/\\/g, '/')
  return { distro, linuxPath }
}

/* ── Frame Protocol ──────────────────────────────────────────────────── */

const FRAME_INIT = 0x01
const FRAME_STDIN = 0x02
const FRAME_STDOUT = 0x03
const FRAME_STDERR = 0x04
const FRAME_EXIT = 0x05
const FRAME_ERROR = 0x06
const FRAME_STAT_RESULT = 0x07

interface DaemonInfo {
  port: number
  token: string
}

let cachedInfo: DaemonInfo | null = null
let cachedInfoMtime: number = 0
let cachedDistro: string | null = null

const DAEMON_INFO_LINUX_PATH = '/tmp/wsl-git-daemon.info'
// Use ~/.local/bin so we don't need sudo. $HOME is expanded by sh -c.
const DAEMON_DEPLOY_DIR = '$HOME/.local/bin'
const DAEMON_DEPLOY_BIN = '$HOME/.local/bin/wsl-git-daemon'

/** Get the UNC path to the daemon info file for a given distro */
function getDaemonInfoUNCPath(distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\tmp\\wsl-git-daemon.info`
}

/**
 * Read daemon connection info.
 * Tries UNC path (Windows/Electron context) first, falls back to Linux path.
 */
function readDaemonInfo(distro?: string): DaemonInfo {
  const fs = require('fs')
  const pathsToTry: string[] = []

  if (distro) {
    pathsToTry.push(getDaemonInfoUNCPath(distro))
  }
  if (cachedDistro) {
    pathsToTry.push(getDaemonInfoUNCPath(cachedDistro))
  }
  // Fallback for running inside WSL directly (dev/test)
  pathsToTry.push(DAEMON_INFO_LINUX_PATH)

  for (const infoPath of pathsToTry) {
    try {
      const stat = fs.statSync(infoPath)
      if (cachedInfo && stat.mtimeMs === cachedInfoMtime) {
        return cachedInfo
      }
      const raw = fs.readFileSync(infoPath, 'utf8')
      cachedInfo = JSON.parse(raw.trim())
      cachedInfoMtime = stat.mtimeMs
      return cachedInfo!
    } catch {
      continue
    }
  }

  throw new Error('Cannot read daemon info — daemon not running')
}

function sendFrame(
  socket: net.Socket,
  type: number,
  data: Buffer | string
): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const hdr = Buffer.alloc(5)
  hdr[0] = type
  hdr.writeUInt32BE(buf.length, 1)
  socket.write(hdr)
  if (buf.length > 0) {
    socket.write(buf)
  }
}

interface DaemonResponse {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
  statResult?: string
}

/**
 * Connect to daemon, send INIT frame, collect response frames.
 */
function daemonRequestRaw(info: DaemonInfo, initPayload: object): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let statResult: string | undefined
    let exitCode = -1
    let incomingBuf = Buffer.alloc(0)

    socket.connect(info.port, '127.0.0.1', () => {
      const payload = JSON.stringify({ token: info.token, ...initPayload })
      sendFrame(socket, FRAME_INIT, payload)
    })

    socket.on('data', (chunk: Buffer) => {
      incomingBuf = Buffer.concat([incomingBuf, chunk])

      while (incomingBuf.length >= 5) {
        const frameType = incomingBuf[0]
        const frameLen = incomingBuf.readUInt32BE(1)
        if (incomingBuf.length < 5 + frameLen) break

        const frameData = incomingBuf.slice(5, 5 + frameLen)
        incomingBuf = incomingBuf.slice(5 + frameLen)

        switch (frameType) {
          case FRAME_STDOUT:
            stdoutChunks.push(frameData)
            break
          case FRAME_STDERR:
            stderrChunks.push(frameData)
            break
          case FRAME_EXIT:
            exitCode = frameData.readUInt32BE(0)
            socket.end()
            break
          case FRAME_ERROR:
            socket.end()
            reject(new Error(`Daemon error: ${frameData.toString('utf8')}`))
            return
          case FRAME_STAT_RESULT:
            statResult = frameData.toString('utf8')
            break
        }
      }
    })

    socket.on('end', () => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode,
        statResult,
      })
    })

    socket.on('error', (err: Error) => {
      reject(new Error(`Daemon connection failed: ${err.message}`))
    })

    socket.setTimeout(300_000, () => {
      socket.destroy()
      reject(new Error('Daemon request timed out'))
    })
  })
}

/**
 * Send a request to the daemon, auto-starting it if needed.
 * Retries once after starting the daemon on connection failure.
 */
async function daemonRequest(
  initPayload: object,
  distro?: string
): Promise<DaemonResponse> {
  // First attempt: try connecting to existing daemon
  try {
    const info = readDaemonInfo(distro)
    return await daemonRequestRaw(info, initPayload)
  } catch {
    // Connection failed — daemon probably not running
  }

  // Second attempt: start daemon and retry
  const d = distro || cachedDistro
  if (!d) {
    throw new Error(
      'WSL daemon is not running and no distro is known. ' +
        'Open a WSL repository first.'
    )
  }
  await startDaemon(d)
  const info = readDaemonInfo(d)
  return daemonRequestRaw(info, initPayload)
}

/* ── Daemon Lifecycle Management ──────────────────────────────────────── */

import * as Path from 'path'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * Get the path to the bundled daemon binary.
 * In production: __dirname points to the app's resources/out directory.
 * In development: falls back to the source tree.
 */
function getBundledDaemonPath(): string {
  // Production build: binary is copied to out/ by build.ts
  const prodPath = Path.resolve(__dirname, 'wsl-git-daemon')
  if (existsSync(prodPath)) {
    return prodPath
  }
  // Development: use the binary built in wsl-daemon/
  const devPath = Path.resolve(__dirname, '..', '..', 'wsl-daemon', 'wsl-git-daemon')
  if (existsSync(devPath)) {
    return devPath
  }
  throw new Error(
    'wsl-git-daemon binary not found. Build it: cd wsl-daemon && make'
  )
}

/**
 * Deploy the daemon binary into the WSL distro if not already present
 * or if our bundled version is newer.
 */
function wslExec(distro: string, shellCmd: string, opts?: { encoding?: 'utf8', timeout?: number }): string {
  return execFileSync(
    'wsl.exe',
    ['-d', distro, '-e', 'sh', '-c', shellCmd],
    { timeout: opts?.timeout ?? 5000, encoding: opts?.encoding, stdio: opts?.encoding ? undefined : 'pipe' }
  ) as unknown as string
}

function deployDaemon(distro: string): void {
  const bundledPath = getBundledDaemonPath()

  // Check if daemon already exists in WSL
  try {
    wslExec(distro, `test -x ${DAEMON_DEPLOY_BIN}`)
    // Binary exists — check if we need to update it
    const localSize = require('fs').statSync(bundledPath).size
    const remoteSize = wslExec(distro, `stat -c '%s' ${DAEMON_DEPLOY_BIN}`, { encoding: 'utf8' }).trim()
    if (String(localSize) === remoteSize) {
      return // same size, assume up to date
    }
  } catch {
    // Binary doesn't exist or check failed — deploy it
  }

  // Convert Windows path to WSL path
  const wslBundledPath = wslExec(distro, `wslpath -a '${bundledPath.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' }).trim()

  // Ensure directory exists, copy, and make executable
  wslExec(distro, `mkdir -p ${DAEMON_DEPLOY_DIR} && cp "${wslBundledPath}" ${DAEMON_DEPLOY_BIN} && chmod 755 ${DAEMON_DEPLOY_BIN}`, { timeout: 10000 })
}

/**
 * Start the daemon in the given WSL distro and wait for it to be ready.
 */
async function startDaemon(distro: string): Promise<void> {
  // Deploy binary if needed
  deployDaemon(distro)

  // Kill any stale daemon
  try {
    wslExec(distro, 'pkill -f wsl-git-daemon 2>/dev/null; rm -f /tmp/wsl-git-daemon.info')
  } catch {
    // Ignore — no daemon to kill
  }

  // Start daemon in background using --daemonize (forks, writes info file, parent exits)
  execFileSync(
    'wsl.exe',
    ['-d', distro, '-e', 'sh', '-c', `${DAEMON_DEPLOY_BIN} --daemonize`],
    { timeout: 10000, stdio: 'pipe' }
  )

  // Wait for the info file to be visible from Windows (poll every 100ms, max 5s)
  const infoPath = getDaemonInfoUNCPath(distro)
  const fs = require('fs')
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    try {
      const raw = fs.readFileSync(infoPath, 'utf8')
      const info = JSON.parse(raw.trim())
      if (info.port && info.token) {
        cachedInfo = info
        cachedDistro = distro
        return
      }
    } catch {
      continue
    }
  }

  throw new Error(
    `Daemon failed to start in WSL distro "${distro}" within 5 seconds`
  )
}

/**
 * Extract distro from a WSL path and remember it.
 */
function resolveDistro(wslPath: string): string {
  const { distro } = parseWSLPath(wslPath)
  cachedDistro = distro
  return distro
}

/* ── Public API ──────────────────────────────────────────────────────── */

export interface DaemonGitResult {
  stdout: string | Buffer
  stderr: string
  exitCode: number
}

/**
 * Execute a git command via the daemon.
 * This is the WSL equivalent of dugite's exec().
 * Automatically starts the daemon if not running.
 */
export async function daemonExecGit(
  args: string[],
  cwd: string,
  options?: { encoding?: 'buffer' | BufferEncoding; stdin?: string }
): Promise<DaemonGitResult> {
  const distro = isWSLPath(cwd) ? resolveDistro(cwd) : undefined
  const linuxCwd = isWSLPath(cwd) ? parseWSLPath(cwd).linuxPath : cwd

  const payload: Record<string, unknown> = { cmd: 'git', args, cwd: linuxCwd }
  if (options?.stdin) {
    payload.stdin = options.stdin
  }

  const result = await daemonRequest(payload, distro)

  return {
    stdout:
      options?.encoding === 'buffer'
        ? result.stdout
        : result.stdout.toString(
            (options?.encoding as BufferEncoding) || 'utf8'
          ),
    stderr: result.stderr.toString('utf8'),
    exitCode: result.exitCode,
  }
}

/**
 * Read a file inside WSL via the daemon.
 * Drop-in replacement for fs.readFile on WSL paths.
 */
export async function daemonReadFile(
  winPath: string,
  encoding?: 'utf8'
): Promise<string | Buffer> {
  const distro = isWSLPath(winPath) ? resolveDistro(winPath) : undefined
  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest(
    { cmd: 'readfile', path: linuxPath },
    distro
  )

  if (result.exitCode !== 0) {
    throw new Error(`Failed to read ${winPath}`)
  }

  return encoding === 'utf8' ? result.stdout.toString('utf8') : result.stdout
}

/**
 * Write a file inside WSL via the daemon.
 */
export async function daemonWriteFile(
  winPath: string,
  content: string | Buffer
): Promise<void> {
  const distro = isWSLPath(winPath) ? resolveDistro(winPath) : undefined
  // Ensure daemon is running before we connect
  try {
    readDaemonInfo(distro)
  } catch {
    if (distro) await startDaemon(distro)
  }
  const info = readDaemonInfo(distro)
  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  return new Promise((resolve, reject) => {
    const socket = new net.Socket()

    socket.connect(info.port, '127.0.0.1', () => {
      const payload = JSON.stringify({
        token: info.token,
        cmd: 'writefile',
        path: linuxPath,
      })
      sendFrame(socket, FRAME_INIT, payload)

      // Send content as STDIN frame
      const buf =
        typeof content === 'string' ? Buffer.from(content, 'utf8') : content
      sendFrame(socket, FRAME_STDIN, buf)
      // Send empty STDIN as EOF
      sendFrame(socket, FRAME_STDIN, Buffer.alloc(0))
    })

    let incomingBuf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      incomingBuf = Buffer.concat([incomingBuf, chunk])
      while (incomingBuf.length >= 5) {
        const frameType = incomingBuf[0]
        const frameLen = incomingBuf.readUInt32BE(1)
        if (incomingBuf.length < 5 + frameLen) break
        const frameData = incomingBuf.slice(5, 5 + frameLen)
        incomingBuf = incomingBuf.slice(5 + frameLen)

        if (frameType === FRAME_EXIT) {
          socket.end()
          resolve()
        } else if (frameType === FRAME_ERROR) {
          socket.end()
          reject(new Error(`Daemon write error: ${frameData.toString('utf8')}`))
        }
      }
    })

    socket.on('error', reject)
    socket.setTimeout(30_000, () => {
      socket.destroy()
      reject(new Error('Write timed out'))
    })
  })
}

/**
 * Delete a file inside WSL via the daemon.
 */
export async function daemonUnlink(winPath: string): Promise<void> {
  const distro = isWSLPath(winPath) ? resolveDistro(winPath) : undefined
  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest(
    { cmd: 'unlink', path: linuxPath },
    distro
  )

  if (result.exitCode !== 0) {
    throw new Error(`Failed to unlink ${winPath}`)
  }
}

/**
 * Check if a path exists inside WSL.
 */
export async function daemonPathExists(winPath: string): Promise<boolean> {
  const distro = isWSLPath(winPath) ? resolveDistro(winPath) : undefined
  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest(
    { cmd: 'pathexists', path: linuxPath },
    distro
  )

  if (result.statResult) {
    const parsed = JSON.parse(result.statResult)
    return parsed.exists === true
  }
  return false
}

/**
 * Stat a path inside WSL.
 */
export async function daemonStat(
  winPath: string
): Promise<{ exists: boolean; size: number; isDir: boolean }> {
  const distro = isWSLPath(winPath) ? resolveDistro(winPath) : undefined
  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest(
    { cmd: 'stat', path: linuxPath },
    distro
  )

  if (result.statResult) {
    return JSON.parse(result.statResult)
  }
  return { exists: false, size: 0, isDir: false }
}

/* ── WSL-aware wrappers (drop-in replacements) ───────────────────────── */

import { readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink } from 'fs/promises'
import { pathExists as localPathExists } from '../ui/lib/path-exists'

/**
 * Read a file — routes through daemon for WSL paths, direct fs otherwise.
 */
export async function wslReadFile(
  filePath: string,
  encoding: 'utf8'
): Promise<string>
export async function wslReadFile(filePath: string): Promise<Buffer>
export async function wslReadFile(
  filePath: string,
  encoding?: 'utf8'
): Promise<string | Buffer> {
  if (isWSLPath(filePath)) {
    return daemonReadFile(filePath, encoding)
  }
  return encoding ? fsReadFile(filePath, encoding) : fsReadFile(filePath)
}

/**
 * Write a file — routes through daemon for WSL paths, direct fs otherwise.
 */
export async function wslWriteFile(
  filePath: string,
  content: string | Buffer
): Promise<void> {
  if (isWSLPath(filePath)) {
    return daemonWriteFile(filePath, content)
  }
  return fsWriteFile(filePath, content)
}

/**
 * Check if path exists — routes through daemon for WSL paths.
 */
export async function wslPathExists(filePath: string): Promise<boolean> {
  if (isWSLPath(filePath)) {
    return daemonPathExists(filePath)
  }
  return localPathExists(filePath)
}

/**
 * Unlink a file — routes through daemon for WSL paths.
 */
export async function wslUnlink(filePath: string): Promise<void> {
  if (isWSLPath(filePath)) {
    return daemonUnlink(filePath)
  }
  return fsUnlink(filePath)
}
