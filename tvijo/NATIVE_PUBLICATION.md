# Native candidate publication for 1.140.07215

The candidate workflows build and test independently and never publish. Retain
each GitHub Actions artifact ZIP as downloaded, alongside its extracted binary and
native smoke receipt. The publisher verifies the GitHub artifact digest and run
identity, the extracted bytes, the specific native job, the pinned extension,
and activation behavior. A Windows ZIP additionally requires the separate
retained-ZIP verifier and its builder provenance record. A failed or missing
channel is not included merely because another platform passed.

The input manifest has a `channels` array. Each entry contains `kind`, `artifact`,
`receipt`, `asset_bundle`, `asset_bundle_id`, `receipt_bundle` and
`receipt_bundle_id`. Paths are local files. Kinds are `windows-exe`,
`windows-zip`, `macos-arm64`, `macos-x64` or `linux-tar`. A Windows ZIP entry
also contains `verifier_run` and `provenance`. The publisher checks the fixed
builder runs and source commits against GitHub rather than trusting the manifest.

First run `python3 tvijo/native_publish.py --manifest MANIFEST --out NEW_DIR`.
It performs validation and writes a plan; it does not publish. Use a different
new directory with `--publish` only after the selected channels have passed.
The tag and release must not already exist. Uploads are create-only; a failed or
ambiguous operation leaves the tag, draft, uploaded files and local evidence for
reconciliation. It never deletes or replaces an asset. A release is not
reported as verified until every selected public download matches its hash.

The Linux tar smoke does not certify DEB/RPM installation, and macOS ad-hoc
signing does not establish notarization. Interactive sign-in and a paid model
task are outside these native smokes. Record those limits on the download page.
