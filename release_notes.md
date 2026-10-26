Tvijo Code **@@VERSION@@** for Windows 10/11 x64, with **Tvijo DSHREM @@EXTENSION@@** built in.

| Download | Use |
| --- | --- |
| [User installer (.exe)](https://github.com/@@REPOSITORY@@/releases/download/@@VERSION@@/TvijoCodeUserSetup-x64-@@VERSION@@.exe) | Install in your user account without administrator rights. |
| [Portable archive (.zip)](https://github.com/@@REPOSITORY@@/releases/download/@@VERSION@@/TvijoCode-win32-x64-@@VERSION@@.zip) | Extract the whole archive and run Tvijo Code.exe. |

Each binary has an adjacent `.sha256` file. [BUILD_RECEIPT.json](https://github.com/@@REPOSITORY@@/releases/download/@@VERSION@@/BUILD_RECEIPT.json) records the source commit, upstream version, embedded extension pin, sizes and hashes. [WINDOWS_SMOKE.json](https://github.com/@@REPOSITORY@@/releases/download/@@VERSION@@/WINDOWS_SMOKE.json) records the native Windows checks.

The CI smoke starts the Windows CLI, checks product identity, Open VSX, disabled auto-update, the exact embedded extension files and extension activation with registered Tvijo commands. It does not sign in, send a paid model request or prove an interactive end-to-end coding session.

The installer is unsigned; Windows SmartScreen may show an unknown publisher. Automatic updates are disabled: install a newer release manually. This release contains only Windows x64 EXE and ZIP assets. macOS, Linux, ARM64, MSI, system installers and remote server packages are not included.

For an existing VS Code installation, install the current Tvijo VSIX and reload the window instead of changing editors. [Learning guide](https://dsh.tvijo.com/learn).

Builder source: [@@SOURCE@@](https://github.com/@@REPOSITORY@@/commit/@@SOURCE@@). Previous releases and failed drafts are preserved.
