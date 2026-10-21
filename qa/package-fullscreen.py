#!/usr/bin/env python3
"""Collect local fullscreen candidates only. Never contacts or publishes to GitHub."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
out = root.parent / 'output' / f'jingkan-v{version}'
out.mkdir(parents=True, exist_ok=True)
ui = json.loads((root / 'qa/fullscreen-integration-result.json').read_text())
assert ui['version'] == version and ui['pass'] and all(c['ok'] for c in ui['checks'])
unit = (root / 'qa/fullscreen-unit.log').read_text()
assert 'fail 0' in unit and 'pass ' in unit
for name in [f'Jingkan-{version}-windows-x64.zip', f'Jingkan-Setup-{version}-x64.exe']:
    src = root / 'dist' / name
    assert src.is_file() and src.stat().st_size > 10000000, src
    shutil.copy2(src, out / name)
with zipfile.ZipFile(out / f'Jingkan-{version}-windows-x64.zip') as z:
    assert z.testzip() is None
    assert z.read('resources/app.asar') == (root / 'dist/win-unpacked/resources/app.asar').read_bytes()
roots = ['.gitignore', 'LICENSE', 'README.md', 'RELEASING.md', 'THIRD_PARTY_NOTICES.md',
         'package.json', 'package-lock.json', 'main.js', 'preload.js', 'source.js',
         'compat-video.cjs', 'crypto-compat.cjs', 'updater.cjs']
files = [root / p for p in roots]
for name in ['renderer', 'vendor', 'tests', 'scripts', '.github', 'tools/ffmpeg']:
    files += [p for p in (root / name).rglob('*') if p.is_file() and not p.is_symlink()]
for name in ['fullscreen-integration.cjs', 'offline-integration.cjs', 'verify-package.cjs',
             'package-fullscreen.py', 'alsa-null.conf', 'fullscreen-unit.log',
             'fullscreen-integration-result.json', 'package-result.json', 'startup-benchmark.cjs', 'startup-benchmark-result.txt']:
    files.append(root / 'qa' / name)
files += list((root / 'qa/fixtures').glob('*.mp4'))
source = out / f'Jingkan-{version}-source.zip'
with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as z:
    for p in sorted(set(files)):
        assert p.is_file(), p
        z.write(p, f'Jingkan-{version}-source/{p.relative_to(root).as_posix()}')
with zipfile.ZipFile(source) as z:
    assert z.testzip() is None
for name in ['fullscreen-unit.log', 'fullscreen-integration-result.json', 'package-result.json', 'startup-benchmark.cjs', 'startup-benchmark-result.txt']:
    shutil.copy2(root / 'qa' / name, out / name)
summary = {'version': version, 'candidateOnly': True, 'published': False, 'pushedToGitHub': False,
           'linuxElectronIntegrationPassed': len(ui['checks']), 'windowsNativeAcceptance': False,
           'notes': 'Independent fullscreen entry, button exit and Escape tested with real mouse/key events. Windows runtime built and archive verified, not run on Windows.'}
(out / 'candidate-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
checksums = []
for p in sorted(out.iterdir()):
    if p.is_file() and p.name != 'SHA256SUMS.txt':
        with p.open('rb') as f:
            checksums.append(hashlib.file_digest(f, 'sha256').hexdigest() + '  ' + p.name + '\n')
(out / 'SHA256SUMS.txt').write_text(''.join(checksums))
print(json.dumps(summary, ensure_ascii=False, indent=2))
print('Output:', out)
