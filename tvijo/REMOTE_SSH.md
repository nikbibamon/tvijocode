# Remote SSH: Windows 1.140.07195

## Published Linux x64 server — 2026-10-26 20:51 UTC

The missing asset has been added to the existing release after passing
[CI40397971052](https://github.com/nikbibamon/tvijocode/actions/runs/40397971052).
[Server archive](https://github.com/nikbibamon/tvijocode/releases/download/1.140.07195/tvijocode-reh-linux-x64-1.140.07195.tar.gz):
88,165,345 bytes; SHA-256
`533f88ad1b623b13deafca0016a28090c965edd5f9b66503b3d507d12746c1c8`.
Anonymous download and checksum verification passed. Original EXE/ZIP, receipts,
tag and failed candidates are preserved. Native CLI, VSIX installation/listing
and loopback startup pass with the installed Windows runtime commit. Existing
built-in update entries are retained; only Tvijo is added to that policy.
[Receipt and explicit test limits](https://github.com/nikbibamon/tvijocode/releases/download/1.140.07195/REMOTE_SERVER_RECEIPT.json).

Reconnect from Windows with Open Remote SSH; the same download URL now returns200.
Do not delete your profile or remote files. Actual Windows SSH connection,
Explorer/terminal and remote Tvijo activation/chat are **not verified yet**.
The earlier404 and failed builds below are retained as the repair history.
The unified Codex/Claude/Copilot UI is still pending implementation.

Observed 2026-10-26: Open Remote SSH 0.5.1 authenticates successfully, then
requests `tvijocode-reh-linux-x64-1.140.07195.tar.gz` from the Windows release.
That asset is absent (HTTP 404). Windows CLI/extension smoke does not cover an
SSH session. Installing the Tvijo VSIX into the unavailable remote extension
host cannot fix the missing server.

The installed Windows runtime commit is
`b8d24157e2bfc00d4d6d247fffcde8bea8271c14`; the builder source commit is
`ab2187554c24b2fd6927ac92f11ee71e73f56b18`. These are different identities.
Never change a third-party server's product commit or disable server validation
to make them appear compatible.

## Prepared repair, not a published server

[The manual workflow](../.github/workflows/build-remote-server.yml) downloads the
existing build/native Windows receipts, validates their linkage, checks out the
exact original builder source and builds Linux x64 REH with the Windows runtime
commit. It embeds the exact pinned Tvijo VSIX into the server's `extensions/`
directory, preserving all nested files. Existing paths and artifacts are never
replaced.

CI run 40396992313 exposed a second prerequisite: stable Code OSS rejects a
VSIX over a bundled extension unless its ID is in the product's supported
`builtInExtensionsEnabledWithAutoUpdates` list. The REH packaging helper adds
only `tvijo.tvijo-dshrem` to that list, preserving other product fields and
existing entries. Runtime commit, extension compatibility and downgrade checks
remain enforced. This change affects the new Linux server; it does not alter
the previously published Windows desktop files.

The native Linux smoke checks CLI version/commit, isolated VSIX installation and
listing, loopback startup and `/version`. It does **not** prove a Windows SSH
connection, remote extension activation, chat rendering, login or a complete
coding task. Those require an actual client session after publication.

The workflow has read-only repository permissions and uploads CI artifacts only.
It cannot publish a release, overwrite its assets, move tags or delete history.
At preparation time the operator paused staging, commits and pushes. That pause
was explicitly revoked on 2026-10-26; scoped commits, pushes and CI are now
authorized. Publication still requires a passing native server receipt and
an anonymous artifact checksum check. The 404 remains until that publication.

## Acceptance after the commit queue resumes

1. Commit/review these four scoped files and push only when authorized.
2. Dispatch the workflow for the existing Windows release and inspect its native
   receipts. If compilation or native smoke fails, preserve the artifacts and
   keep Remote SSH unavailable.
3. After passing, add the missing server as a new release asset together with its
   SHA-256 and native receipt. Preserve all existing EXE/ZIP files, tag and assets.
   Re-download anonymously and compare size/hash; adding this previously absent
   platform artifact is separate from replacing any existing asset.
4. Reconnect from Windows using Open Remote SSH. Verify the installed server
   commit, remote Explorer/terminal, Tvijo extension activation and chat. Install
   the VSIX on the SSH host if needed; record the actual failure if it persists.
5. Investigate the separate “file already exists when overwrite flag is not set”
   dialog from its full URI/stack. It is not explained by the SSH download log.
   Do not delete the user's editor profile or remote-server directories.

The `.profile` warning about a missing local `env` executable is also separate:
the remote installer continued past it and failed on the HTTP 404.
