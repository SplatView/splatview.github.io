import gzip
import hashlib
import io
import json
import tarfile
from datetime import datetime, timezone
from pathlib import Path

phase=Path('.build/webgl-sort-20261025-01')
workspace=Path('.build/renderer-comparison-20261025-01')
out=Path('docs/validation/runs/webgl-sort-20261025-01')
assert not (out/'validation.json').exists(), 'Existing final receipt must remain immutable.'
out.mkdir(parents=True,exist_ok=True)

def read(path):
    data=Path(path).read_bytes()
    return json.loads(data.decode('utf-16') if data.startswith(b'\xff\xfe') else data.decode('utf-8-sig'))

def digest(data):return hashlib.sha256(data).hexdigest()
def record(path):
    p=Path(path);data=p.read_bytes()
    return {'path':p.as_posix(),'bytes':len(data),'sha256':digest(data)}
def write(name,value):
    p=out/name;p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8');return record(p)
def copy(source,name):
    target=out/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(Path(source).read_bytes());return record(target)
def zipped(source,name):
    target=out/name;target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(gzip.compress(Path(source).read_bytes(),compresslevel=6,mtime=0));return record(target)
def archive(name,files):
    with (out/name).open('wb') as raw, gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed, tarfile.open(fileobj=compressed,mode='w') as tar:
        for path,data in sorted(files):
            info=tarfile.TarInfo(path);info.size=len(data);info.mode=0o644;info.mtime=0
            tar.addfile(info,io.BytesIO(data))
    return record(out/name)

performance=read(phase/'performance.json')
assert performance['identicalSnapshotPairs']==48
assert performance['engineSourceIds']==['4cefb913f6306a516bf21b4d1dbf85eb771197faae887923bd32baf85692fe4a','898a19650c3808b3c132739b87c06f2c4b80ffa4903d7e11d68b15739667fbc8']
prior=read(phase/'prior-evidence.json')
for entry in prior:assert record(entry['path'])==entry
unit=read(phase/'unit.json');assert unit['numPassedTests']==6470 and unit['numFailedTests']==0
selection=read(phase/'selection-unit.json');assert selection['numPassedTests']==165 and selection['numFailedTests']==0
status=read(phase/'browser-run-status.json');assert len(status)==6 and all(c['exitCode']==0 for c in status)
cohorts=[]
for name,expected in [('renderer-regression',103),('selection-browser',126),('outputs-webgl2',54),('outputs-webgpu',60),('production-webgl2',40),('production-webgpu',40),('engine-browser',14)]:
    report=read(phase/(name+'.json'));stats=report['stats']
    assert stats['expected']==expected and stats['unexpected']==stats['flaky']==stats['skipped']==0,(name,stats)
    cohorts.append({'name':name,'stats':stats,'report':zipped(phase/(name+'.json'),name+'.json.gz')})

images=[]
for image in performance['images']:
    old=workspace/image['before'];new=workspace/image['after'];a=old.read_bytes();b=new.read_bytes()
    assert a==b and digest(a)==image['sha256']
    path='images/'+old.name
    rec=copy(old,path)
    images.append({**image,'sharedPng':path,'artifact':rec})
write('images.json',images)
copy(phase/'performance.json','performance.json')
copy(phase/'environment.json','environment.json')
copy(phase/'artifacts.json','app-artifacts.json')
copy(phase/'baseline-source.json','baseline-source.json')
source_scripts=[]
for path in sorted((phase/'baseline-source').rglob('*')):
    if path.is_file():source_scripts.append((path.relative_to(phase/'baseline-source').as_posix(),path.read_bytes()))
archive('baseline-selected-sources.tar.gz',source_scripts)
raw=[]
for label in performance['labels']:
    run=read(workspace/(label+'.json'));raw.append(zipped(workspace/(label+'.json'),'raw/'+label+'.json.gz'))
    for case in run['cases']+run['probes']:
        raw.append(zipped(workspace/case['path'],'raw/'+label+'/'+case['id']+'.json.gz'))
engines=[];source_sets=[]
for kind in ['baseline','candidate']:
    home=phase/(kind+'-engine');manifest=read(home/'engine-manifest.json')
    files=[]
    for entry in manifest['artifacts']:
        data=(home/entry['path']).read_bytes();assert len(data)==entry['bytes'] and digest(data)==entry['sha256']
        files.append((entry['path'],data))
    files.append(('engine-manifest.json',(home/'engine-manifest.json').read_bytes()))
    engines.append({'kind':kind,'sourceId':manifest['sourceId'],'manifest':copy(home/'engine-manifest.json',kind+'-engine-manifest.json'),
                    'frozenDistribution':archive(kind+'-engine.tar.gz',files)})
    files=[]
    for entry in manifest['sources']:
        backup=phase/'baseline-source'/entry['path']
        source=backup if kind=='baseline' and backup.exists() else Path(entry['path'])
        data=source.read_bytes();assert len(data)==entry['bytes'] and digest(data)==entry['sha256'],source
        files.append((entry['path'],data))
    source_sets.append({'kind':kind,'files':len(files),'archive':archive(kind+'-sdk-sources.tar.gz',files)})

logs=[]
for path in sorted(phase.glob('*.log')):logs.append(zipped(path,'logs/'+path.name+'.gz'))
for name in ['unit.json','selection-unit.json','focused-01.json','focused-02.json']:
    zipped(phase/name,name+'.gz')
copy(phase/'run-browser-checks.mjs','run-browser-checks.mjs')
copy(phase/'production.config.ts','production.config.ts')
copy(phase/'inspect-environment.mjs','inspect-environment.mjs')
copy(phase/'verify-artifacts.mjs','verify-artifacts.mjs')
copy(phase/'browser-run-status.json','browser-run-status.json')
copy(phase/'package-results.py','package-results.py')
copy('tools/bench/comparison/compare-sorts.py','compare-sorts.py')
archive('comparison-tool-sources.tar.gz',[(path.as_posix(),path.read_bytes()) for path in Path('tools/bench/comparison').glob('*') if path.is_file()])

table=['| Scene | Bits | Before median / p95 (ms) | After median / p95 (ms) | Median reduction |',
       '| --- | ---: | ---: | ---: | ---: |']
for row in performance['series']:
    a=row['before']['workerRoundTrip'];b=row['after']['workerRoundTrip']
    table.append(f"| {row['fixture']} | {row['variant'].rsplit('-',1)[1]} | {a['medianMs']:.2f} / {a['p95Ms']:.2f} | {b['medianMs']:.2f} / {b['p95Ms']:.2f} | {row['workerMedianReductionPercent']:.1f}% |")
report='''# Exact WebGL worker sorting

The shared app/standalone sorter now uses bounded synchronous key/count/scatter
kernels, skips uniform key digits, and uses stable counting when the requested
key span fits admitted histogram storage. Wider spans retain stable radix.
Float32 operation order, source/candidate ties, display precision and freshness
are unchanged. No extra quality reduction was needed.

Matched old/new builds measured **43–75% lower current-sort worker round-trip
medians** across the tested scenes. All **48 snapshot pairs are byte-identical**.
The before/after source and complete SDK distributions are archived below.

'''+ '\n'.join(table)+'''

Each row contains 186 observed sort round trips, including queue, transport and
wakeup. The frame cohort separately contains 180 moving and 180 fixed samples
per scene/precision/build. Raw completion uses `gl.finish` on both builds;
this is not physical FPS or the app's fence-polling cadence. Existing app GL
polling can still limit input/display completion even after sorting improves.

## Method and environment

Two identical 24-case cohorts: four deterministic SH0 scenes, 24/32-bit sorting,
three repetitions, 12 warm-up then 60 moving/60 fixed frames per case. The
framebuffer is 640 × 400. Sparse scenes have 25% nominal visible sources; dense
scenes have 100%. The sampler, common cameras, image poses, completion fences
and frozen external references are unchanged. The filtered configuration order
rotates across repetitions. The full seven-configuration runner keeps its
original rotation. No competing test/build workload ran during timing.

Observed Windows build 10.0.26100, Chromium 156.0.8078.4,
NVIDIA RTX 5090 through ANGLE Direct3D11. Loopback is secure, cross-origin
isolation is false. Chromium used `--enable-unsafe-webgpu`; the internal static
benchmark host sets no CSP. The standalone browser cohort additionally tests
its nested path and `script-src`/`worker-src 'self'` hosting. See
[environment.json](environment.json), [performance.json](performance.json) and
[the image/timing viewer](comparison.html).

## Memory, exact results and ownership

Large retained display pools add 65,536 uint32 histogram bins: 12 × count +
262,144 bytes, within the existing 16 MiB optional cap. Smaller pools retain
256 bins: 12 × count + 1,024 bytes. The host and worker share one byte planner.
At one million sources the pool occupies 12,262,144 bytes. The largest admitted
pool is now 1,376,256 sources; larger/refused pools fall back to the original-size
transient allocation, without reducing the supported scene count. Queries always
retain their original 256-bin scratch and admission formulas.

Key work yields after at most 8,192 sources; histogram/scatter/remapping chunks
contain at most 65,536 entries. A large prefix also yields. These are work bounds,
not wall-clock guarantees. One existing serial executor owns cancellation and
publication acknowledgement; the renderer retains fences and retirement.
Pool-owned returned arrays are copied before transfer. No stale/asynchronous
display order or replacement controller/history owner was introduced.

The independent comparison-sort oracle covers 16/24/32-bit keys, signed zero,
subnormals/boundary depths, scoped projective transforms, source/candidate ties,
narrow/wide spans and both histogram sizes. Cancellation covers key generation,
counting/prefix/scatter/remapping, wide radix, and subsequent pool reuse.
Optional refusal/cap and acknowledged retirement retain their existing tests.

## Checks

- 6,470 portable tests and the focused 165 selection tests passed.
- 437 browser checks passed with zero retries, skips, unexpected failures or
  flaky results: renderer 103, selection 126, WebGL output 54, WebGPU output 60,
  production 40 per backend, standalone SDK 14.
- Both TypeScript projects, production build, frozen-source/generated/native
  provenance, 133 product registration bindings, 40 web-build tests and six
  benchmark contract tests passed.
- Every app artifact/source-map and all 63 standalone artifacts passed byte/hash
  closure checks; an isolated TypeScript consumer passed. Actual app fallback,
  all SH degrees, exact pick/map/capture, staged masks, lifecycle and clean output
  remain in the browser cohorts.

The initial focused run had one incorrect diagnostic pass-name expectation;
the independent permutation oracles passed. Correcting that assertion produced
a green focused run, followed by the complete green suite. Both reports are
retained. No measured implementation candidate was discarded. The production
build emitted its existing large-chunk advisory; it exited successfully.

## Reproduction and provenance

Use the locked Node/toolchain and the frozen comparison workspace described in
[the benchmark guide](../../../../tools/bench/comparison/README.md). The runner's
new `--variants=splatview-webgl2-32,splatview-webgl2-24` filter preserves per-case
sampling; retain both labeled JSON runs, since `results.json` is a checkpoint.

```powershell
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --variants=splatview-webgl2-32,splatview-webgl2-24 --label=gl-sort-baseline-01
# Install the frozen candidate SDK as dist-engine before the second run.
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --variants=splatview-webgl2-32,splatview-webgl2-24 --label=gl-sort-candidate-01
python -B tools/bench/comparison/compare-sorts.py .build/renderer-comparison-20261025-01 gl-sort-baseline-01 gl-sort-candidate-01 --output=.build/webgl-sort-20261025-01/performance.json
```

The frozen SDK archives include complete notices, workers, declarations and
maps; source archives reconstruct each source digest. They are evidence, not
application build inputs. The existing reference comparison's receipts,
upstream bundles and pinned reviews remain unchanged. This optimization uses
no new external renderer code or runtime dependency.

See [the feature review](../../../../design/feature-reviews/webgl-worker-sort-2026-10-25.md)
and [validation.json](validation.json) for hashes, commands, raw cohorts and
failures. The existing motion-24/rest-32 and standalone-default-32 policies and
registration pins remain unchanged. No external-engine parity, native/preview
host, other OS/browser/GPU, real dataset, SH1–3 performance, physical memory,
normal-launch/deployed hosting or physical presentation qualification is claimed.
'''
(out/'README.md').write_text(report,encoding='utf-8')

gallery={'series':performance['series'],'images':[{**image,'path':image['sharedPng']} for image in images]}
html='''<!doctype html><meta charset="utf-8"><title>Exact WebGL sort comparison</title>
<style>body{max-width:1080px;margin:32px auto;padding:0 20px;font:16px system-ui;background:#10141c;color:#e6edf6}select{margin:8px;padding:8px}img{width:min(100%,800px);height:auto;background:black}a{color:#8fcaff}.bar{height:22px;margin:8px 0;background:#6b93d7}.new{background:#63c7ab}label{display:inline-block}pre{white-space:pre-wrap}</style>
<h1>Exact WebGL worker sorting</h1><p>Same scene, camera and precision. All 48 before/after PNG pairs are byte-identical; each shared image below represents both validated builds.</p>
<label>Scene <select id="scene"></select></label><label>Bits <select id="bits"><option>32</option><option>24</option></select></label><label>Phase <select id="phase"><option value="motion-image">Moving</option><option value="fixed-image">Settled</option></select></label><label>Pose <select id="pose"><option>0</option><option>1</option><option>2</option></select></label>
<p id="metric"></p><div class="bar" id="old"></div><div class="bar new" id="new"></div><p>Worker round trip includes queue and transport. Bars share a scale. No physical FPS claim.</p><img id="image" alt="Identical before and after rendering"><pre id="sha"></pre><a href="README.md">Method, tests and limitations</a>
<script>const data=DATA;
for(const name of [...new Set(data.series.map(r=>r.fixture))])scene.add(new Option(name,name));
function update(){const variant='splatview-webgl2-'+bits.value,r=data.series.find(r=>r.fixture===scene.value&&r.variant===variant),p=data.images.find(i=>i.fixture===scene.value&&i.variant===variant&&i.phase===phase.value&&i.index===+pose.value),a=r.before.workerRoundTrip.medianMs,b=r.after.workerRoundTrip.medianMs;metric.textContent=`Worker median: ${a.toFixed(2)} → ${b.toFixed(2)} ms (${r.workerMedianReductionPercent.toFixed(1)}% lower)`;document.getElementById('old').style.width='80%';document.getElementById('new').style.width=(80*b/a)+'%';image.src=p.path;sha.textContent='Both PNGs: SHA-256 '+p.sha256;}
for(const id of ['scene','bits','phase','pose'])document.getElementById(id).onchange=update;update();</script>'''.replace('DATA',json.dumps(gallery,separators=(',',':')))
(out/'comparison.html').write_text(html,encoding='utf-8')

paths=set(entry['path'] for entry in read('dist-engine/engine-manifest.json')['sources'])
paths.update(entry['path'] for entry in read(phase/'artifacts.json')['applicationInputs'])
paths.update(str(p).replace('\\','/') for p in Path('tools/bench/comparison').glob('*') if p.is_file())
paths.update(['AGENTS.md','README.md','WEB_PORT_PLAN.md','IMPLEMENTATION_STATUS.md','docs/development/renderer-engine.md',
              'docs/development/selection.md','design/feature-reviews/webgl-worker-sort-2026-10-25.md',
              'tests/webgl-worker-sort.test.ts','tests/render-sort-scratch.test.ts','tests/fast-order-layout.test.ts','tests/webgl-query-core.test.ts',
              'playwright.config.ts','playwright.engine.config.ts','playwright.selection.config.ts','contracts/product-adapter.json'])
inventory=write('source-files.json',{'files':[record(path) for path in sorted(paths)]})
review=record('design/feature-reviews/webgl-worker-sort-2026-10-25.md')
checks=[{'command':c['command'],'backend':c['backend'],'exitCode':c['exitCode']} for c in status]
checks.extend([
 {'command':'npm test -- --maxWorkers=4 --reporter=json --outputFile=.build/webgl-sort-20261025-01/unit.json','exitCode':0,'tests':6470},
 {'command':'npm run test:selection -- --maxWorkers=4 --reporter=json --outputFile=.build/webgl-sort-20261025-01/selection-unit.json','exitCode':0,'tests':165},
 {'command':'npx playwright test --config playwright.engine.config.ts --reporter=json','exitCode':0,'tests':14},
 {'command':'npm run build:engine','exitCode':0,'artifacts':63},
 {'command':'npm run build','exitCode':0,'includes':['verify:sources','verify:build','prepare:web','typecheck','typecheck:bench','vite build']},
 {'command':'python -B contracts/product/tool.py verify --root .','exitCode':0,'registrations':133,'nativeQualification':False},
 {'command':'npm run test:web-build','exitCode':0,'tests':40},
 {'command':'node --test tools/bench/comparison/fixtures.test.mjs tools/bench/comparison/build.test.mjs','exitCode':0,'tests':6},
 {'command':'node tools/check-engine.mjs','exitCode':0,'artifacts':63},
 {'command':'node .build/webgl-sort-20261025-01/verify-artifacts.mjs','exitCode':0,'artifacts':111,'sourceMaps':4},
 {'command':'python -B tools/bench/comparison/compare-sorts.py .build/renderer-comparison-20261025-01 gl-sort-baseline-01 gl-sort-candidate-01 --output=.build/webgl-sort-20261025-01/performance.json','exitCode':0,'cases':48,'probes':4,'identicalSnapshotPairs':48},
 {'command':'git -c core.whitespace=cr-at-eol diff --check','exitCode':0},
])
receipt={'schemaVersion':1,'kind':'webgl-worker-sort-delivery','status':'implemented-and-locally-qualified',
         'recordedAtUtc':datetime.now(timezone.utc).isoformat(),'featureId':'view.render','review':review,
         'priorEvidenceUnchanged':prior,'sourceInventory':inventory,'engineBuilds':engines,'sourceArchives':source_sets,
         'performance':record(out/'performance.json'),'environment':record(out/'environment.json'),'raw':raw,
         'imageIndex':record(out/'images.json'),'browserCohorts':cohorts,'checks':checks,'logs':logs,
         'portableReport':record(out/'unit.json.gz'),'appArtifacts':record(out/'app-artifacts.json'),
         'humanReport':record(out/'README.md'),'interactiveComparison':record(out/'comparison.html'),
         'processors':[record('tools/bench/comparison/compare-sorts.py'),record(out/'package-results.py')],
         'diagnostics':[{'report':record(out/'focused-01.json.gz'),'passed':35,'failed':1,'reason':'Incorrect expected uniform-digit diagnostic names; independent permutation checks passed.'},
                        {'report':record(out/'focused-02.json.gz'),'passed':36,'failed':0},
                        {'reason':'Existing production large-chunk advisory; successful build exit 0.'}],
         'policy':{'newRegistrations':0,'changedPrecisionOrFreshnessDefaults':False,'retainedScratchCapBytes':16*1024**2,'nativeQualification':False,'profileMigrationCompleted':False},
         'scope':['Windows Chromium/NVIDIA/loopback with documented launch flags; other OS/browser/GPU/preview hosts unqualified.',
                  'Synthetic SH0 performance; SH0–3 functional browser checks are separate.',
                  'Current-sort round trip and gl.finish completion, not app presentation or physical FPS.']}
(phase/'receipt-draft.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print('Packaged',len(cohorts),'browser cohorts,',len(raw),'raw records,',len(images),'identical image pairs and',len(paths),'source digests')
