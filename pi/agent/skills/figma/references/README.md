# Figma CLI setup and reference

A read-only, dependency-free Figma REST client for Python 3.10+. No MCP adapter, browser automation, Figma desktop app, or third-party packages are required.

## 1. Create a token

In Figma's account settings, create a **personal access token** with **`file_content:read`** and an appropriate expiry. Your account must already have access to the file. This scope covers every API endpoint used by the CLI; Variables API and user-profile scopes are not required.

Treat this token like a password. Never paste it into pi/chat, Git, or a shell command argument. Only enter it in your own terminal. Revoking it in Figma invalidates it immediately.

## 2. Provide credentials

### Recommended: `pi/.env`

From the dotfiles repository root, create a local config from the tracked sample if it does not exist:

```bash
(umask 077; cp -n pi/.env.sample pi/.env)
chmod 600 pi/.env
```

Open `pi/.env` in your editor and fill in `FIGMA_TOKEN` yourself. **Do not paste the token into pi/chat.** This file is gitignored; `pi/.env.sample` is tracked and contains no credentials. The CLI automatically loads the `.env` in the `pi/` directory containing its resolved script, even when invoked from another project. Each worktree has its own local `.env`. Do not copy credentials between worktrees automatically.

An already-running pi session can use changes to this file on its next CLI invocation; restarting is unnecessary. Simple `KEY=value` assignments, optional quotes, and comments are supported. No shell commands, `$VARIABLE` substitutions, or multiline values are evaluated. A relative `FIGMA_TOKEN_FILE` in this file is resolved against its containing `pi/` directory. Unknown keys are ignored.

Non-empty exported `FIGMA_TOKEN` or `FIGMA_TOKEN_FILE` overrides dotenv credentials **as a pair**. Within either source, `FIGMA_TOKEN` takes precedence over `FIGMA_TOKEN_FILE`. On POSIX, `.env` must be owned by your user and have mode 600 (or stricter); on Windows, secure it using your account's file ACL.

### Alternative: current shell only (Bash)

Run these commands yourself, outside the agent's tool calls:

```bash
read -rsp 'Figma personal access token: ' FIGMA_TOKEN
printf '\n'
export FIGMA_TOKEN
```

Then start pi from that shell. An already-running pi process will not inherit exports made in another shell. The token exists only in the process environment and is not written by this CLI. Use `unset FIGMA_TOKEN` to clear the shell copy when finished.

### Alternative: private local token file

Save the token outside all repositories using a hidden prompt:

```bash
python3 - <<'PY'
import getpass
import os
from pathlib import Path

path = Path.home() / '.config' / 'pi-figma' / 'token'
path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
token = getpass.getpass('Figma personal access token: ').strip()
if not token or any(c.isspace() for c in token):
    raise SystemExit('Token must be non-empty and contain no whitespace.')
# Refuse to overwrite an existing token. Manage rotation explicitly.
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(token + '\n')
print('Saved a private token file (token not displayed).')
PY
export FIGMA_TOKEN_FILE="$HOME/.config/pi-figma/token"
```

Only the **path export**, not the token, may be added to your local shell configuration. Start pi from that shell. On POSIX systems the CLI refuses a token file owned by another user or readable/writable/executable by group/others; fix permissions with `chmod 600`. On Windows, restrict the file's ACL to your account; POSIX mode checks do not apply. `FIGMA_TOKEN` takes precedence when both variables are configured.

The CLI never saves or modifies credentials itself. It reads only its own `pi/.env`, not arbitrary `.env` files in the calling project. It sends the token only to the fixed `https://api.figma.com/v1` endpoint, refuses authenticated redirects, and does not attach it to asset requests. Keep normal TLS verification enabled.

## 3. Load in pi

The dotfiles installer already links the full `pi/agent/skills` directory:

```bash
./scripts/setup-pi.sh
```

After installing the version containing this skill, restart pi or use `/reload`. Invoke `/skill:figma` or paste a frame link and ask pi to inspect/implement it.

To try an unmerged feature worktree without relinking all your pi configuration, launch pi with the explicit skill path:

```bash
pi --skill /absolute/path/to/feature-worktree/pi/agent/skills/figma/SKILL.md
```

For manual CLI use, an optional shell function keeps commands short (use the actual path if testing a worktree):

```bash
figma() {
  python3 "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/figma/scripts/figma.py" "$@"
}
```

## Commands

All commands accept a quoted Figma URL or a file key. Links may use `/design/`, `/file/`, `/proto/`, or `/board/`, and branch links use the branch key. Links must be HTTPS on `figma.com` or `www.figma.com`. Make URLs are unsupported. `--node 123:456` overrides a link's `node-id`; URL-form `123-456` is normalized.

### Inspect

```bash
figma inspect 'https://www.figma.com/design/FILE_KEY/Name'
figma inspect FILE_KEY --node 123:456 --depth 2
```

Prints JSON containing the file/version, IDs, and a compact design summary. File-only requests default to two levels: pages and top-level objects. For a node, depth is relative to that node. Inspection output is not a complete subtree; `requestedDepth` records the API limit. At most 200 nodes are summarized. Long text has `textTruncated: true`; additional nodes set `nodesTruncated: true`. One REST API call.

### Fetch a frame

```bash
figma fetch 'https://www.figma.com/design/FILE_KEY/Name?node-id=123-456' \
  --out /tmp/my-figma-frame --assets
```

Requires a node ID and a **new** output directory. Creates:

```text
my-figma-frame/
  design.json       Full selected-node response, including vector geometry
  summary.json      Compact node properties and image references
  reference.png     Visual reference, using the node's full bounds
  assets/           Optional, deduplicated original image fills
  manifest.json     Completion marker, provenance, asset paths and SHA-256 hashes
```

Options:

- `--scale 1`: reference render scale, between 0.01 and 4.
- `--assets`: fetch original image fills referenced by the selection. Not every vector/icon: export those nodes separately.
- `--max-assets 20`: refuse to download more than this many distinct image fills. Select a smaller frame or explicitly increase it if needed (maximum 1,000).

The full design response is saved even if the summary is truncated. The reference is pinned to the design response's version when Figma supplies one. Image fills come from the latest file: Figma's image-fill endpoint does not accept a version. For a rapidly changing file, check that the assets still match the reference.

Normally two REST API calls: node data and render. Downloading fills adds one API call when the frame actually references images. Signed asset downloads are separate HTTPS requests, without the API token. PNG/JPEG/GIF/WebP fills with extensionless URLs are recognized by their file signatures; unknown formats retain `.bin` and can be identified locally.

Successful bundles are reusable local evidence. Nothing is automatically refreshed. Existing output paths are refused before any network request. On failure, completed files remain available, but **no `manifest.json` means an incomplete bundle**. Choose a new output directory for a deliberate retry rather than deleting evidence automatically.

### Export an icon or node

```bash
figma export FILE_KEY --node 123:789 --format svg --out /tmp/my-figma-icon
figma export FILE_KEY --node 123:456 --format png --scale 2 --out /tmp/my-figma-preview
```

Formats: `svg` (default), `png`, `jpg`, `pdf`. One render API call plus one asset download. The output directory contains `export.<format>` and a completion manifest. Exports use the current file version. SVG text uses Figma's default outlined rendering; this is a visual asset, not editable application typography.

## Limits and troubleshooting

- **401/403:** check token expiry, `file_content:read`, and your access to the file's plan. A public-looking link does not grant your token additional permissions.
- **404/null node:** use the correct file/branch key and frame ID. `inspect` helps find IDs. Invisible or empty nodes may not render.
- **429:** exits with status **3**, reports numeric `Retry-After` when provided, and never sleeps or automatically retries. Reuse saved bundles or wait. Other runtime errors exit **1**; invalid CLI arguments exit **2**.
- **Rate limits depend on the seat and the plan containing the file.** A paid seat elsewhere does not upgrade a Starter file's limits. REST is not a way around Figma's quotas. See the current official limits rather than assuming a fixed monthly allowance.
- **Size/network limits:** 30-second socket timeout; at most 50 MiB per JSON response or asset. Use smaller selections/scales for large designs. No background downloads or automatic polling.
- Asset hosts must be HTTPS on Figma, Amazon AWS, or CloudFront domains; redirects are rechecked. If Figma changes CDNs, review the new host before updating the allowlist.
- Render signatures are checked (PNG/JPEG/PDF or an SVG root element) before a bundle is marked complete; this is not full image decoding or SVG sanitization. Unknown image-fill formats retain `.bin` when their URL has no recognized extension.
- Raw design responses and images can contain private information and signed URLs. Output directories are created with mode 700 and files with mode 600 on POSIX. Do not commit entire bundles or publish them without permission. SVGs are downloaded, not executed; review before inlining.
- This CLI does **not** return official MCP `get_design_context` output, Code Connect mappings, or resolved Variables API collections/modes. It preserves component/style metadata and variable bindings already in the file response. Use the project's design system and report unresolved tokens rather than inventing values.

## Offline tests

From the dotfiles repository root:

```bash
python3 -B -m unittest discover -s scripts/tests -p 'test_figma_*.py' -v
```

No real Figma token or network access is required. A live end-to-end check requires your own token and accessible frame link; it consumes API quota.

## Official API references

- [Authentication](https://developers.figma.com/docs/rest-api/authentication/)
- [File, node, render, and image-fill endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)
- [Rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)
