# GitHub Desktop WSL

A fork of [GitHub Desktop](https://github.com/desktop/desktop) with native WSL repository support. Open repos living inside WSL (`\\wsl.localhost\...`) and use them just like any other repo — git operations, diffs, commits, push/pull all work seamlessly.

## Why?

GitHub Desktop doesn't support WSL repos. When you try to open a `\\wsl.localhost\` path:

- **Git commands fail or hang** — Desktop runs `git.exe` (Windows) which accesses WSL files through the 9P filesystem protocol. Every `stat()`, `read()`, `open()` is a separate round-trip across the VM boundary. A simple `git status` on a medium repo does thousands of these — it's unusably slow.
- **SSH keys don't work** — Desktop sets `SSH_ASKPASS` to a Windows trampoline binary that breaks when git runs in a WSL context.
- **File operations are slow** — Reading `.git/REBASE_HEAD` or checking if `.git/MERGE_HEAD` exists goes through 9P for each call.

## How it works

Instead of accessing WSL files through 9P, this fork runs a lightweight **daemon inside WSL** that handles everything natively:

```
Official Desktop (slow):
  Desktop → git.exe → 9P → VMBus → WSL VM → 9P server → ext4
  (thousands of round-trips per git command)

This fork (fast):
  Desktop → TCP localhost → daemon → git (native) → ext4
  (one round-trip per command, git runs with direct filesystem access)
```

### Architecture

1. **Persistent daemon** (`wsl-git-daemon`) — A C program that runs inside WSL, listens on TCP `127.0.0.1` with a random port. Handles git commands and file operations (read, write, stat, pathExists, unlink) via a binary length-prefixed protocol. Token-based auth prevents unauthorized access.

2. **TypeScript client** (`app/src/lib/wsl.ts`) — Detects WSL paths, manages the daemon lifecycle (deploy, start, health-check, restart), and provides drop-in replacements for `readFile`, `writeFile`, `pathExists` that route through the daemon for WSL paths and fall through to native `fs` for Windows paths.

3. **Git routing** (`app/src/lib/git/core.ts`) — The single funnel point for all git commands. WSL paths bypass dugite's `exec()` entirely and route through the daemon instead. Git runs natively inside WSL with direct ext4 access and native `~/.ssh/` keys.

4. **Zero setup** — The daemon binary is bundled in the app. On first WSL repo access, Desktop automatically deploys it to `/usr/local/bin/wsl-git-daemon` inside WSL and starts it. If the daemon crashes, it's restarted transparently.

## Install

1. Download **[GitHubDesktopWSLSetup-x64.exe](https://github.com/aleixrodriala/desktop/releases/latest)** from the latest release
2. Run the installer
3. Open a WSL repository — the daemon starts automatically

Windows SmartScreen may warn on first install (the fork is unsigned). Click "More info" then "Run anyway". Once installed, auto-updates work without further warnings.

This fork installs side-by-side with official GitHub Desktop (different app ID: `GitHubDesktopWSL`).

## What's changed from upstream

This fork applies 7 patch commits on top of upstream releases:

| Patch | Files changed | Purpose |
|-------|--------------|---------|
| WSL daemon | `wsl-daemon/daemon.c`, `Makefile` | Persistent C daemon for git + file ops |
| WSL utilities | `app/src/lib/wsl.ts`, `app/src/models/repository.ts` | Path detection, daemon client, lifecycle management |
| Git routing | `app/src/lib/git/core.ts` | Route WSL git commands through daemon |
| File operations | 8 files in `app/src/lib/git/` and `stores/` | WSL-aware `readFile`, `pathExists`, `writeFile` |
| Branding | `app/package.json`, `script/dist-info.ts` | "GitHub Desktop WSL", separate app ID |
| CI/CD | `.github/workflows/sync-upstream.yml`, `build-release.yml` | Auto-sync + build |
| Build | `script/build.ts`, `script/package.ts` | Bundle daemon, skip code signing |

### Patched files (complete list)

```
app/src/lib/wsl.ts                    NEW — daemon client + lifecycle
app/src/lib/git/core.ts               WSL git routing
app/src/models/repository.ts          isWSL getter
app/src/lib/git/diff.ts               WSL file reads
app/src/lib/git/rebase.ts             WSL file reads + pathExists
app/src/lib/git/cherry-pick.ts        WSL file reads + pathExists
app/src/lib/git/merge.ts              WSL pathExists
app/src/lib/git/description.ts        WSL file reads/writes
app/src/lib/git/gitignore.ts          WSL file reads/writes/unlink
app/src/lib/git/submodule.ts          WSL pathExists
app/src/lib/stores/app-store.ts       WSL pathExists
app/package.json                      Name/branding
script/dist-info.ts                   Update URL + Windows identifier
script/build.ts                       Bundle daemon binary
script/package.ts                     Skip code signing + delta
wsl-daemon/daemon.c                   Daemon source
wsl-daemon/Makefile                   Daemon build
.github/workflows/sync-upstream.yml   Auto-sync CI
.github/workflows/build-release.yml   Build + release CI
```

## How auto-sync works

The fork doesn't diverge from upstream. When GitHub Desktop publishes a new release:

1. **`sync-upstream.yml`** runs every 6 hours, checks for new `release-*` tags
2. Creates a branch from the new upstream tag
3. Cherry-picks the 7 WSL patch commits in order
4. If clean: triggers the build workflow automatically
5. If conflict: creates a GitHub Issue with details for manual resolution

This means the fork stays current with upstream releases with minimal maintenance.

## Daemon protocol

The daemon uses a binary length-prefixed protocol over TCP:

```
Frame: [1 byte type][4 bytes payload length (big-endian)][payload]

Types:
  0x01 INIT        client→daemon  JSON: { token, cmd, args, cwd, path }
  0x02 STDIN       client→daemon  raw bytes (for writeFile)
  0x03 STDOUT      daemon→client  raw bytes (git output / file content)
  0x04 STDERR      daemon→client  raw bytes (git stderr)
  0x05 EXIT        daemon→client  4-byte exit code
  0x06 ERROR       daemon→client  UTF-8 error message
  0x07 STAT_RESULT daemon→client  JSON: { exists, size, isDir }
```

Commands: `git`, `readfile`, `writefile`, `stat`, `pathexists`, `unlink`

Auth: daemon writes `{"port": N, "token": "hex"}` to `/tmp/wsl-git-daemon.info` on startup. Client must include the token in every INIT frame.

## Building from source

### Prerequisites

- Node.js (see `.node-version`)
- Yarn 1.x
- GCC (for the daemon, in WSL)

### Build

```bash
# Build daemon (in WSL)
cd wsl-daemon && make

# Install JS dependencies
yarn install

# Development build
yarn build:dev

# Production build
yarn build:prod
```

### Running tests

```bash
# Start daemon
./wsl-daemon/wsl-git-daemon &

# TypeScript type-check (zero errors from patched files)
npx tsc --noEmit

# Webpack compile
yarn compile:dev
```

## Related

- **[wsl-git-shim](https://github.com/aleixrodriala/wsl-git-shim)** — A simpler alternative: a drop-in `git.exe` replacement that routes WSL paths to `wsl.exe -e git`. Works with official Desktop without forking, but slower (spawns `wsl.exe` per git call) and doesn't handle file operations.

## License

[MIT](LICENSE)

## Credits

Based on [GitHub Desktop](https://github.com/desktop/desktop) by GitHub, Inc.

WSL support by [@aleixrodriala](https://github.com/aleixrodriala).
