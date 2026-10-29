# Tvijo Code

Tvijo Code is a code editor built from the open-source VS Code sources (Code - OSS),
with the [Tvijo DSHREM](https://dsh.tvijo.com) extension built in.

It is built by this repository's GitHub Actions from the official `microsoft/vscode` tag,
using the [VSCodium](https://github.com/VSCodium/vscodium) build scripts:

- Microsoft telemetry is removed at build time (VSCodium patches).
- Extensions come from [Open VSX](https://open-vsx.org), not the Microsoft Marketplace.
- Auto-update is off; new versions are published on the [Releases](https://github.com/nikbibamon/tvijocode/releases) page.
- The Tvijo DSHREM extension is embedded as a built-in at a pinned version and SHA-256
  ([`tvijo/extensions.lock.json`](tvijo/extensions.lock.json)).

This repository also hosts the **Tvijo DSHREM MCP server** in [`mcp/`](mcp/)
(`npm i -g tvijo-dshrem-mcp`, registry name `com.tvijo/dshrem`).

## Download

The 1.140.07215 candidate pins Tvijo DSHREM 0.10.25. Its manual candidate
workflows retain Windows, macOS and Linux artifacts and native smoke evidence;
they do not publish releases. Each channel remains unavailable until its exact
artifact passes its own native checks and is independently published. Linux
package installers and macOS notarization are separate from desktop ZIP/TAR checks.

Test builds are on [Releases](https://github.com/nikbibamon/tvijocode/releases).
During the test phase only **Windows 10/11 x64** is built
(`TvijoCodeUserSetup-x64-*.exe` installs without admin rights; the `.zip` is portable).
macOS and Linux builds follow after a series of passing Windows tests; their
workflows are kept in `.github/workflows/` but disabled.

Builds are **not code-signed yet**: SmartScreen shows "unknown publisher" on first
run (More info → Run anyway).

## When it does NOT work

- You rely on Microsoft-only extensions (Remote - SSH, Live Share, the Microsoft C# and
  Python language servers, Copilot). Their licenses allow them only in Microsoft builds;
  they are not on Open VSX.
- You need signed installers for managed or corporate machines. Wait for signed builds.
- You need auto-update. Install new versions from Releases by hand for now.

## How the build is organised

Everything Tvijo-specific lives in [`tvijo/`](tvijo/); upstream VSCodium files are left
as they are except one hook line in `prepare_vscode.sh`:

| File | Purpose |
|---|---|
| `tvijo/product.json` | Name, application id, installer GUIDs, URLs (merged over VSCodium's) |
| `tvijo/brand.sh` | Applies the branding inside the `vscode/` tree during `prepare_vscode.sh` |
| `tvijo/make_icons.py` | Regenerates every icon and installer image from one glyph (Pillow) |
| `tvijo/embed_extensions.sh` | Downloads pinned extensions, checks SHA-256, embeds them as built-ins |
| `tvijo/smoke_windows.sh` | CI check of the portable zip: name, gallery, update off, extension, `--version` |

Updating to a new VS Code version = merge the matching VSCodium tag, keep the hook line,
run the workflows.

## License

MIT, see [LICENSE](LICENSE). Tvijo Code is based on VSCodium (MIT) and Code - OSS (MIT).
"Visual Studio Code" and "VS Code" are trademarks of Microsoft; this project is not
affiliated with or endorsed by Microsoft or the VSCodium project.
