"""Validate matched before/after WebGL comparison runs, including exact PNG bytes."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import median


def distribution(samples):
    values = sorted(samples)
    assert values and all(math.isfinite(v) and v >= 0 for v in values)
    return {'count': len(values), 'medianMs': median(values), 'p95Ms': values[math.ceil(len(values)*.95)-1]}


def compare(workspace, before, after):
    root = Path(workspace)
    runs = [json.loads((root/(label+'.json')).read_text()) for label in (before, after)]
    variants = ['splatview-webgl2-32', 'splatview-webgl2-24']
    fixtures = ['256k-sparse', '256k-dense', '1m-sparse', '1m-dense']
    expected = {(fixture, variant, repetition) for fixture in fixtures for variant in variants for repetition in range(3)}
    groups = []
    for run in runs:
        assert not run['errors'] and run.get('finishedAt') and run['plannedVariants'] == variants
        assert len(run['cases']) == 24 and len(run['probes']) == 2
        assert {(c['fixtureId'], c['variant'], c['repetition']) for c in run['cases']} == expected
        assert run['browser'] == runs[0]['browser']
        values = {}
        for case in run['cases']+run['probes']:
            assert case['passed']
            value = json.loads((root/case['path']).read_text())
            assert not value['errors'] and not value['lost']
            assert value['retirement']['logicalRetainedBytes'] == 0
            for image in value['images']:
                data = (root/image['path']).read_bytes()
                assert len(data) == image['bytes'] and hashlib.sha256(data).hexdigest() == image['sha256']
            if case in run['cases']:
                assert len(value['samples']) == 120
                assert len(value['images']) == (6 if case['repetition'] == 0 else 0)
                values[(case['fixtureId'], case['variant'], case['repetition'])] = value
        groups.append(values)
    assert runs[0]['build']['references'] == runs[1]['build']['references']
    assert runs[0]['build']['engineSourceId'] != runs[1]['build']['engineSourceId']
    assert [c['id'] for c in runs[0]['cases']] == [c['id'] for c in runs[1]['cases']]
    rows, images = [], []
    for fixture in fixtures:
        for variant in variants:
            row = {'fixture': fixture, 'variant': variant}
            cohort = [[g[(fixture, variant, rep)] for rep in range(3)] for g in groups]
            assert cohort[0][0]['fixture'] == cohort[1][0]['fixture']
            assert cohort[0][0]['info'] == cohort[1][0]['info']
            for old, new in zip(*cohort):
                assert old['fixture'] == new['fixture'] and old['info'] == new['info']
                assert [(s['phase'], s['index'], s['angle']) for s in old['samples']] == [(s['phase'], s['index'], s['angle']) for s in new['samples']]
            for name, values in zip(('before', 'after'), cohort):
                metrics = {'workerRoundTrip': distribution([w['roundTripMs'] for v in values for w in v['worker']])}
                for phase in ('motion', 'fixed'):
                    samples = [s for v in values for s in v['samples'] if s['phase'] == phase]
                    assert len(samples) == 180
                    metrics[phase] = {field: distribution([s[field] for s in samples]) for field in ('submissionMs', 'completionMs')}
                row[name] = metrics
            assert row['before']['workerRoundTrip']['count'] == row['after']['workerRoundTrip']['count'] == 186
            row['workerMedianReductionPercent'] = 100*(1-row['after']['workerRoundTrip']['medianMs']/row['before']['workerRoundTrip']['medianMs'])
            for old, new in zip(cohort[0][0]['images'], cohort[1][0]['images']):
                assert (old['phase'], old['index'], old['angle']) == (new['phase'], new['index'], new['angle'])
                assert old['sha256'] == new['sha256'], f'Changed image: {fixture}/{variant}/{old["phase"]}/{old["index"]}'
                images.append({'fixture': fixture, 'variant': variant, 'phase': old['phase'], 'index': old['index'],
                               'before': old['path'], 'after': new['path'], 'sha256': old['sha256'], 'identical': True})
            rows.append(row)
    return {'schemaVersion': 1, 'kind': 'webgl-sort-comparison', 'labels': [before, after],
            'engineSourceIds': [r['build']['engineSourceId'] for r in runs], 'browser': runs[0]['browser'],
            'casesPerBuild': 24, 'probesPerBuild': 2, 'samplesPerPhasePerSeries': 180,
            'identicalSnapshotPairs': len(images), 'series': rows, 'images': images,
            'scope': 'Current-sort worker round trip includes queue/transport. Completion uses gl.finish; no physical presentation FPS claim. Same precision, fixture, camera, framebuffer and frozen external references.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace')
    parser.add_argument('before')
    parser.add_argument('after')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = compare(args.workspace, args.before, args.after)
    Path(args.output).write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    for row in result['series']:
        print(row['fixture'], row['variant'], f"{row['before']['workerRoundTrip']['medianMs']:.2f} -> {row['after']['workerRoundTrip']['medianMs']:.2f} ms ({row['workerMedianReductionPercent']:.1f}% lower)")
    print(f"Validated {result['identicalSnapshotPairs']} identical image pairs, 48 cases and 4 calibration probes")
