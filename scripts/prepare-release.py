#!/usr/bin/env python3
"""Build and verify the install/source pair. Python is a release-tool dependency only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile


REQUIRED = {
    'package.json', 'lib/memory-team.js', 'lib/core/service.js', 'lib/stores/catalog.js',
    'lib/stores/markdown-store.js', 'lib/stores/sqlite-store.js', 'lib/legacy/stream-guard.js', 'lib/windows-acl.js',
    'rules/betterleaks.toml', 'scripts/inspect-windows-acl.mjs', 'scripts/migrate.mjs', 'locale/en.json', 'locale/zh.json',
    'cordis.patch.yml', 'icon.jpg', 'README.md', 'LICENSE', 'docs/migration.md', 'docs/compatibility.md',
    'docs/plugin-preview-en.jpg', 'docs/plugin-preview-zh.jpg',
}
SOURCE_REQUIRED = {'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'test/filesystem.test.js', 'test/contract.test.js',
                   'test/windows-acl.test.js', 'scripts/prepare-release.py', '.github/workflows/test.yml',
                   'bench/run.mjs', 'bench/fixtures/recall-corpus.mjs'}


def relative_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        raise ValueError('Unsafe archive member: ' + name)
    return path


def verify(tgz, source):
    with tarfile.open(tgz, 'r:gz') as archive:
        runtime = {}
        for item in archive.getmembers():
            path = relative_name(item.name)
            if not path.parts or path.parts[0] != 'package':
                raise ValueError('Unexpected install archive root')
            if item.isdir():
                continue
            if not item.isfile():
                raise ValueError('Install archive contains a link or special file')
            name = path.relative_to('package').as_posix()
            if name in runtime:
                raise ValueError('Duplicate install member: ' + name)
            runtime[name] = archive.extractfile(item).read()
    if not REQUIRED <= runtime.keys():
        raise ValueError('Install package missing: ' + ', '.join(sorted(REQUIRED - runtime.keys())))
    with zipfile.ZipFile(source) as archive:
        members = {}
        roots = set()
        for item in archive.infolist():
            path = relative_name(item.filename)
            if item.is_dir():
                continue
            roots.add(path.parts[0])
            name = PurePosixPath(*path.parts[1:]).as_posix()
            if name in members:
                raise ValueError('Duplicate source member: ' + name)
            members[name] = archive.read(item)
        if len(roots) != 1 or not SOURCE_REQUIRED <= members.keys():
            raise ValueError('Source archive is incomplete or has multiple roots')
    for name, content in runtime.items():
        if name == 'package.json':
            packed, original = json.loads(content), json.loads(members.get(name, b'{}'))
            # pnpm strips its packageManager metadata from published manifests.
            for key in ('name', 'version', 'main', 'exports', 'files', 'engines', 'dependencies'):
                if packed.get(key) != original.get(key):
                    raise ValueError('Runtime/source manifest mismatch: ' + key)
        elif members.get(name) != content:
            raise ValueError('Missing or different source runtime file: ' + name)
    return {'version': json.loads(runtime['package.json'])['version'],
            'runtime_files': sorted(runtime), 'source_files': sorted(members)}


def build(output):
    root = Path(__file__).resolve().parent.parent
    package = json.loads((root / 'package.json').read_text())
    label = package['name'] + '-' + package['version']
    output = (root / output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    tgz, source = output / (label + '.tgz'), output / (label + '-source.zip')
    if tgz.exists() or source.exists():
        raise ValueError('Release files already exist; choose a new output directory')
    files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root)
    sources = sorted(set(name.decode('utf-8') for name in files.split(b'\0') if name))
    manager = os.environ.get('npm_execpath')
    pack = [os.environ.get('npm_node_execpath', shutil.which('node')), manager] if manager else [shutil.which('pnpm')]
    if not all(pack):
        raise ValueError('pnpm and Node.js are required to prepare a release')
    subprocess.run([*pack, 'pack', '--pack-destination', str(output)], cwd=root, check=True)
    with zipfile.ZipFile(source, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sources:
            relative_name(name)
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Source files must be regular files: ' + name)
            archive.write(path, label + '/' + name)
    result = verify(tgz, source)
    result['sha256'] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (tgz, source)}
    (output / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS').write_text(''.join(digest + '  ' + name + '\n' for name, digest in result['sha256'].items()), encoding='utf-8')
    print(json.dumps({'output': str(output), 'version': result['version'], 'sha256': result['sha256']}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='.local/releases/' + json.loads((Path(__file__).resolve().parent.parent / 'package.json').read_text())['version'])
    parser.add_argument('--verify', nargs=2, metavar=('TGZ', 'SOURCE_ZIP'))
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify(*args.verify), ensure_ascii=False, indent=2))
    else:
        build(args.out)
