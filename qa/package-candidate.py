#!/usr/bin/env python3
"""Assemble reviewed public files and local candidate artifacts. Never publishes."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
OUT = ROOT.parent / 'output' / f'jingkan-v{VERSION}'
STAGE = OUT / 'public-repository'
OUT.mkdir(parents=True, exist_ok=True)
if STAGE.exists():
    shutil.rmtree(STAGE)
STAGE.mkdir()
roots = ['.gitignore', 'LICENSE', 'README.md', 'RELEASING.md', 'THIRD_PARTY_NOTICES.md',
         'package.json', 'package-lock.json', 'main.js', 'preload.js', 'source.js',
         'compat-video.cjs', 'crypto-compat.cjs', 'updater.cjs']
files = [ROOT / f for f in roots]
for directory in ['renderer', 'vendor', 'tests', 'scripts', '.github']:
    files.extend(p for p in (ROOT / directory).rglob('*') if p.is_file() and not p.is_symlink())
files.extend(ROOT / f for f in ['tools/ffmpeg/LICENSE', 'tools/ffmpeg/README',
             'qa/offline-integration.cjs', 'qa/make-fixtures.cjs', 'qa/verify-package.cjs',
             'qa/package-candidate.py', 'qa/alsa-null.conf'])
for file in files:
    assert file.is_file(), file
    target = STAGE / file.relative_to(ROOT)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, target)
manifest = [{'path': p.relative_to(STAGE).as_posix(), 'bytes': p.stat().st_size,
             'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in sorted(STAGE.rglob('*')) if p.is_file()]
(OUT / 'public-content-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
unit = (ROOT / 'qa/audit-final-unit.txt').read_text()
passed = re.search(r'pass (\d+)', unit)
assert passed and re.search(r'fail 0\b', unit), 'Unit suite did not pass'
ui_name = f'offline-{VERSION}.json'
ui = json.loads((ROOT / 'qa' / ui_name).read_text())
assert ui['version'] == VERSION and ui['pass'] and all(c['ok'] for c in ui['checks'])
package = json.loads((ROOT / 'qa/package-result.json').read_text())
assert package['version'] == VERSION
runtime = f'Jingkan-{VERSION}-windows-x64.zip'
installer = f'Jingkan-Setup-{VERSION}-x64.exe'
for name in [runtime, installer, installer + '.blockmap']:
    source = ROOT / 'dist' / name
    assert source.is_file() and source.stat().st_size > 0, source
    shutil.copy2(source, OUT / name)
if package['updateFeedConfigured']:
    latest = ROOT / 'dist/latest.yml'
    assert latest.is_file() and latest.stat().st_size > 0, latest
    shutil.copy2(latest, OUT / 'latest.yml')
with zipfile.ZipFile(OUT / runtime) as archive:
    assert archive.testzip() is None
    assert hashlib.sha256(archive.read('resources/app.asar')).digest() == hashlib.sha256((ROOT / 'dist/win-unpacked/resources/app.asar').read_bytes()).digest()
summary = {'version': VERSION, 'candidateOnly': True, 'publicRepositoryCreated': False,
           'published': False, 'updateFeedConfigured': package['updateFeedConfigured'],
           'unitTestsPassed': int(passed.group(1)), 'linuxOfflineChecksPassed': len(ui['checks']),
           'windowsNativeAcceptance': False, 'liveUpdateAcceptance': False,
           'publicFileCount': len(manifest),
           'note': 'Requires approval of public content, GitHub connection, real repository configuration, rebuild and Windows cross-version acceptance before final release.'}
(OUT / 'release-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
for name in ['audit-final-unit.txt', ui_name, 'package-result.json', 'dependency-audit-0.2.4.json', 'dependency-audit-all-0.2.4.json']:
    shutil.copy2(ROOT / 'qa' / name, OUT / name)
source_name = f'Jingkan-{VERSION}-source.zip'
with zipfile.ZipFile(OUT / source_name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
    prefix = f'Jingkan-{VERSION}-source'
    for file in sorted(STAGE.rglob('*')):
        if file.is_file(): archive.write(file, f'{prefix}/{file.relative_to(STAGE).as_posix()}')
    archive.write(ROOT / 'tools/ffmpeg/ffmpeg.exe', f'{prefix}/tools/ffmpeg/ffmpeg.exe')
    archive.writestr(f'{prefix}/qa/release-summary.json', json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(OUT / source_name) as archive:
    assert archive.testzip() is None
checksums = []
for file in sorted(OUT.iterdir()):
    if file.is_file() and file.name != 'SHA256SUMS.txt':
        with file.open('rb') as handle:
            checksums.append(f'{hashlib.file_digest(handle, "sha256").hexdigest()}  {file.name}\n')
(OUT / 'SHA256SUMS.txt').write_text(''.join(checksums))
print(json.dumps(summary, ensure_ascii=False, indent=2))
print('Output:', OUT)
