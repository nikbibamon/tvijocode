#!/usr/bin/env bash
# Publish a fresh Windows release without replacing or deleting prior artifacts.
# Failed drafts/tags stay available for reconciliation. All retries are bounded.
set -euo pipefail
python3 - "$@" <<'PY_RELEASE'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def fail(message):
    raise RuntimeError(message)


def gh(*args, binary=False, input_text=None):
    executable = shutil.which("gh")
    if executable is None:
        fail("GitHub CLI is unavailable")
    return subprocess.run([executable, *args], capture_output=True, text=not binary,
                          timeout=180, check=False, input=input_text)


def missing(result):
    # An authorization/network error must never be mistaken for a free version.
    try:
        body = json.loads(result.stdout)
    except (ValueError, TypeError):
        body = {}
    return (result.returncode != 0 and body.get("status") in (404, "404")
            and body.get("message") == "Not Found")


def read_api(endpoint, optional=False):
    for attempt in range(3):
        result = gh("api", endpoint)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if optional and missing(result):
            return None
        if attempt < 2:
            time.sleep(attempt + 1)
    fail("GitHub read failed; no publication mutation attempted for " + endpoint)


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new(path, data):
    with path.open("xb") as stream:
        stream.write(data)


def main():
    if sys.argv[1:] not in ([], ["--preflight"]):
        fail("Usage: release.sh [--preflight]")
    repo = os.environ.get("ASSETS_REPOSITORY", "")
    version = os.environ.get("RELEASE_VERSION", "")
    source = os.environ.get("TVIJO_SOURCE_SHA", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        fail("Invalid repository")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        fail("Expected the fresh numeric version produced by get_repo.sh")
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        fail("Missing exact builder source SHA")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if source != actual:
        fail("Builder source SHA changed")
    if os.environ.get("OS_NAME") != "windows" or os.environ.get("VSCODE_ARCH") != "x64":
        fail("This release workflow currently supports Windows x64 only")
    if not any(os.environ.get(k) for k in ("GH_TOKEN", "GITHUB_TOKEN")):
        fail("Missing GitHub authentication")
    api = "repos/" + repo
    if read_api(api + "/releases/tags/" + version, optional=True) is not None:
        fail("Release version already exists; existing assets are preserved")
    if read_api(api + "/git/ref/tags/" + version, optional=True) is not None:
        fail("Tag already exists; choose a fresh build version")
    if sys.argv[1:] == ["--preflight"]:
        print("Fresh release version available: " + version + "; source " + source)
        return

    assets = Path("assets")
    binaries = [assets / ("TvijoCodeUserSetup-x64-" + version + ".exe"),
                assets / ("TvijoCode-win32-x64-" + version + ".zip")]
    if not assets.is_dir() or set(assets.iterdir()) != set(binaries):
        fail("Expected exactly the Windows user installer and portable ZIP")
    if any(p.is_symlink() or not p.is_file() or p.stat().st_size == 0 for p in binaries):
        fail("Invalid release asset")
    locks = json.loads(Path("tvijo/extensions.lock.json").read_text())
    smoke_path = Path(os.environ["TVIJO_SMOKE_RECEIPT"])
    smoke = json.loads(smoke_path.read_text())
    if (smoke.get("status") != "passed" or smoke.get("source_commit") != source
            or smoke.get("release_version") != version
            or smoke.get("extension_version") != locks[0]["version"]
            or smoke.get("extension_sha256") != locks[0]["sha256"]
            or smoke.get("activation") != "passed"):
        fail("Missing matching native Windows activation evidence")
    for path in binaries:
        write_new(path.with_name(path.name + ".sha256"),
                  (sha(path) + "  " + path.name + "\n").encode())
    write_new(assets / "WINDOWS_SMOKE.json", json.dumps(smoke, indent=2).encode() + b"\n")
    receipt = {"schema": "tvijo.editor-build/v1", "source_commit": source,
               "upstream": json.loads(Path("upstream/stable.json").read_text()),
               "release_version": version, "extensions": locks,
               "workflow_run": os.environ.get("GITHUB_RUN_ID"),
               "artifacts": {p.name: {"sha256": sha(p), "bytes": p.stat().st_size}
                             for p in sorted(assets.iterdir())}}
    write_new(assets / "BUILD_RECEIPT.json", json.dumps(receipt, indent=2).encode() + b"\n")
    files = sorted(assets.iterdir())
    expected = {p.name: {"sha256": sha(p), "bytes": p.stat().st_size} for p in files}
    notes = Path("release_notes.md").read_text()
    for key, value in {"@@VERSION@@": version, "@@REPOSITORY@@": repo,
                       "@@SOURCE@@": source, "@@EXTENSION@@": locks[0]["version"]}.items():
        notes = notes.replace(key, value)
    if "@@" in notes:
        fail("Unresolved release notes placeholder")
    temp = Path(tempfile.mkdtemp(prefix="tvijo-publish-", dir=os.environ["TMPDIR"]))
    notes_path = temp / "release-notes.md"
    write_new(notes_path, notes.encode())

    # Atomic ref creation refuses a race with another publisher. Never retarget.
    reserve = gh("api", "--method", "POST", api + "/git/refs", "-f",
                 "ref=refs/tags/" + version, "-f", "sha=" + source)
    if reserve.returncode:
        fail("Could not reserve fresh tag; preserved state requires reconciliation")
    # Drafts can be absent from the tag lookup endpoint. Capture the creation
    # response's identity directly; never retry/adopt an ambiguous creation.
    create = gh("api", "--method", "POST", api + "/releases", "--input", "-",
                input_text=json.dumps({"tag_name": version, "target_commitish": source,
                                      "draft": True, "name": "Tvijo Code " + version,
                                      "body": notes}))
    if create.returncode:
        fail("Draft creation failed or ambiguous; reserved tag is preserved")
    created = json.loads(create.stdout)
    release_id = created.get("id")
    if (not isinstance(release_id, int) or isinstance(release_id, bool)
            or release_id <= 0 or not created.get("draft")
            or created.get("tag_name") != version):
        fail("Draft creation returned an invalid identity; preserved without adoption")
    release = read_api(api + "/releases/" + str(release_id))
    if not release.get("draft") or release.get("tag_name") != version or release.get("assets"):
        fail("Unexpected new draft state; preserving it without upload")

    def current_assets():
        current = read_api(api + "/releases/" + str(release_id))
        if not current.get("draft") or current.get("tag_name") != version:
            fail("Release ownership/state changed during publication")
        result = {a["name"]: a for a in current.get("assets", [])}
        if len(result) != len(current.get("assets", [])) or set(result) - set(expected):
            fail("Unexpected remote assets; preserved without modification")
        return result

    def verify_asset(asset, want):
        if asset.get("size") != want["bytes"] or asset.get("state") != "uploaded":
            fail("Remote asset differs or is incomplete; preserved without replacement")
        target = temp / (str(asset["id"]) + ".download")
        # A new path for every verification; retain responses after any failure.
        with tempfile.NamedTemporaryFile(prefix=target.name, dir=temp, delete=False) as output:
            result = subprocess.run([shutil.which("gh"), "api", api + "/releases/assets/" + str(asset["id"]),
                                     "-H", "Accept: application/octet-stream"],
                                    stdout=output, stderr=subprocess.PIPE, timeout=180)
            downloaded = Path(output.name)
        if result.returncode or downloaded.stat().st_size != want["bytes"] or sha(downloaded) != want["sha256"]:
            fail("Downloaded asset verification failed; draft and artifacts preserved")

    verified_ids = {}
    for path in files:
        for attempt in range(3):
            existing = current_assets().get(path.name)
            if existing is not None:
                verify_asset(existing, expected[path.name])
                verified_ids[path.name] = existing["id"]
                break
            result = gh("release", "upload", version, str(path), "--repo", repo)
            # Even an error can mean an accepted upload whose response was lost.
            existing = current_assets().get(path.name)
            if existing is not None:
                verify_asset(existing, expected[path.name])
                verified_ids[path.name] = existing["id"]
                break
            if attempt == 2:
                fail("Upload failed after three attempts; draft remains unpublished")
            time.sleep(attempt + 1)
    final = current_assets()
    if set(final) != set(expected):
        fail("Incomplete draft asset set; publication refused")
    # All bytes were checked immediately after upload; this final metadata check
    # catches concurrent changes before publishing the retained immutable draft.
    for name, asset in final.items():
        if (asset.get("id") != verified_ids[name]
                or asset.get("size") != expected[name]["bytes"] or asset.get("state") != "uploaded"):
            fail("Asset metadata changed before publication")
    tag = read_api(api + "/git/ref/tags/" + version)
    if tag.get("object", {}).get("sha") != source:
        fail("Source tag changed before publication; draft preserved")
    publish = gh("release", "edit", version, "--repo", repo, "--draft=false")
    if publish.returncode:
        fail("Publication response failed; inspect retained release before retrying")
    public = read_api(api + "/releases/" + str(release_id))
    if public.get("draft") or public.get("tag_name") != version:
        fail("Published release readback did not match")
    result = {"status": "published", "source_commit": source, "version": version,
              "url": public.get("html_url"), "artifacts": expected}
    write_new(temp / "publication.json", json.dumps(result, indent=2).encode() + b"\n")
    print(json.dumps(result, indent=2))


try:
    main()
except Exception as error:
    print("RELEASE REFUSED: " + str(error), file=sys.stderr)
    sys.exit(1)
PY_RELEASE
