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

[Preview 1.140.07215](https://github.com/nikbibamon/tvijocode/releases/tag/1.140.07215)
embeds Tvijo DSHREM 0.10.25. It includes a portable Windows x64 ZIP and per-user
EXE installer, macOS ZIPs for Apple silicon and Intel, and a Linux x64 desktop
TAR. Each published file has a SHA-256 and an individual native smoke receipt;
the Windows EXE was also installed and uninstalled in Windows CI.

The macOS builds use ad-hoc signatures and are not verified as notarized. Windows
publisher signing trust, interactive sign-in and paid-model tasks were not
verified. Linux DEB/RPM installers and the standalone CLI are not included in
this preview. Previous releases remain available.

**Русский:** [предварительный выпуск 1.140.07215](https://github.com/nikbibamon/tvijocode/releases/tag/1.140.07215)
содержит Windows ZIP и EXE, macOS для Apple silicon и Intel и Linux x64 TAR со
встроенным Tvijo DSHREM 0.10.25. Для каждого файла опубликованы SHA-256 и отчёт
нативной проверки. Нотаризация macOS и доверие к подписи издателя Windows не
подтверждены; вход и задачи с платными моделями не проверялись. Пакетные
установщики Linux и отдельный CLI в этот выпуск не входят.

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
