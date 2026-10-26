"""Offline contract tests; none is a native REH or Windows SSH acceptance receipt."""
import copy
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

import remote_server as remote


class RemoteServerTests(unittest.TestCase):
    def setUp(self):
        self.release = '1.140.07195'
        self.commit = hashlib.sha1((self.release + '\n').encode()).hexdigest()
        self.ext = {'id': 'tvijo.tvijo-dshrem', 'dir': 'tvijo-dshrem', 'version': '0.10.15',
                    'sha256': 'd' * 64,
                    'url': 'https://github.com/nikbibamon/dshrempub/releases/download/tvijo-v0.10.15/tvijo-dshrem-0.10.15.vsix'}
        self.smoke = {'release_version': self.release, 'source_commit': 'a' * 40,
                      'status': 'passed', 'activation': 'passed', 'extension_version': '0.10.15',
                      'extension_sha256': 'd' * 64,
                      'native_cli_version': self.release + '\n' + self.commit + '\nx64'}
        self.build = {'release_version': self.release, 'source_commit': 'a' * 40,
                      'upstream': {'commit': 'b' * 40}, 'extensions': [self.ext],
                      'artifacts': {}}

    def spec(self):
        data = json.dumps(self.smoke).encode()
        self.build['artifacts']['WINDOWS_SMOKE.json'] = {'sha256': hashlib.sha256(data).hexdigest()}
        return remote.plan(self.release, self.build, data)

    def tree(self, root):
        root.mkdir()
        (root / 'bin').mkdir()
        (root / 'bin/tvijocode-server').write_text('fixture only')
        (root / 'node').write_bytes(b'not a real node binary')
        (root / 'product.json').write_text(json.dumps({'commit': self.commit, 'serverApplicationName': 'tvijocode-server'}))
        (root / 'package.json').write_text(json.dumps({'version': self.release}))
        return root

    def vsix(self, path, spec, extras=None):
        manifest = {'name': 'tvijo-dshrem', 'publisher': 'tvijo', 'version': '0.10.15'}
        with zipfile.ZipFile(path, 'x') as z:
            z.writestr('extension/package.json', json.dumps(manifest))
            z.writestr('extension/lib/nested/module.js', 'module.exports=42;')
            z.writestr('extension/media/guide.html', '<h1>guide</h1>')
            for name in extras or []:
                z.writestr(name, b'unsafe')
        spec['extension']['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        return path

    def test_plan_preserves_distinct_runtime_and_builder_commits(self):
        d = self.spec()
        self.assertEqual(d['runtime_commit'], self.commit)
        self.assertNotEqual(d['runtime_commit'], d['source_commit'])
        self.assertEqual(d['filename'], 'tvijocode-reh-linux-x64-1.140.07195.tar.gz')

    def test_bad_receipts_fail_closed(self):
        original_build, original_smoke = copy.deepcopy(self.build), copy.deepcopy(self.smoke)
        for field, value in [('release_version', '1.140.07151'), ('source_commit', 'c' * 40),
                             ('activation', 'failed'), ('native_cli_version', 'wrong'),
                             ('extension_version', '0.5.5')]:
            with self.subTest(field=field):
                self.build, self.smoke = copy.deepcopy(original_build), copy.deepcopy(original_smoke)
                self.smoke[field] = value
                with self.assertRaises(ValueError):
                    self.spec()

    def test_modified_smoke_bytes_are_rejected(self):
        self.spec()
        with self.assertRaises(ValueError):
            remote.plan(self.release, self.build, json.dumps(self.smoke, indent=2).encode())

    def test_shell_injection_version_and_foreign_extension_url_are_rejected(self):
        with self.assertRaises(ValueError):
            remote.plan('1.140.07195\nBAD=1', {}, b'{}')
        self.ext['url'] = 'https://example.invalid/unverified.vsix'
        with self.assertRaises(ValueError):
            self.spec()

    def test_embed_and_tar_layout_preserve_nested_extension_bytes(self):
        spec = self.spec()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); tree = self.tree(root / 'tree')
            vsix = self.vsix(root / 'extension.vsix', spec)
            result = remote.embed(tree, vsix, spec)
            self.assertEqual(result['files'], 3)
            self.assertEqual((tree / 'extensions/tvijo-dshrem/lib/nested/module.js').read_text(), 'module.exports=42;')
            destination = root / spec['filename']
            remote.pack(tree, spec, destination)
            with tarfile.open(destination) as archive:
                # Open Remote SSH extracts with --strip-components=1.
                member = 'tvijocode-server-linux-x64/extensions/tvijo-dshrem/lib/nested/module.js'
                self.assertEqual(archive.extractfile(member).read(), b'module.exports=42;')
                self.assertIn('tvijocode-server-linux-x64/bin/tvijocode-server', archive.getnames())

    def test_existing_extension_and_archive_are_preserved(self):
        spec = self.spec()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); tree = self.tree(root / 'tree'); vsix = self.vsix(root / 'extension.vsix', spec)
            remote.embed(tree, vsix, spec)
            marker = tree / 'extensions/tvijo-dshrem/user-work.txt'; marker.write_text('retain')
            with self.assertRaises(FileExistsError):
                remote.embed(tree, vsix, spec)
            self.assertEqual(marker.read_text(), 'retain')
            archive = root / spec['filename']; archive.write_bytes(b'previous artifact')
            with self.assertRaises(FileExistsError):
                remote.pack(tree, spec, archive)
            self.assertEqual(archive.read_bytes(), b'previous artifact')

    def test_vsix_traversal_rejected_before_any_extension_write(self):
        for path in ['extension/../outside', 'extension//absolute', 'extension/lib\\bad.js']:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as tmp:
                spec = self.spec(); root = Path(tmp); tree = self.tree(root / 'tree')
                vsix = self.vsix(root / 'extension.vsix', spec, [path])
                with self.assertRaises(ValueError):
                    remote.embed(tree, vsix, spec)
                self.assertFalse((tree / 'extensions/tvijo-dshrem').exists())

    def test_wrong_commit_and_extension_symlink_are_rejected(self):
        spec = self.spec()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); tree = self.tree(root / 'tree'); vsix = self.vsix(root / 'extension.vsix', spec)
            (tree / 'product.json').write_text(json.dumps({'commit': 'c' * 40, 'serverApplicationName': 'tvijocode-server'}))
            with self.assertRaises(ValueError):
                remote.embed(tree, vsix, spec)
            (tree / 'product.json').write_text(json.dumps({'commit': self.commit, 'serverApplicationName': 'tvijocode-server'}))
            (tree / 'extensions').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                remote.embed(tree, vsix, spec)


if __name__ == '__main__':
    unittest.main()
