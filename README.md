# GitHub Desktop WSL

A fork of [GitHub Desktop](https://github.com/desktop/desktop) with full WSL repository support. Open repos inside WSL and use them exactly like Windows repos — commits, diffs, push, pull, branch switching, everything works.

**[Download latest release](https://github.com/aleixrodriala/desktop/releases/latest)** | Installs side-by-side with official Desktop

## Performance

Git operations on WSL repos are **7-30x faster** than official Desktop, which tries to access WSL files through the 9P filesystem bridge. We bypass 9P entirely with a native daemon.

Benchmarks on `desktop/desktop` (2,372 files), median of 5 runs:

| Operation | This fork | Official Desktop (9P) | Speedup |
|-----------|----------:|----------------------:|--------:|
| `git status` | 8 ms | 52 ms | **6.8x** |
| `git log -50` | 5 ms | 48 ms | **10.6x** |
| `git diff HEAD~1` | 4 ms | 50 ms | **12.2x** |
| `git branch -a` | 3 ms | 49 ms | **18.2x** |
| `git rev-parse` | 2 ms | 50 ms | **29.5x** |
| `for-each-ref` | 3 ms | 49 ms | **14.2x** |
| Full refresh cycle | 13 ms | 91 ms | **6.8x** |

> The "refresh cycle" measures what Desktop does every time you switch repos: `git status` + `for-each-ref` + 3 `pathExists` checks. With official Desktop this takes ~100ms per cycle on a medium repo, causing noticeable UI lag. With this fork it's imperceptible.

### Why it's faster

```
Official Desktop:
  Desktop  -->  git.exe  -->  9P client  -->  VMBus  -->  WSL VM  -->  ext4
  Every stat(), read(), open() is a round-trip across the VM boundary.
  git status on 2,372 files = thousands of 9P round-trips.

This fork:
  Desktop  -->  TCP  -->  daemon  -->  git (native)  -->  ext4
  Git runs inside WSL with direct filesystem access.
  One TCP round-trip per command, not per file.
```

## Install

1. Download **[GitHubDesktopWSLSetup-x64.exe](https://github.com/aleixrodriala/desktop/releases/latest)**
2. Run the installer
3. Open a WSL repository — everything else is automatic

The daemon is bundled inside the app. On first WSL repo access it's deployed to `~/.local/bin/` in your WSL distro and started automatically. If it crashes, it restarts transparently on the next operation.

> Windows SmartScreen may warn on first install (the fork is unsigned). Click "More info" then "Run anyway".

## What it fixes

| Problem in official Desktop | How this fork solves it |
|---|---|
| Git commands hang or timeout on `\\wsl.localhost\` paths | Git runs natively inside WSL via the daemon |
| SSH keys in `~/.ssh/` aren't accessible | Daemon runs in WSL — SSH keys work natively |
| `SSH_ASKPASS` trampoline breaks WSL ssh | Stripped from daemon environment |
| File reads (diffs, rebase state) go through 9P | Routed through daemon with direct syscalls |
| Can't delete WSL repos (Recycle Bin fails on UNC paths) | Delete via `wsl.exe rm -rf` |
| Branch dates missing | Fixed stdin support for `git log --stdin` |

## Architecture

```
  GitHub Desktop WSL (Windows)
  ┌──────────────────────────────────────┐
  │  core.ts ─── isWSLPath? ──> wsl.ts  │
  │                                │     │
  │              TCP localhost     │     │
  └────────────────────────────────┼─────┘
                                   │
  WSL (Linux)                      v
  ┌──────────────────────────────────────┐
  │  wsl-git-daemon (C, ~550 lines)     │
  │  ├── git commands (fork+exec)       │
  │  ├── file read/write (open+read)    │
  │  ├── stat / pathExists              │
  │  └── token auth + localhost-only    │
  └──────────────────────────────────────┘
```

**Key components:**

- **`wsl-git-daemon`** — C daemon (~550 lines), zero dependencies, runs in WSL on TCP localhost. Binary length-prefixed protocol. Token-based auth via `/tmp/wsl-git-daemon.info`. Auto-daemonizes with `--daemonize` flag.

- **`wsl.ts`** — TypeScript daemon client (~420 lines). Manages the full lifecycle: detect WSL path → extract distro → deploy binary → start daemon → connect → execute → auto-restart on failure. Drop-in wrappers (`wslReadFile`, `wslPathExists`, etc.) route through daemon for WSL paths, fall through to native `fs` for Windows paths.

- **`core.ts` patch** — Single `if (isWSLPath(path))` check in the git funnel point. WSL repos bypass dugite entirely; Windows repos are completely unchanged.

## Auto-sync with upstream

The fork stays current automatically:

1. **`sync-upstream.yml`** checks for new upstream releases every 6 hours
2. Cherry-picks the WSL patch commits onto the new release tag
3. If clean: builds and publishes automatically
4. If conflict: opens a GitHub Issue for manual resolution

Patch commits are a linear series — easy to maintain and rebase.

## Patched files

```
NEW   wsl-daemon/daemon.c                  Persistent daemon (C)
NEW   wsl-daemon/Makefile                  Daemon build
NEW   app/src/lib/wsl.ts                   Daemon client + lifecycle + wrappers
PATCH app/src/lib/git/core.ts              WSL git routing
PATCH app/src/main-process/main.ts         WSL delete handler
PATCH app/src/models/repository.ts         isWSL getter
PATCH app/src/lib/git/diff.ts              WSL-aware readFile
PATCH app/src/lib/git/rebase.ts            WSL-aware readFile + pathExists
PATCH app/src/lib/git/cherry-pick.ts       WSL-aware readFile + pathExists
PATCH app/src/lib/git/merge.ts             WSL-aware pathExists
PATCH app/src/lib/git/description.ts       WSL-aware readFile + writeFile
PATCH app/src/lib/git/gitignore.ts         WSL-aware readFile + writeFile + unlink
PATCH app/src/lib/git/submodule.ts         WSL-aware pathExists
PATCH app/src/lib/stores/app-store.ts      WSL-aware pathExists
PATCH app/package.json                     "GitHub Desktop WSL" branding
PATCH script/dist-info.ts                  Update URL + app ID
PATCH script/build.ts                      Bundle daemon binary
PATCH script/package.ts                    Skip code signing
NEW   .github/workflows/sync-upstream.yml  Auto-sync CI
NEW   .github/workflows/build-release.yml  Build + release CI
```

## Daemon protocol

Binary length-prefixed frames over TCP:

```
Frame: [1 byte type][4 bytes length (big-endian)][payload]

  INIT (0x01)        client→daemon  JSON { token, cmd, args, cwd, stdin, path }
  STDIN (0x02)       client→daemon  raw bytes (writeFile content)
  STDOUT (0x03)      daemon→client  raw bytes
  STDERR (0x04)      daemon→client  raw bytes
  EXIT (0x05)        daemon→client  4-byte exit code
  ERROR (0x06)       daemon→client  UTF-8 error message
  STAT_RESULT (0x07) daemon→client  JSON { exists, size, isDir }

Commands: git, readfile, writefile, stat, pathexists, unlink
```

## Building from source

```bash
# Build daemon (in WSL)
cd wsl-daemon && make

# Install JS dependencies (on Windows)
yarn install

# Development build
yarn build:dev

# Production build + package
yarn build:prod
SKIP_CODE_SIGNING=1 yarn package
```

## Related

- **[wsl-git-shim](https://github.com/aleixrodriala/wsl-git-shim)** — Simpler alternative: drop-in `git.exe` replacement that routes WSL paths to `wsl.exe -e git`. Works with official Desktop without forking, but slower (spawns `wsl.exe` per git call, no file operation support).

## License

[MIT](LICENSE)

## Credits

Based on [GitHub Desktop](https://github.com/desktop/desktop) by GitHub, Inc.

WSL support by [@aleixrodriala](https://github.com/aleixrodriala).
