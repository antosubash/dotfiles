# Ubuntu setup improvements: design

Date: 2026-10-16 · Branch: `feat/ubuntu-setup-improvements`

## Goal & scope

Make `scripts/setup-ubuntu.sh` a reliable, re-runnable, sectioned installer that
actually reconciles this machine (devbox1, Ubuntu 26.04, GNOME 50 Wayland,
i9-13900KF + RTX 4080) to the repo. Fix the bugs found in the audit, close the
gaps between the shell config and what gets installed, add a keyboard-driven
power-user layer, and fix this machine's live problems.

**In scope** (the user picked all four tracks, plus two later requests):

1. Fix the bugs in the setup and update scripts.
2. Close the shell and tool gaps.
3. Restructure `setup-ubuntu.sh` into sections, and move the installers that desktop and server share into a library.
4. Fix this machine: rgb-off, the apt sources, the boot chain, and housekeeping.
5. Add apps found on the machine but missing from setup: dev CLIs, Chrome, Brave and Claude Desktop.
6. **New:** keyboard power-user setup: Ulauncher, keyd, GNOME shortcuts, clipboard history and a text expander.
7. **New:** install NVIDIA-specific things only when an NVIDIA GPU is actually present.

**Out of scope:**

- macOS and Windows scripts. They have the same rc-append bug class, which is noted for a follow-up.
- `setup-gis.sh` internals. It only gets the NVIDIA guard and source-helper changes if touched.
- Deleting user data such as the huggingface cache (9.6G) or Docker volumes. The cleanup only reports it.
- FortiClient and the ChatGPT/Codex app. Both are left as installed.
- The bt-own-address fix, which is already on `fix/bt-own-address-stuck-adapter`.

## Approach

**Chosen:** split the script into section functions and run them through a small runner in the library. Each section runs in its own subshell with `set -euo pipefail`, so one failing section is recorded and the run continues. At the end there is a summary table, and the script exits non-zero if anything failed. Shared install code moves to `scripts/lib/installers.sh`, which both desktop and server call.

**Rejected:**

- **Ansible or another config-management tool.** It adds a heavy dependency to a repo that is all bash, and needs a rewrite of every script.
- **Patching the 695-line flat script in place.** This fixes the bugs but keeps the abort-on-first-error behaviour, the lack of selective runs and the desktop/server copy-paste, which were half of the findings.

## Design

### 1. Section runner (`scripts/lib/setup-common.sh`)

- `run_sections NAME...` runs `section_<name>` for each name in a subshell, records ok / failed / skipped with the duration, and prints a summary table. It returns 1 if any section failed.
- CLI for `setup-ubuntu.sh`:
  - `--list`
  - `--only a,b`
  - `--skip a,b`
  - `-h`
  - Unknown section names are an error.
- **Preflight:**
  - Checks that this is Debian/Ubuntu.
  - Refuses to run as root without `SUDO_USER`.
  - Runs `sudo -v` once, then keeps it alive with a background `sudo -n true` loop that is killed on exit.
  - Fixes PATH once up front (`~/.local/bin`, `~/.cargo/bin`, `/usr/local/go/bin`, `~/go/bin`, `~/.dotnet`, `$PNPM_HOME/bin`), so sections never need to export PATH or touch rc files.
- **Logging:** the full log is tee'd to `~/.local/state/dotfiles/setup-ubuntu-<timestamp>.log`.
- **Environment guards:**
  - `has_systemd`: when it is false (WSL without systemd), sections that need systemd, snap or ufw are skipped with a reason.
  - `is_amd64`: when it is false, the pinned-binary installs are skipped with a reason.
  - `has_nvidia_gpu`: reads sysfs, where vendor `0x10de` and PCI class `0x03xxxx` mean an NVIDIA display device. It does not depend on `lspci`.
- **Pinned tools:**
  - `needs_install CMD PINNED_VERSION [VERSION_ARGS]` returns true when the command is missing or its version output doesn't contain the pin.
  - A bumped pin in `setup-common.sh` is therefore applied on the next run.
  - This applies to Go, yq, lazygit, lazydocker, kubectl, helm, pi and Ulauncher.

### 2. Sections of `setup-ubuntu.sh`, in run order

| Section | Contents |
|---|---|
| `base` | apt: curl, wget, git, htop, btop, fastfetch, vim, nano, build-essential, cmake, net-tools, openssl, unzip, bc, sqlite3, shellcheck, ffmpeg, python-is-python3. Installs **missing packages individually** instead of skipping the whole bundle when git and curl exist. |
| `editor` | neovim |
| `languages` | python3-full, default-jdk, Go (pinned), rustup (`--no-modify-path`) |
| `dotnet` | Channels 7, 8, 9 and 10. Only installs a channel missing from `dotnet --list-sdks`. Downloads the installer into a mktemp dir that is always cleaned up. |
| `cli` | httpie, jq, yq (pinned), curlie, eza, bat (with a `bat` → `batcat` link in `~/.local/bin`), zoxide, atuin (all apt) |
| `security` | gnupg, pass, nmap, and wireshark through a debconf preseed (`install-setuid=true`, `DEBIAN_FRONTEND=noninteractive`). Adds the user to `wireshark`. |
| `ssh-firewall` | openssh-server, `harden_sshd`. **Enables UFW** when it is inactive: deny incoming, allow outgoing, allow OpenSSH, allow in on `tailscale0`. |
| `vpn` | tailscale, wireguard |
| `shell` | tmux, fzf, ripgrep, fd (with the `fd` link), zsh and chsh, Oh My Zsh, **tpm** (cloned into `~/.tmux/plugins/tpm`, plugins installed headless) |
| `git-tools` | lazygit, lazydocker (pinned), gh through `add_apt_source` with a fingerprint |
| `docker` | Docker CE through `add_apt_source` with a fingerprint and the `UBUNTU_CODENAME` suite. Ensures the user is in the `docker` group on every run, and enables the service. When `has_nvidia_gpu` is true, it also installs nvidia-container-toolkit and runs `nvidia-ctk runtime configure --runtime=docker`. |
| `node` | NodeSource Node, pnpm (with the symlink restore), pi (pinned, `~/.local` prefix) |
| `python` | python3-pip, python3-venv, uv |
| `k8s` | kubectl, helm (pinned) |
| `db-gis` | postgresql-client, GDAL, PROJ, GEOS, SpatiaLite |
| `ollama` | vendor installer (as today) |
| `apps` | VLC, GNOME browser connector, Slack, Discord and Zoom (snap), Thunderbird, **Brave (snap)**, **Google Chrome** (apt repo with fingerprint), **Claude Desktop** (apt repo with fingerprint) |
| `keyboard` | runs the new `setup-keyboard.sh` (see §5) |
| `fonts` | one shared `install_fonts`: Nerd Fonts JetBrainsMono and FiraCode, plus MesloLGS. Pinned to a release or commit and verified with sha256. Reused by `setup-terminal.sh` and `fix-fonts.sh`. |
| `nvidia` | **only if `has_nvidia_gpu`**: the nvidia-kernel-guard APT hook (`setup-nvidia-guard.sh`). Skipped with the reason otherwise. |
| `apt-hygiene` | Migrates the known vendor `.list` files to deb822 `.sources` (docker, github-cli, tailscale, claude-desktop, nvidia-container-toolkit), removes `*.curtin.orig`, and runs one `apt update`. |

- The section runs `apt update` once in `base`. `add_apt_source` no longer runs `apt update` itself. The caller does it once per section instead.
- The 150-line version printout becomes a compact loop: `tool: version` or `missing`.

### 3. Shared installers (`scripts/lib/installers.sh`)

- **Moved from copy-paste** in desktop and server into functions:
  - `install_docker`, `install_gh`, `install_rust`, `install_dotnet`, `install_pnpm`, `install_uv`, `install_tpm`, `install_atuin` (apt), `install_cli_extras`, `install_fonts`, `install_pinned_tools`.
- **`setup-server.sh` calls these.** That fixes three bugs: its appends to the tracked `~/.zshrc`/`~/.bashrc`, rustup without `--no-modify-path`, and the wrong uv path. Its flow and headless choices stay the same.
- **`add_apt_source` additions:**
  - Supports flat repos (`SUITE=/`, no components), which nvidia-container-toolkit needs.
  - Removes a matching vendor `.list` under any name passed in an optional `LEGACY_LIST` argument, such as `github-cli.list` and `docker.list`.
- **New fingerprints** are pinned next to the existing ones. Their values come from this machine's trusted keyrings and are re-checked against vendor docs during implementation:

| Vendor | Fingerprint |
|---|---|
| Docker | `9DC858229FC7DD38854AE2D88D81803C0EBFCD88` |
| GitHub CLI | `2C6106201985B60E6C7AC87323F3D4EA75716059` |
| Google | `EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796` |
| Anthropic (Claude Desktop) | `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` |
| NVIDIA container toolkit | `C95B321B61E88C1809C4F759DDCAE044F796ECB0` |

### 4. Update scripts

- **`update-all.sh`:**
  - Dotfiles pull uses `git pull --ff-only`. It is skipped with a warning when the tree is dirty or diverged, and never aborts the run.
  - `pip3 cache purge` and `gpg --refresh-keys` are non-fatal.
  - **Docker cleanup** becomes `docker image prune -f` + `docker builder prune -f --filter until=168h`. It no longer runs `--volumes` and no longer removes stopped containers.
  - Adds a purge of leftover `rc` package configs, and removes `/var/crash/*.crash` older than 14 days.
  - Adds a **"reconcile pinned tools"** step: `setup-ubuntu.sh --only cli,git-tools,k8s,languages`, so pin bumps land through `update`.
  - Reports the space used by `~/.cache` and Docker, but deletes nothing.
  - The summary reports failed steps instead of always saying "completed successfully".
- **`update-quick.sh`:** drops `npm update -g` on Linux. It failed with EACCES against NodeSource's root prefix, and the per-user tools are pinned.
- **`setup-update.sh`:**
  - `update-full`/`upf` no longer pass the rejected `--full`.
  - Removes the broken `go-up` and `pip-up` aliases.
  - Stops appending to the tracked `.bashrc`.
  - `~/.local/bin/update-manager` is renamed `dotfiles-update`, so it stops shadowing Ubuntu's Software Updater.

### 5. Keyboard power-user layer (`scripts/setup-keyboard.sh`, desktop GNOME only)

The whole layer is skipped when there is no GNOME session bus. Everything is set through `gsettings`, so it is idempotent and reversible.

| Piece | What |
|---|---|
| **Ulauncher** 5.16.2 | Pinned `.deb` from its GitHub release, verified with sha256. Autostarts. Wayland can't grab global hotkeys, so a GNOME custom shortcut **Alt+Space → `ulauncher-toggle`** opens it. Alt+Space normally opens the window menu, so that binding is cleared. Super+Space stays the de/us layout switch. |
| **keyd** (apt) | **Caps Lock: tap = Esc, hold = Ctrl**. Applied system-wide at the kernel input level, so it works in Wayland, X apps and TTYs. Config is in `config/keyd/default.conf`, installed to `/etc/keyd/`. |
| **Workspaces** | 6 fixed workspaces. **Super+1…6** switch to one, **Super+Shift+1…6** move a window to one. This disables the Ubuntu dock's Super+N app hotkeys, which clash with these. |
| **Launch shortcuts** | **Super+Return** → Alacritty, **Super+B** → default browser, **Super+E** → Files, **Super+Q** → close window (Alt+F4 kept) |
| **Tiling** | The built-in Ubuntu Tiling Assistant stays enabled with its Super+Arrow tiling. No new tiling extension. |
| **Clipboard history** | **GPaste** (apt `gpaste-2` + shell extension), **Super+V** opens the history. GNOME's Super+V notification list moves to Super+N. |
| **Text expander** | **espanso** (pinned Wayland `.deb`, sha256), registered as a user service. Starter matches go in `config/espanso/match/base.yml`, linked by `install.sh`: `:date`, `:time`, `:isodate`, `:mail` (from git config), `:shrug`. |
| **Cheatsheet** | `docs/keyboard.md` lists every shortcut, and the README links to it. The script prints it at the end. |

### 6. Shell config fixes

- `dc`/`dup`/`ddown` use `docker compose`.
- `TOOL_NEOFETCH` → fastfetch.
- `completion.zsh` sources the apt fzf `key-bindings.zsh` and `completion.zsh` from `/usr/share/doc/fzf/examples/`. atuin is initialised after them, so it owns Ctrl-R and Up, while fzf keeps Ctrl-T and Alt-C.
- `zoxide init zsh` runs when zoxide is installed. It provides `z`/`zi` and leaves `cd` alone.

### 7. This machine

- **rgb-off.service:** find the root cause of `Error: Empty device ID` with systematic debugging. The I2C timeouts make the second detection pass see fewer devices than the first. The fix:
  - Build the args from the **same** detection pass that applies them, or use `--noautoconnect` per-device names.
  - Add `TimeoutStartSec=90`.
  - Make a failure log a clear message instead of `255/EXCEPTION`.
  - Set `After=` on the i2c modules.
  - Re-run `setup-rgb-off.sh`.
- **Boot chain:** `setup-dev-tuning.sh` disables `NetworkManager-wait-online.service` (desktop only), so Docker stops waiting about 7.7 s for the network. It is measured with `systemd-analyze critical-chain` before and after, and reverted if the time to graphical doesn't drop.
- **Apt sources, crash dumps, rc packages:** handled by the `apt-hygiene` section and the update cleanup above.
- **Apply:** I run everything that doesn't need root. Then I hand you **one** command, `! sudo -v && ./scripts/setup-ubuntu.sh`, run from the worktree, plus `setup-rgb-off.sh` and `setup-dev-tuning.sh`. After that I verify: failed units, sources, tools on PATH, the shortcuts, and zsh startup.

## Decisions made (override any at approval)

- **UFW enabled** on the desktop with deny-incoming, allowing SSH and Tailscale. LAN dev servers reached from other devices will need a `ufw allow` rule. Docker-published ports bypass UFW anyway.
- **Ulauncher on Alt+Space.** Super+Space is your de/us layout switch, and Ctrl+Space is IDE autocomplete.
- **Caps Lock = Esc/Ctrl** through keyd.
- **6 fixed workspaces** on Super+N, and the dock's Super+N app launching is turned off.
- **Ulauncher 5.16.2 stable**, not the v6 beta.
- **Clipboard: GPaste.** CopyQ has Wayland hotkey problems.
- **Brave stays a snap**, which matches the machine. Chrome and Claude Desktop come from their apt repos.
- **One PR** with one commit per section or area, rather than several PRs.
- **The new `installers.sh` stays separate from `setup-common.sh`.** `setup-common.sh` keeps the pins and download/verify primitives, which the existing tests cover.
- **The `update-manager` helper is renamed `dotfiles-update`.** The `update` alias is unchanged.
- **The `docker system prune --volumes` call is removed.** It ran on every update and could delete stopped dev-services data.

## Testing

**Unit tests** live in `scripts/tests/` and use the existing `lib.sh` harness:

- **Section runner:**
  - `--list`, `--only` and `--skip`.
  - An unknown section is an error.
  - A failing section doesn't stop the later ones, and the exit code is 1.
  - The summary table.
- **Guards:** `needs_install` (missing, wrong version, pinned version), and `has_nvidia_gpu` against a fake sysfs tree (NVIDIA VGA, NVIDIA non-display, Intel only).
- **`add_apt_source`:** a flat repo, and legacy `.list` removal (with sudo/apt stubbed).
- **rc files:** a contract test that no Linux setup or update script writes to `~/.zshrc`, `~/.bashrc` or `~/.profile`.
- **keyd:** the config parses (`keyd check` if available).
- **Existing:** `test-setup-common.sh` keeps passing, with the pin count updated.

**CI** (`lint.yml`):

- A new job runs `scripts/tests/test-*.sh`. Tests that need local resources skip with a reason.
- shellcheck covers the new files.

**On the machine:**

- A full `setup-ubuntu.sh` run, then a second run that should do no installs (idempotence).
- `--only cli`.
- rgb-off active after a restart of the service.
- Each shortcut checked through `gsettings get`.
- `zsh -i -c exit` timing stays at or below today's 0.5 s.

There is no browser QA, since this is not a web app. `/ship` runs with `--skip-browser`.

## Risks

- **GNOME 50 and GPaste 45.3:** the packaged extension may not declare shell 50. Fallback: skip the clipboard with a warning and note it.
- **espanso on Wayland** needs `cap_dac_override` (setcap) and a user service. If it misbehaves on GNOME 50, the section is made opt-in.
- **The Ulauncher 5 Wayland toggle** relies on `ulauncher-toggle` existing in 5.16. Fallback: `gapplication action io.ulauncher.Ulauncher toggle`, or `ulauncher --no-window` plus a DBus call.
- **The rgb-off root cause** needs root to probe I2C, so it is diagnosed through the one sudo step. If OpenRGB itself is at fault, the unit is made fail-soft and the issue is documented.
- **Running the full setup on a live machine** upgrades pinned tools and changes keybindings. Every gsettings key changed is listed in `docs/keyboard.md` with its old default, so it can be reverted.
- **The `.list` → `.sources` migration** briefly leaves no source if the key download fails. `add_apt_source` writes the new source before removing the old one.
