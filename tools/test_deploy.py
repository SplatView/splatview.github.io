"""Promotion checks stay independent of release labels and preserve static state."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import deploy


def record(name, data):
    return {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class ReleaseTests(unittest.TestCase):
    def test_only_explicit_published_stable_tags_with_digested_assets(self):
        names = ('SHA256SUMS.txt', 'validation.json', 'build-manifest.json', 'SplatView-web-v0.2.2.zip')
        release = {'tag_name': 'v0.2.2', 'draft': False, 'prerelease': False, 'assets': [{
            'name': name, 'size': 3, 'digest': 'sha256:' + 'a' * 64,
            'browser_download_url': f'https://github.com/{deploy.REPOSITORY}/releases/download/v0.2.2/{name}',
        } for name in names]}
        self.assertEqual(set(deploy.release_assets(release, 'v0.2.2')), set(names))
        for field in ('draft', 'prerelease'):
            changed = copy.deepcopy(release)
            changed[field] = True
            with self.assertRaisesRegex(ValueError, 'published stable'):
                deploy.release_assets(changed, 'v0.2.2')
        changed = copy.deepcopy(release)
        changed['assets'][0]['digest'] = None
        with self.assertRaises((TypeError, ValueError)):
            deploy.release_assets(changed, 'v0.2.2')
        for tag in ('source', 'v1.2.3;command', 'v1.2.3-rc.1', '../v0.2.2', 'v01.2.3'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                deploy.version_tuple(tag)

    def test_checksum_inventory_and_receipt_cannot_override_verified_identity(self):
        assets = {'app.zip': {'sha256': 'a' * 64}, 'SHA256SUMS.txt': {'sha256': 'b' * 64}}
        deploy.verify_checksums(('a' * 64 + '  app.zip\n').encode(), assets)
        with self.assertRaisesRegex(ValueError, 'checksum manifest'):
            deploy.verify_checksums(('c' * 64 + '  app.zip\n').encode(), assets)
        qualified = {'deploymentId': 'a' * 64, 'appInputId': 'b' * 64}
        archive = {'bytes': 3, 'sha256': 'c' * 64}
        receipt = {'schemaVersion': 1, 'version': '0.2.2', 'status': 'qualified-pages-and-live-update-verified',
                   'source': {'commit': 'd' * 40, 'tag': 'v0.2.2', 'annotated': True},
                   'build': {**qualified, 'distributionAssets': [{**archive, 'path': 'assets/SplatView-web-v0.2.2.zip'}]}}
        deploy.verify_receipt(receipt, 'v0.2.2', 'd' * 40, qualified, archive)
        for mutate in (lambda value: value['source'].update(commit='e' * 40),
                       lambda value: value['build'].update(appInputId='f' * 64),
                       lambda value: value['build']['distributionAssets'][0].update(bytes=4)):
            changed = copy.deepcopy(receipt)
            mutate(changed)
            with self.assertRaises(ValueError):
                deploy.verify_receipt(changed, 'v0.2.2', 'd' * 40, qualified, archive)


class StaticStageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.target = self.root / 'static'
        self.target.mkdir()
        self.distribution = self.root / 'dist'
        self.distribution.mkdir()
        subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=self.target, check=True)
        for name in deploy.PROTECTED:
            self.write(self.target, name, ('protected ' + name).encode())
        self.write(self.target, 'assets/old.js', b'old client')
        self.write(self.target, 'README.md', b'# SplatView web 0.2.1\n')
        self.write(self.target, 'build-manifest.json', b'{"deploymentId":"old"}')
        self.write(self.distribution, 'assets/new.js', b'new exact bytes\r\n')
        self.qualified = {'deploymentId': 'new', 'files': [record('assets/new.js', b'new exact bytes\r\n')]}

    @staticmethod
    def write(root, name, data):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def test_exact_git_bytes_and_previous_assets_and_legal_leaves_survive(self):
        protected = deploy.stage_distribution(self.target, self.distribution, self.qualified, 'v0.2.2', 'a' * 40)
        self.assertEqual(len(protected), 9)
        self.assertEqual((self.target / 'assets/old.js').read_bytes(), b'old client')
        self.assertEqual(deploy.git('show', ':assets/new.js', cwd=self.target, binary=True), b'new exact bytes\r\n')
        self.assertEqual((self.target / '.gitattributes').read_bytes(), b'* -text\n')

    def test_downgrade_and_same_version_different_build_refused(self):
        with self.assertRaisesRegex(ValueError, 'downgrade'):
            deploy.stage_distribution(self.target, self.distribution, self.qualified, 'v0.2.0', 'a' * 40)
        with self.assertRaisesRegex(ValueError, 'different deployment'):
            deploy.stage_distribution(self.target, self.distribution, self.qualified, 'v0.2.1', 'a' * 40)

    def test_legal_overwrite_and_static_admin_paths_refused(self):
        for name in ('EULA.txt', '.git/config', 'CNAME'):
            self.write(self.distribution, name, b'bad replacement')
            self.qualified['files'] = [record(name, b'bad replacement')]
            with self.subTest(name=name), self.assertRaises(ValueError):
                deploy.stage_distribution(self.target, self.distribution, self.qualified, 'v0.2.2', 'a' * 40)
