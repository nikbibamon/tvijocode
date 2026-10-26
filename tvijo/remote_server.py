"""Prepare and smoke-test a REH for an existing Windows release; never publish it."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import tarfile
import time
import urllib.request
import zipfile


def write_new(path, data):
    with Path(path).open('x', encoding='utf-8') as output:
        output.write(json.dumps(data, indent=2) + '\n')


def plan(release, build, smoke_bytes):
    if not re.fullmatch(r'\d+\.\d+\.\d+', release):
        raise ValueError('Invalid release version')
    smoke = json.loads(smoke_bytes)
    if build['release_version'] != release or smoke['release_version'] != release:
        raise ValueError('Receipt release mismatch')
    expected_hash = build['artifacts']['WINDOWS_SMOKE.json']['sha256']
    if hashlib.sha256(smoke_bytes).hexdigest() != expected_hash:
        raise ValueError('Windows smoke checksum mismatch')
    if smoke.get('status') != 'passed' or smoke.get('activation') != 'passed':
        raise ValueError('Windows activation not verified')
    source, upstream = build['source_commit'], build['upstream']['commit']
    if not all(re.fullmatch('[a-f0-9]{40}', x) for x in (source, upstream)):
        raise ValueError('Invalid source commit')
    if smoke['source_commit'] != source:
        raise ValueError('Windows source mismatch')
    lines = smoke['native_cli_version'].splitlines()
    commit = hashlib.sha1((release + '\n').encode()).hexdigest()
    if lines != [release, commit, 'x64']:
        raise ValueError('Windows runtime commit mismatch')
    extension, = build['extensions']
    if (extension['id'] != 'tvijo.tvijo-dshrem' or extension['dir'] != 'tvijo-dshrem'
            or extension['version'] != smoke['extension_version']
            or extension['sha256'] != smoke['extension_sha256']
            or not re.fullmatch('[a-f0-9]{64}', extension['sha256'])):
        raise ValueError('Extension receipt mismatch')
    version = extension['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid extension version')
    url = ('https://github.com/nikbibamon/dshrempub/releases/download/'
           f'tvijo-v{version}/tvijo-dshrem-{version}.vsix')
    if extension['url'] != url:
        raise ValueError('Unapproved extension source')
    return {'release_version': release, 'source_commit': source,
            'upstream_commit': upstream, 'runtime_commit': commit,
            'extension': dict(extension),
            'filename': f'tvijocode-reh-linux-x64-{release}.tar.gz',
            'status': 'prepared'}


def validate_tree(tree, spec):
    tree = Path(tree)
    product = json.loads((tree / 'product.json').read_text())
    package = json.loads((tree / 'package.json').read_text())
    if (product.get('commit') != spec['runtime_commit']
            or package.get('version') != spec['release_version']
            or product.get('serverApplicationName') != 'tvijocode-server'):
        raise ValueError('REH does not match the installed Windows editor')
    if not (tree / 'bin/tvijocode-server').is_file() or not (tree / 'node').is_file():
        raise ValueError('Missing native server launcher or Node runtime')


def embed(tree, vsix, spec):
    validate_tree(tree, spec)
    vsix = Path(vsix)
    if hashlib.sha256(vsix.read_bytes()).hexdigest() != spec['extension']['sha256']:
        raise ValueError('VSIX checksum mismatch')
    target = Path(tree) / 'extensions/tvijo-dshrem'
    if not target.parent.resolve().is_relative_to(Path(tree).resolve()):
        raise ValueError('Extension directory escapes the server tree')
    if target.exists() or target.is_symlink():
        raise FileExistsError('Refusing to replace an embedded extension')
    with zipfile.ZipFile(vsix) as archive:
        files = {}
        for item in archive.infolist():
            if not item.filename.startswith('extension/') or item.is_dir():
                continue
            name = item.filename[len('extension/'):]
            path = PurePosixPath(name)
            if (not name or '\\' in name or path.is_absolute() or '..' in path.parts
                    or name in files or item.external_attr >> 16 & 0o170000 == 0o120000):
                raise ValueError('Unsafe or duplicate VSIX path')
            files[name] = archive.read(item)
    package = json.loads(files['package.json'])
    if (package['version'] != spec['extension']['version']
            or package['publisher'] != 'tvijo' or package['name'] != 'tvijo-dshrem'):
        raise ValueError('VSIX identity mismatch')
    # Validate the whole archive before writing; never replace an existing path.
    target.mkdir(parents=True, exist_ok=False)
    for name, content in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(content)
    return {'files': len(files), 'exact_vsix_bytes': True}


def smoke(tree, vsix, spec, output):
    """Exercise native Linux CLI/VSIX install and loopback server, not GUI activation."""
    validate_tree(tree, spec)
    output = Path(output)
    output.mkdir(exist_ok=False)
    launcher = str(Path(tree).resolve() / 'bin/tvijocode-server')
    common = ['--accept-server-license-terms', '--telemetry-level', 'off',
              '--server-data-dir', str(output / 'state'),
              '--extensions-dir', str(output / 'extensions')]
    env = {k: v for k, v in os.environ.items()
           if k not in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN')}

    def run(*args):
        result = subprocess.run([launcher, *common, *args], env=env, text=True,
                                capture_output=True, timeout=90, check=True)
        return result.stdout

    version = run('--version')
    if spec['runtime_commit'] not in version:
        raise ValueError('Native CLI commit mismatch')
    run('--install-extension', str(Path(vsix).resolve()))
    installed = run('--list-extensions', '--show-versions')
    if 'tvijo.tvijo-dshrem@' + spec['extension']['version'] not in installed.splitlines():
        raise ValueError('VSIX not installed on remote extension host')
    token = secrets.token_hex(32)
    token_file = output / 'connection.token'
    with token_file.open('x', encoding='utf-8') as stream:
        os.chmod(token_file, 0o600)
        stream.write(token)
    log = output / 'server.log'
    with log.open('x', encoding='utf-8') as stream:
        child = subprocess.Popen([launcher, *common, '--start-server', '--host=127.0.0.1',
                                  '--port=0', '--connection-token-file', str(token_file)],
                                 env=env, stdout=stream, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                match = re.search(r'Extension host agent listening on (\d+)', log.read_text())
                if match:
                    url = f'http://127.0.0.1:{match[1]}/version'
                    with urllib.request.urlopen(url, timeout=5) as response:
                        if response.read().decode().strip() != spec['runtime_commit']:
                            raise ValueError('Running server commit mismatch')
                    break
                if child.poll() is not None:
                    raise RuntimeError('Native server exited; see retained log')
                time.sleep(0.2)
            else:
                raise TimeoutError('Native server did not listen within 45 seconds')
        finally:
            # Only the process group created above is owned by this smoke.
            import signal
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            child.wait(timeout=15)
    return {'status': 'passed', 'platform': 'linux-x64',
            'runtime_commit': spec['runtime_commit'],
            'checks': ['native_cli', 'vsix_install', 'installed_extension_version',
                       'loopback_listener', 'running_server_commit'],
            'not_verified': ['Windows Remote SSH connection',
                             'remote extension activation and chat UI',
                             'interactive sign-in and complete coding task']}


def pack(tree, spec, destination):
    validate_tree(tree, spec)
    destination = Path(destination)
    tree = Path(tree).resolve()
    if destination.exists():
        raise FileExistsError('Archive already exists; preserve previous artifact')
    if destination.resolve().is_relative_to(tree):
        raise ValueError('Archive must be outside the server tree')
    if destination.name != spec['filename']:
        raise ValueError('Archive filename must match the editor download URL')
    for path in tree.rglob('*'):
        if path.is_symlink() and not path.resolve().is_relative_to(tree):
            raise ValueError('Server symlink escapes its package')
    with tarfile.open(destination, 'x:gz') as archive:
        archive.add(tree, arcname='tvijocode-server-linux-x64')
    return {'filename': destination.name, 'bytes': destination.stat().st_size,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('plan')
    p.add_argument('release'); p.add_argument('build'); p.add_argument('smoke'); p.add_argument('output')
    for name in ['embed', 'smoke', 'pack']:
        p = sub.add_parser(name)
        p.add_argument('tree'); p.add_argument('plan'); p.add_argument('output')
        if name != 'pack':
            p.add_argument('vsix')
    args = parser.parse_args()
    if args.command == 'plan':
        result = plan(args.release, json.loads(Path(args.build).read_text()), Path(args.smoke).read_bytes())
        write_new(args.output, result)
    else:
        spec = json.loads(Path(args.plan).read_text())
        if args.command == 'embed':
            result = embed(args.tree, args.vsix, spec)
        elif args.command == 'smoke':
            result = smoke(args.tree, args.vsix, spec, str(args.output) + '.state')
        else:
            result = pack(args.tree, spec, args.output)
        write_new(str(args.output) + '.json', result)


if __name__ == '__main__':
    main()
