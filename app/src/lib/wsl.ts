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

const DAEMON_INFO_PATH = '\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\wsl-git-daemon.info'
const DAEMON_INFO_LINUX = '/tmp/wsl-git-daemon.info'

function readDaemonInfo(): DaemonInfo {
  // In the Electron app (Windows), we read via the UNC path
  // In dev/test, we might be in WSL directly
  try {
    const fs = require('fs')
    let infoPath = DAEMON_INFO_PATH
    // Try UNC path first (Windows context), fall back to Linux path
    try {
      fs.accessSync(infoPath)
    } catch {
      infoPath = DAEMON_INFO_LINUX
    }
    const stat = fs.statSync(infoPath)
    if (cachedInfo && stat.mtimeMs === cachedInfoMtime) {
      return cachedInfo
    }
    const raw = fs.readFileSync(infoPath, 'utf8')
    cachedInfo = JSON.parse(raw.trim())
    cachedInfoMtime = stat.mtimeMs
    return cachedInfo!
  } catch (e: any) {
    throw new Error(
      `Cannot read daemon info (is wsl-git-daemon running?): ${e.message}`
    )
  }
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

/**
 * Connect to daemon, send INIT frame, collect response frames.
 */
function daemonRequest(
  initPayload: object
): Promise<{
  stdout: Buffer
  stderr: Buffer
  exitCode: number
  statResult?: string
}> {
  const info = readDaemonInfo()

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

      // Parse frames from buffer
      while (incomingBuf.length >= 5) {
        const frameType = incomingBuf[0]
        const frameLen = incomingBuf.readUInt32BE(1)
        if (incomingBuf.length < 5 + frameLen) break // incomplete

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
      reject(
        new Error(`Daemon connection failed (is wsl-git-daemon running?): ${err.message}`)
      )
    })

    // Timeout after 5 minutes (git operations can be slow)
    socket.setTimeout(300_000, () => {
      socket.destroy()
      reject(new Error('Daemon request timed out'))
    })
  })
}

/* ── Daemon auto-start ───────────────────────────────────────────────── */

let daemonStartAttempted = false

/**
 * Ensure the daemon is running. Starts it via wsl.exe if needed.
 * Called lazily on first WSL operation.
 */
export function ensureDaemonRunning(): void {
  if (daemonStartAttempted) return
  daemonStartAttempted = true

  try {
    readDaemonInfo()
    return // daemon already running
  } catch {
    // Need to start it
  }

  try {
    // Start daemon in background via wsl.exe
    const { execFile } = require('child_process')
    execFile(
      'wsl.exe',
      ['-e', 'sh', '-c', 'nohup wsl-git-daemon >/dev/null 2>&1 &'],
      { timeout: 5000 },
      () => {
        // Don't care about result — daemon detaches itself
      }
    )
    // Give it a moment to write the info file
    // We'll retry readDaemonInfo on first actual request
  } catch {
    // If we can't start it, operations will fail with a clear error
  }
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
 */
export async function daemonExecGit(
  args: string[],
  cwd: string,
  options?: { encoding?: 'buffer' | BufferEncoding }
): Promise<DaemonGitResult> {
  ensureDaemonRunning()

  // Convert Windows WSL path to Linux path for the daemon
  const linuxCwd = isWSLPath(cwd) ? parseWSLPath(cwd).linuxPath : cwd

  const result = await daemonRequest({
    cmd: 'git',
    args,
    cwd: linuxCwd,
  })

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
  ensureDaemonRunning()

  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest({
    cmd: 'readfile',
    path: linuxPath,
  })

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
  ensureDaemonRunning()

  const info = readDaemonInfo()
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
  ensureDaemonRunning()

  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest({
    cmd: 'unlink',
    path: linuxPath,
  })

  if (result.exitCode !== 0) {
    throw new Error(`Failed to unlink ${winPath}`)
  }
}

/**
 * Check if a path exists inside WSL.
 */
export async function daemonPathExists(winPath: string): Promise<boolean> {
  ensureDaemonRunning()

  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest({
    cmd: 'pathexists',
    path: linuxPath,
  })

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
  ensureDaemonRunning()

  const linuxPath = isWSLPath(winPath)
    ? parseWSLPath(winPath).linuxPath
    : winPath

  const result = await daemonRequest({
    cmd: 'stat',
    path: linuxPath,
  })

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
