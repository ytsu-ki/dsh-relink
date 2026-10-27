import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'scripts/prepare-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def pair(self, *, missing_source=None, missing_runtime=None, changed_source=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        tgz, source = Path(directory.name) / 'package.tgz', Path(directory.name) / 'source.zip'
        runtime = {name: ('fixture:' + name).encode() for name in release.REQUIRED}
        runtime['package.json'] = json.dumps({'name': 'dsh-relink', 'version': '0.6.0-beta.1'}).encode()
        with tarfile.open(tgz, 'w:gz') as archive:
            for name, content in runtime.items():
                if name == missing_runtime:
                    continue
                entry = tarfile.TarInfo('package/' + name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
        sources = {**{name: b'development fixture' for name in release.SOURCE_REQUIRED}, **runtime}
        with zipfile.ZipFile(source, 'w') as archive:
            for name, content in sources.items():
                if name != missing_source:
                    archive.writestr('dsh-relink-test/' + name, b'changed' if name == changed_source else content)
        return tgz, source

    def test_complete_pair(self):
        result = release.verify(*self.pair())
        self.assertEqual(result['version'], '0.6.0-beta.1')
        self.assertIn('rules/betterleaks.toml', result['source_files'])

    def test_missing_source_rules_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing or different source runtime file'):
            release.verify(*self.pair(missing_source='rules/betterleaks.toml'))

    def test_missing_install_rules_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Install package missing'):
            release.verify(*self.pair(missing_runtime='rules/betterleaks.toml'))

    def test_runtime_byte_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing or different source runtime file'):
            release.verify(*self.pair(changed_source='lib/stores/catalog.js'))
