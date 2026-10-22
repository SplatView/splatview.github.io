from pathlib import Path
import argparse
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
source = root / 'reference/windows'
output = root / 'src/generated'
definitions = (source / 'src/icons.def').read_text(encoding='utf-8')
icons = {}
for name, filename in re.findall(r'SPLAT_ICON\((\w+), "([^"]+)"\)', definitions):
    svg = (source / 'assets/icons' / (filename + '.svg')).read_text(encoding='utf-8')
    icons[name] = svg
fields = []
header = (source / 'src/color.hpp').read_text(encoding='utf-8')
number = r'(-?\d*\.?\d+f?)'
pattern = r'\{"([^"]+)", "([^"]+)",\s*' + number + r',\s*' + number + r',\s*' + number + r'(?:,\s*' + number + r',\s*"([^"]+)")?\}'
for name, label, low, high, neutral, scale, format in re.findall(pattern, header):
    fields.append({'name': name, 'label': label, 'low': float(low.strip().rstrip('f')),
                   'high': float(high.strip().rstrip('f')), 'neutral': float(neutral.strip().rstrip('f')),
                   'displayScale': float(scale.rstrip('f')) if scale else 1, 'format': format or '%.2f'})
presets = json.loads((source / 'src/gsmod_presets.json').read_text(encoding='utf-8'))['color']
data = '// Generated from the pinned Windows source. Run python tools/generate-assets.py.\n'
data += 'export const desktopIcons: Record<string, string> = ' + json.dumps(icons) + ';\n'
data += 'export const colorFields = ' + json.dumps(fields) + ' as const;\n'
data += 'export const colorPresets: Record<string, Record<string, number>> = ' + json.dumps(presets) + ';\n'

# Keep the original desktop.ts capture intact. New desktop actions can use a
# separately reviewed supplement without silently migrating the whole palette.
current_capture = root / 'reference/targets/windows-r0-20261012-02'
current_source = current_capture / 'source'
supplemental_assets = {'Grow': 'selection-grow', 'Shrink': 'selection-shrink', 'CenterPivot': 'pivot-center'}
supplemental_records = {
    'src/icons.def': (2692, '19da533f1f72f70ba86f4782d435a25257ad4db4a77afaf7cbea3c748cf23d72'),
    'assets/icons/selection-grow.svg': (325, '6ef8dce31dcd358cc4f7bb665c9fbbae402c2c3f97f274ff1f9e480d46ed67b5'),
    'assets/icons/selection-shrink.svg': (346, '398ac533fbfc7e693d1bc51aa9bda1716b40b014cd3713eb5344482df0e6eb35'),
    'assets/icons/pivot-center.svg': (260, '371619a63f9a803ed520beb9319639e36963d7c4f5c8034790774bd29c500142'),
}
manifest = json.loads((current_capture / 'CAPTURE_MANIFEST.json').read_text(encoding='utf-8'))
if manifest.get('schemaVersion') != 1 or manifest.get('captureId') != 'cc71f0df-8f38-4900-8aff-5c9ee0d6814c':
    raise SystemExit('Unsupported current desktop icon capture. Review its pinned manifest before generation.')

def verified_current_asset(path):
    expected_bytes, expected_sha = supplemental_records[path]
    entries = [item for item in manifest.get('files', []) if item.get('path') == path]
    if len(entries) != 1 or entries[0].get('bytes') != expected_bytes or entries[0].get('sha256') != expected_sha:
        raise SystemExit(f'Current desktop icon manifest differs from the reviewed capture: {path}')
    target = current_source / path
    if not target.is_file() or target.is_symlink() or not target.resolve().is_relative_to(current_source.resolve()):
        raise SystemExit(f'Missing or unsafe current desktop icon source: {path}')
    captured = target.read_bytes()
    if len(captured) != expected_bytes or hashlib.sha256(captured).hexdigest() != expected_sha:
        raise SystemExit(f'Current desktop icon source differs from its capture manifest: {path}')
    return captured.decode('utf-8')

current_definitions = verified_current_asset('src/icons.def')
current_mappings = re.findall(r'SPLAT_ICON\((\w+), "([^"]+)"\)', current_definitions)
current_icons = {}
for name, filename in supplemental_assets.items():
    matches = [asset for symbol, asset in current_mappings if symbol == name]
    if matches != [filename]:
        raise SystemExit(f'Current desktop icon mapping differs from the reviewed capture: {name}')
    current_icons[name] = verified_current_asset('assets/icons/' + filename + '.svg')
# The later committed desktop adds two pivot modes. Keep this finite capture
# separate from the original frozen palette and its existing supplement.
pivot_capture = root / 'reference/targets/windows-pivot-20261016-01'
pivot_source = pivot_capture / 'source'
pivot_records = {
    'src/icons.def': (2768, 'ad6d4bfdb71fa00f5e19b462eb5c518bf0da5d67f2ef013ea30e1da6d77e6ea6'),
    'assets/icons/pivot-selection.svg': (324, 'f85caf6effc4aa768ee08734ca0c5106081d30983dd6e14dc9bc17c51e78fcf7'),
    'assets/icons/pivot-origin.svg': (312, 'd5357c49ada218878f065839a7098b6199048104bf61d5e62a4168bfbf891957'),
}
pivot_manifest = json.loads((pivot_capture / 'CAPTURE_MANIFEST.json').read_text(encoding='utf-8'))
if (pivot_manifest.get('schemaVersion') != 1 or pivot_manifest.get('captureId') != 'windows-pivot-20261016-01'
        or pivot_manifest.get('desktopCommit') != '4e1be155511fb49f08fd8c863d785ac008a4c43a'
        or pivot_manifest.get('desktopVersion') != '1.0.2'):
    raise SystemExit('Unsupported desktop pivot icon capture. Review its pinned manifest before generation.')

def verified_pivot_asset(path):
    expected_bytes, expected_sha = pivot_records[path]
    entries = [item for item in pivot_manifest.get('files', []) if item.get('path') == path]
    if len(entries) != 1 or entries[0].get('bytes') != expected_bytes or entries[0].get('sha256') != expected_sha:
        raise SystemExit(f'Desktop pivot icon manifest differs from the reviewed capture: {path}')
    target = pivot_source / path
    if not target.is_file() or target.is_symlink() or not target.resolve().is_relative_to(pivot_source.resolve()):
        raise SystemExit(f'Missing or unsafe desktop pivot icon source: {path}')
    captured = target.read_bytes()
    if len(captured) != expected_bytes or hashlib.sha256(captured).hexdigest() != expected_sha:
        raise SystemExit(f'Desktop pivot icon source differs from its capture manifest: {path}')
    return captured.decode('utf-8')

pivot_mappings = re.findall(r'SPLAT_ICON\((\w+), "([^"]+)"\)', verified_pivot_asset('src/icons.def'))
for name, filename in {'SelectionPivot': 'pivot-selection', 'OriginPivot': 'pivot-origin'}.items():
    matches = [asset for symbol, asset in pivot_mappings if symbol == name]
    if matches != [filename] or pivot_manifest.get('mappings', {}).get(name) != filename:
        raise SystemExit(f'Desktop pivot icon mapping differs from the reviewed capture: {name}')
    current_icons[name] = verified_pivot_asset('assets/icons/' + filename + '.svg')
# Committed desktop 1.0.2 maps Duplicate to copy.svg. The exact asset already
# belongs to the original source/public closure; reuse it without another file.
duplicate_asset = (source / 'assets/icons/copy.svg').read_bytes()
if hashlib.sha256(duplicate_asset).hexdigest() != 'ea80e566c7a12628a447cb53179b19aea4f60b9143e2becd0d0f20bf260e5718':
    raise SystemExit('The captured Duplicate icon changed; review its source identity.')
current_icons['Duplicate'] = duplicate_asset.decode('utf-8')
supplement = '// Generated from verified desktop captures; see tools/generate-assets.py.\n'
supplement += 'export const currentDesktopIcons: Readonly<Record<string, string>> = ' + json.dumps(current_icons) + ';\n'
parser = argparse.ArgumentParser(description='Generate or verify product data from the pinned Windows reference.')
parser.add_argument('--check', action='store_true', help='Fail if generated data differs; do not write files.')
args = parser.parse_args()
target = output / 'desktop.ts'
supplemental_target = output / 'currentDesktopIcons.ts'
if args.check:
    if not target.is_file() or target.read_text(encoding='utf-8') != data:
        raise SystemExit('Generated product data differs. Review the frozen source, then run python tools/generate-assets.py.')
    if not supplemental_target.is_file() or supplemental_target.read_bytes() != supplement.encode('utf-8'):
        raise SystemExit('Generated current desktop icons differ. Review the capture, then run python tools/generate-assets.py.')
else:
    output.mkdir(parents=True, exist_ok=True)
    # Preserve exact baseline bytes (including its historical newline encoding)
    # when the existing generation is already current.
    if not target.is_file() or target.read_text(encoding='utf-8') != data:
        target.write_text(data, encoding='utf-8')
    supplemental_bytes = supplement.encode('utf-8')
    if not supplemental_target.is_file() or supplemental_target.read_bytes() != supplemental_bytes:
        supplemental_target.write_bytes(supplemental_bytes)
print(f'{"Verified" if args.check else "Generated"} {len(icons)} baseline native icons, {len(current_icons)} current desktop icons, {len(fields)} color fields and {len(presets)} presets.')
