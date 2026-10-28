"""Promote a qualified published release to static main; dry run by default."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

from artifact_io import archive_members, checked_path, download, safe_name, verify_bytes
from bootstrap_runtime import NATIVE_FILES, ROOT, load_tool

REPOSITORY = 'SplatView/splatview.github.io'
REMOTE = f'https://github.com/{REPOSITORY}.git'
SITE = 'https://splatview.github.io/'
PROTECTED = ('EULA.txt', 'PRIVACY.txt', 'opsiclear.png', 'privacy/index.html',
             'publisher/index.html', 'robots.txt', 'sitemap.xml', 'style.css', 'terms/index.html')


def command(args, cwd=ROOT, binary=False):
    result = subprocess.check_output(args, cwd=cwd, text=not binary)
    return result if binary else result.strip()


def git(*args, cwd=ROOT, binary=False):
    return command(['git', *args], cwd, binary)


def api(path, method='GET'):
    return json.loads(command(['gh', 'api', '--method', method, f'repos/{REPOSITORY}/{path}']))


def version_tuple(tag):
    if not isinstance(tag, str) or not re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', tag):
        raise ValueError('Release must be an exact stable version tag, for example v0.2.2')
    return tuple(map(int, tag[1:].split('.')))


def release_assets(release, tag):
    version_tuple(tag)
    if release.get('draft') is not False or release.get('prerelease') is not False or release.get('tag_name') != tag:
        raise ValueError('Only an already published stable release can be promoted')
    assets = {}
    for item in release['assets']:
        name = safe_name(item['name'])
        if name.casefold() in {key.casefold() for key in assets}:
            raise ValueError('Duplicate release asset')
        assets[name] = item
    names = ('SHA256SUMS.txt', 'validation.json', 'build-manifest.json', f'SplatView-web-{tag}.zip')
    selected = {}
    for name in names:
        item = assets[name]
        digest = item.get('digest') or ''
        if not re.fullmatch('sha256:[a-f0-9]{64}', digest):
            raise ValueError(f'Missing GitHub SHA-256 digest: {name}')
        expected = f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
        if item['browser_download_url'] != expected:
            raise ValueError('Unexpected release asset URL')
        selected[name] = {'url': expected, 'bytes': item['size'], 'sha256': digest[7:]}
    return selected


def verify_checksums(data, assets):
    entries = {}
    for line in data.decode('utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([^\r\n]+)', line)
        if not match or safe_name(match[2]) in entries:
            raise ValueError('Invalid/duplicate SHA256SUMS record')
        entries[match[2]] = match[1]
    for name, record in assets.items():
        if name != 'SHA256SUMS.txt' and entries.get(name) != record['sha256']:
            raise ValueError(f'Release checksum manifest differs: {name}')


def extract(archive, target, allow_directories=False):
    with zipfile.ZipFile(archive) as bundle:
        members = archive_members(bundle, allow_directories)
        # Fully read/preflight before writing; no links, aliases, traversal or
        # unbounded expansion. This is an isolated new directory.
        contents = {name: bundle.read(info) for name, info in members.items()}
    for name, data in contents.items():
        path = checked_path(target, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(data)


def verify_receipt(receipt, tag, commit, qualified, archive_record):
    if (receipt.get('schemaVersion') != 1 or receipt.get('version') != tag[1:] or
            receipt.get('status') != 'qualified-pages-and-live-update-verified' or
            receipt.get('source', {}).get('commit') != commit or
            receipt['source'].get('tag') != tag or receipt['source'].get('annotated') is not True):
        raise ValueError('Release qualification/source/version does not match the tag')
    for field in ('deploymentId', 'appInputId'):
        if receipt.get('build', {}).get(field) != qualified[field]:
            raise ValueError(f'Release qualification {field} differs from independently verified bytes')
    records = receipt['build']['distributionAssets']
    matches = [row for row in records if row['path'].endswith(f'/SplatView-web-{tag}.zip')]
    if len(matches) != 1 or any(matches[0].get(key) != archive_record[key] for key in ('bytes', 'sha256')):
        raise ValueError('Release qualification archive differs')


def stage_distribution(target, distribution, qualified, tag, commit):
    # Snapshot publisher/legal leaves from this exact fetched main, not old
    # receipts; keep every existing leaf and add only qualified distribution.
    protected = {name: checked_path(target, name).read_bytes() for name in PROTECTED}
    existing = json.loads(checked_path(target, 'build-manifest.json').read_bytes())
    # Downgrades need a separate reviewed rollback path, never a checkbox here.
    old_readme = checked_path(target, 'README.md').read_text(encoding='utf-8')
    old_version = re.search(r'^# SplatView web (\d+\.\d+\.\d+)', old_readme)
    if old_version is None or version_tuple(tag) < version_tuple('v' + old_version[1]):
        raise ValueError('Missing current version or attempted release downgrade')
    if tag[1:] == old_version[1] and existing['deploymentId'] != qualified['deploymentId']:
        raise ValueError('Same published version has a different deployment identity')
    for record in qualified['files']:
        name = safe_name(record['path'])
        if any(part.casefold() in ('.git', '.github') for part in name.split('/')) or name.casefold() in (
                'readme.md', '.gitattributes', '.nojekyll', 'cname'):
            raise ValueError(f'Release contains a static administration file: {name}')
        data = checked_path(distribution, name).read_bytes()
        verify_bytes(data, {key: record[key] for key in ('bytes', 'sha256')}, name)
        if name in protected and data != protected[name]:
            raise ValueError(f'Release would change preserved publisher/legal asset: {name}')
        path = checked_path(target, name)
        if name.startswith('assets/') and path.exists() and path.read_bytes() != data:
            raise ValueError(f'Previously published asset path has different bytes: {name}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    checked_path(target, '.gitattributes').write_bytes(b'* -text\n')
    checked_path(target, '.nojekyll').write_bytes(b'')
    checked_path(target, 'README.md').write_text(f'''# SplatView web {tag[1:]}

[Open the viewer]({SITE}).

This branch contains the published website. Source and development instructions
are on the [source branch](https://github.com/{REPOSITORY}/tree/source).
The [{tag} release](https://github.com/{REPOSITORY}/releases/tag/{tag})
includes the self-hosted website and reusable WebGPU/WebGL2 renderer.

Source commit: `{commit}`.
Deployment: `{qualified['deploymentId']}`.

Previously published publisher/legal pages and hashed assets are retained.
''', encoding='utf-8', newline='\n')
    for name, data in protected.items():
        if checked_path(target, name).read_bytes() != data:
            raise ValueError(f'Publisher/legal asset changed: {name}')
    git('add', '--all', cwd=target)
    for record in qualified['files']:
        data = git('show', ':' + record['path'], cwd=target, binary=True)
        verify_bytes(data, {key: record[key] for key in ('bytes', 'sha256')}, record['path'])
    for name, data in protected.items():
        if git('show', ':' + name, cwd=target, binary=True) != data:
            raise ValueError(f'Staged publisher/legal bytes differ: {name}')
    return protected


def verify_live(qualified, protected, commit):
    for attempt in range(60):
        build = api('pages/builds/latest')
        print(f'Pages: {build.get("status")} at {build.get("commit")}', flush=True)
        if build.get('commit') == commit and build.get('status') == 'built':
            break
        if build.get('commit') == commit and build.get('status') == 'errored':
            raise ValueError('Pages build failed')
        time.sleep(5)
    else:
        raise ValueError('Timed out verifying the requested Pages commit')
    records = {row['path']: {key: row[key] for key in ('bytes', 'sha256')} for row in qualified['files']}
    records.update({name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in protected.items()})
    for name, record in records.items():
        request = urllib.request.Request(SITE + name + '?deployment=' + qualified['deploymentId'], headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            verify_bytes(response.read(record['bytes'] + 1), record, name)
            mime = response.headers.get_content_type()
            if name.endswith(('.js', '.mjs')) and mime not in ('text/javascript', 'application/javascript'):
                raise ValueError(f'Wrong JavaScript MIME: {name}: {mime}')
            if name.endswith('.wasm') and mime != 'application/wasm':
                raise ValueError(f'Wrong WASM MIME: {name}: {mime}')
    return len(records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, help='Published stable tag, e.g. v0.2.2')
    parser.add_argument('--publish', action='store_true', help='Explicitly push verified static bytes and request Pages build')
    args = parser.parse_args()
    version_tuple(args.release)
    if args.publish and git('status', '--porcelain'):
        raise ValueError('Publish from a clean, reviewed source checkout; inspect local changes first')
    if git('remote', 'get-url', 'origin').removesuffix('.git') != REMOTE.removesuffix('.git'):
        raise ValueError('Deployment is restricted to the SplatView repository origin')
    if git('branch', '--show-current') != 'source' and os.environ.get('GITHUB_REF') != 'refs/heads/source':
        # Local branch may have a different name while tracking origin/source.
        if git('rev-parse', '--abbrev-ref', '@{upstream}') != 'origin/source':
            raise ValueError('Run promotion from the trusted source branch')
    pages = api('pages')
    if pages.get('source') != {'branch': 'main', 'path': '/'} or pages.get('html_url', '').rstrip('/') != SITE.rstrip('/'):
        raise ValueError('Unexpected Pages source/site; refusing to change configuration')
    release = api('releases/tags/' + args.release)
    assets = release_assets(release, args.release)
    parent = ROOT / '.build/validation'
    parent.mkdir(parents=True, exist_ok=True)
    phase = Path(tempfile.mkdtemp(prefix='deploy-' + args.release + '-', dir=parent))
    print(f'Deployment logs/candidate: {phase}', flush=True)
    git('fetch', 'origin', 'source', 'main', 'tag', args.release)
    if git('cat-file', '-t', 'refs/tags/' + args.release) != 'tag':
        raise ValueError('Release source tag must be annotated')
    source_commit = git('rev-parse', 'refs/tags/' + args.release + '^{commit}')
    git('merge-base', '--is-ancestor', source_commit, 'origin/source')
    source_zip = phase / 'source.zip'
    git('archive', '--format=zip', '--output=' + str(source_zip), source_commit)
    source = phase / 'source'
    extract(source_zip, source, allow_directories=True)
    cached = {}
    for name, record in assets.items():
        cached[name] = download(record['url'], {key: record[key] for key in ('bytes', 'sha256')}, ROOT / '.build/cache/releases')
    verify_checksums(cached['SHA256SUMS.txt'].read_bytes(), assets)
    distribution = phase / 'distribution'
    archive_name = f'SplatView-web-{args.release}.zip'
    extract(cached[archive_name], distribution)
    if checked_path(distribution, 'build-manifest.json').read_bytes() != cached['build-manifest.json'].read_bytes():
        raise ValueError('Published manifest differs from archive manifest')
    for name in NATIVE_FILES:
        destination = checked_path(source, 'public/wasm/' + name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(checked_path(distribution, 'wasm/' + name).read_bytes())
    load_tool(ROOT, 'verify-toolchain').verify_build_report(source)
    output = phase / 'qualified-distribution.json'
    node = os.environ.get('npm_node_execpath') or shutil.which('node')
    if not node:
        raise ValueError('Node is required; install the version in .node-version')
    command([node, str(ROOT / 'tools/verify-distribution.mjs'), str(source), str(distribution), args.release[1:], str(output)])
    qualified = json.loads(output.read_bytes())
    verify_receipt(json.loads(cached['validation.json'].read_bytes()), args.release, source_commit, qualified, assets[archive_name])
    base = git('rev-parse', 'origin/main')
    target = phase / 'static'
    git('worktree', 'add', '--detach', str(target), base)
    try:
        protected = stage_distribution(target, distribution, qualified, args.release, source_commit)
        report = {'schemaVersion': 1, 'release': args.release, 'sourceCommit': source_commit,
                  'staticBase': base, 'deploymentId': qualified['deploymentId'], 'files': len(qualified['files']),
                  'preservedPublisherFiles': len(protected), 'dryRun': not args.publish,
                  'stagedDiff': git('diff', '--cached', '--stat', cwd=target)}
        (phase / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        if args.publish:
            changed = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=target).returncode
            if changed not in (0, 1):
                raise ValueError('Could not inspect the staged static candidate')
            if changed:
                git('-c', 'user.name=SplatView automation', '-c', 'user.email=actions@users.noreply.github.com',
                    'commit', '-m', f'Publish SplatView web {args.release[1:]}\n\nSource: {source_commit}\nDeployment: {qualified["deploymentId"]}', cwd=target)
                git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
                    'push', 'origin', 'HEAD:main', cwd=target)
            published = git('rev-parse', 'HEAD', cwd=target)
            api('pages/builds', 'POST')
            report.update({'staticCommit': published, 'liveVerifiedFiles': verify_live(qualified, protected, published)})
            (phase / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, indent=2))
    finally:
        # Keep the reviewable candidate and index, unregister only when the user
        # explicitly removes this ignored validation directory later.
        print(f'Candidate retained: {target}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        raise SystemExit(f'Deployment refused: {error}') from error
