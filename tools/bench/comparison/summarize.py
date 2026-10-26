"""Validate raw renderer comparison evidence and summarize compatible clocks."""
import argparse
import json
import math
from pathlib import Path
from statistics import median


def distribution(values):
    values=sorted(values)
    if not values or any(not math.isfinite(v) or v<0 for v in values):
        raise ValueError('Missing/invalid timing samples')
    return {'count':len(values),'medianMs':median(values),'p95Ms':values[math.ceil(len(values)*.95)-1]}


def summarize(workspace):
    root=Path(workspace)
    raw=json.loads((root/'results.json').read_text())
    assert not raw['errors'] and raw.get('finishedAt')
    assert len(raw['probes'])==7 and len(raw['cases'])==84
    groups={}
    images=[]
    for case in raw['cases']:
        value=json.loads((root/case['path']).read_text())
        assert not value['errors'] and not value['lost']
        assert len(value['samples'])==120
        assert value['retirement'].get('logicalRetainedBytes',0)==0
        key=(case['fixtureId'],case['variant'])
        groups.setdefault(key,[]).append(value)
        images.extend({'fixture':case['fixtureId'],'variant':case['variant'],**image} for image in value['images'])
    rows=[]
    for (fixture,variant),values in sorted(groups.items()):
        assert len(values)==3 and {v['repetition'] for v in values}=={0,1,2}
        row={'fixture':fixture,'variant':variant,'configuration':values[0]['info'],
            'setupIncludingAdapterConversionMs':distribution([v['startupMs'] for v in values])}
        for phase in ['motion','fixed']:
            samples=[s for v in values for s in v['samples'] if s['phase']==phase]
            assert len(samples)==180
            result={field:distribution([s[field] for s in samples]) for field in ['submissionMs','completionMs']}
            gpu=[]
            for value in values:
                if value['gpuTime']['available']:
                    sums={}
                    for sample in value['gpuTime']['samples']:
                        if sample['phase']==phase:
                            assert math.isfinite(sample['ms']) and sample['ms']>=0
                            sums[sample['index']]=sums.get(sample['index'],0)+sample['ms']
                    assert set(sums)==set(range(60)) and all(v>0 for v in sums.values())
                    gpu.extend(sums.values())
            result['wholePipelineGpuMs']=distribution(gpu) if gpu else None
            row[phase]=result
        worker=[w for v in values for w in v['worker']]
        row['workerAllPhases']={field:distribution([w[field] for w in worker if field in w]) for field in ['computeMs','roundTripMs'] if any(field in w for w in worker)}
        row['quality']=[image for image in images if image['fixture']==fixture and image['variant']==variant]
        rows.append(row)
    result={'schemaVersion':1,'kind':'renderer-comparison-summary','cases':84,'probes':7,
        'samplesPerFixtureVariantPhase':180,'framebuffer':[640,400],'shDegree':0,'series':rows,
        'scope':['GPU totals are sums of actual per-frame pass timestamps, followed by median/p95.',
                 'All GL completion samples use gl.finish; no browser fence-poll cadence comparison.',
                 'PlayCanvas GL may display the previous sort; worker-reported compute time and motion/settled images are separate.',
                 'SplatView GL awaits the current sort. These first-display completion clocks have different sort freshness.',
                 'Image agreement uses SplatView GPU 32-bit as a common reference, not perceptual ground truth.',
                 'Setup includes adapter format conversion and constructor/upload, with modules preloaded; not app cold-load performance.',
                 'No physical presentation FPS, driver-memory or universal ranking claim.']}
    (root/'summary.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace')
    args=parser.parse_args()
    result=summarize(args.workspace)
    print(f"Validated {result['cases']} cases, {result['probes']} probes, 180 moving + 180 fixed samples in each of 28 fixture/variant series")
