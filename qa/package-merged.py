#!/usr/bin/env python3
"""Collect the merged local release candidate; no remote/publish operations."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
assert version == '0.2.5'
out = root.parent / 'output' / f'jingkan-v{version}-merged'
out.mkdir(parents=True, exist_ok=True)
ui = json.loads((root / 'qa/merged-integration-result.json').read_text())
assert ui['version'] == version and ui['pass'] and all(row['ok'] for row in ui['checks'])
unit = (root / 'qa/merged-unit-final.log').read_text()
assert 'fail 0' in unit and 'pass 94' in unit, 'final test suite must pass'
package = json.loads((root / 'qa/package-result.json').read_text())
assert package['version'] == version and package['updateFeedConfigured']
assets = [f'Jingkan-{version}-windows-x64.zip', f'Jingkan-Setup-{version}-x64.exe',
          f'Jingkan-Setup-{version}-x64.exe.blockmap', 'latest.yml']
for name in assets:
    source = root / 'dist' / name
    assert source.is_file() and source.stat().st_size > 0
    shutil.copy2(source, out / name)
with zipfile.ZipFile(out / assets[0]) as archive:
    assert archive.testzip() is None
    assert archive.read('resources/app.asar') == (root / 'dist/win-unpacked/resources/app.asar').read_bytes()
files = [root / name for name in ['.gitignore', 'LICENSE', 'README.md', 'RELEASING.md',
    'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'main.js', 'preload.js',
    'source.js', 'compat-video.cjs', 'crypto-compat.cjs', 'updater.cjs']]
for directory in ['renderer', 'vendor', 'tests', 'scripts', '.github', 'tools/ffmpeg']:
    files.extend(p for p in (root / directory).rglob('*') if p.is_file() and not p.is_symlink())
qa = ['merged-integration.cjs', 'fullscreen-integration.cjs', 'offline-integration.cjs',
      'verify-package.cjs', 'package-merged.py', 'alsa-null.conf', 'merged-unit-final.log',
      'merged-integration-result.json', 'package-result.json', 'pipeline-benchmark.cjs',
      'pipeline-benchmark-result.json', 'historical-pipeline-result.json']
files.extend(root / 'qa' / name for name in qa)
files.extend((root / 'qa/fixtures').glob('*.mp4'))
source_archive = out / f'Jingkan-{version}-source.zip'
with zipfile.ZipFile(source_archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
    for file in sorted(set(files)):
        assert file.is_file(), file
        archive.write(file, f'Jingkan-{version}-source/{file.relative_to(root).as_posix()}')
with zipfile.ZipFile(source_archive) as archive:
    assert archive.testzip() is None
for name in ['merged-unit-final.log', 'merged-integration-result.json', 'package-result.json',
             'pipeline-benchmark-result.json', 'historical-pipeline-result.json']:
    shutil.copy2(root / 'qa' / name, out / name)
summary = {'version': version, 'sourceRoot': str(root), 'readyForCoordinatorRelease': True,
    'published': False, 'pushedToGitHub': False, 'targetRepository': 'xiaoyang123520/jingkan-player',
    'unitTestsPassed': 94, 'linuxElectronIntegrationPassed': len(ui['checks']),
    'windowsNativeAcceptance': False, 'liveUpdateAcceptance': False,
    'notes': 'Merged prior fullscreen candidate with bounded download/encode overlap, optional quality latency removal, cached prefix reuse and progress-write deduplication. No remote operations performed.'}
(out / 'candidate-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
checksums = []
for file in sorted(out.iterdir()):
    if file.is_file() and file.name != 'SHA256SUMS.txt':
        with file.open('rb') as stream:
            checksums.append(hashlib.file_digest(stream, 'sha256').hexdigest() + '  ' + file.name + '\n')
(out / 'SHA256SUMS.txt').write_text(''.join(checksums))
print(json.dumps(summary, ensure_ascii=False, indent=2))
print('Output:', out)
