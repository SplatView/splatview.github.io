import base64
import csv
import gzip
import hashlib
import io
import json
import tarfile
from datetime import datetime,timezone
from pathlib import Path

phase=Path('.build/app-responsiveness-20261025-01')
out=Path('docs/validation/runs/app-responsiveness-20261025-01')
assert not (out/'validation.json').exists()
out.mkdir(parents=True,exist_ok=True)
def read(path):
    data=Path(path).read_bytes();return json.loads(data.decode('utf-16') if data.startswith(b'\xff\xfe') else data.decode('utf-8-sig'))
def record(path):
    p=Path(path);data=p.read_bytes();return {'path':p.as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def write(name,value):
    p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8');return record(p)
def copy(source,name):
    p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(Path(source).read_bytes());return record(p)
def zipped(source,name):
    p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(gzip.compress(Path(source).read_bytes(),compresslevel=6,mtime=0));return record(p)

summary=read(phase/'summary.json');run=read(phase/'measured-01.json');unit=read(phase/'unit.json');app=read(phase/'artifacts.json')
assert run['stats']['expected']==6 and run['stats']['unexpected']==run['stats']['skipped']==run['stats']['flaky']==0
assert unit['numPassedTests']==6470 and unit['numFailedTests']==0
assert len(summary['series'])==12 and sum(s['inputs'] for s in summary['series'])==6480
assert all(s['withoutObservedSubsequentChangedPose']==0 for s in summary['series'])
prior=read(phase/'prior-evidence.json')
for entry in prior:assert record(entry['path'])==entry
for entry in read(phase/'measured-source-02.json')['files']+app['applicationInputs']:assert record(entry['path'])==entry
previous=read('docs/validation/runs/webgl-sort-20261025-01/app-artifacts.json')
assert app['appInputId']==previous['appInputId'] and app['deploymentId']==previous['deploymentId']

copy(phase/'summary.json','summary.json');copy(phase/'environment.json','environment.json');copy(phase/'artifacts.json','app-artifacts.json')
copy('dist/build-manifest.json','build-manifest.json');copy('dist-engine/engine-manifest.json','engine-manifest.json')
copy(phase/'measured-source-01.json','calibration-source.json');copy(phase/'measured-source-02.json','measured-source.json')
calibration_spec=Path('e2e/app-responsiveness.spec.ts').read_bytes().replace(
    b"for(let repetition=0;repetition<3;repetition++) for(const backend of ['webgpu','webgl2'] as const)",
    b"for(const backend of ['webgpu','webgl2'] as const) for(let repetition=0;repetition<3;repetition++)").replace(
    b"      console.log('Measuring App input',backend,`repetition ${repetition+1}`,gesture,pattern);\n",b'')
original=next(f for f in read(phase/'measured-source-01.json')['files'] if f['path']=='e2e/app-responsiveness.spec.ts')
assert len(calibration_spec)==original['bytes'] and hashlib.sha256(calibration_spec).hexdigest()==original['sha256']
(out/'calibration-spec.ts.gz').write_bytes(gzip.compress(calibration_spec,mtime=0))
for name in ['measured-01.json','calibration-01.json','calibration-summary-01.json','unit.json']:
    zipped(phase/name,name+'.gz')
logs=[zipped(p,'logs/'+p.name+'.gz') for p in sorted(phase.glob('*.log'))]
tools=['e2e/app-input-probe.ts','e2e/app-responsiveness.spec.ts','tools/bench/app-responsiveness-report.py',
       'tools/bench/app-responsiveness-report.test.py','tools/bench/APP_RESPONSIVENESS.md']
with (out/'measurement-sources.tar.gz').open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w') as tar:
    for path in sorted(set(tools+[entry['path'] for entry in read(phase/'measured-source-02.json')['files']])):
        data=Path(path).read_bytes();info=tarfile.TarInfo(path);info.size=len(data);info.mode=0o644;info.mtime=0;tar.addfile(info,io.BytesIO(data))
copy(phase/'package-results.py','package-results.py')

table=['| Backend | Gesture | Input | Samples | Median / p95 (ms) | Worker median (ms) | Response fence median (ms) |',
       '| --- | --- | --- | ---: | ---: | ---: | ---: |']
with (out/'timings.csv').open('w',newline='',encoding='utf-8') as handle:
    writer=csv.writer(handle);writer.writerow(['backend','gesture','pattern','inputs','inputMedianMs','inputP95Ms','responseEntryMedianMs','responsePreparationMedianMs','responseFenceMedianMs','workerRoundTripMedianMs','deliveredInputIntervalMedianMs','submissionIntervalMedianMs'])
    for row in summary['series']:
        latency=row['inputToCompletion'];worker=row['workerSort']['roundTripMs']['medianMs'] if row['workerSort'] else None
        worker_text=f'{worker:.2f}' if worker is not None else '—'
        table.append(f"| {row['backend']} | {row['gesture']} | {row['pattern']} | {row['inputs']} | {latency['medianMs']:.2f} / {latency['p95Ms']:.2f} | {worker_text} | {row['responseFenceWait']['medianMs']:.2f} |")
        writer.writerow([row['backend'],row['gesture'],row['pattern'],row['inputs'],latency['medianMs'],latency['p95Ms'],row['inputToDrawEntry']['medianMs'],row['responseCpuPreparation']['medianMs'],row['responseFenceWait']['medianMs'],worker,row['inputDeliveryInterval']['medianMs'],row['submissionInterval']['medianMs']])
text='''# Actual App camera responsiveness

The current App completed the three-repetition orbit/pan/zoom benchmark on both
backends. **6,480 measured trusted inputs**, plus 288 warm-up inputs, passed the
pose/submission/fence checks. Every phase refined to exact 32-bit rendering and
App idle. This slice adds measurement only; renderer/controller/scheduler,
precision, freshness, native/WASM and product registrations are unchanged.

**WebGPU input-to-fence medians: 4.2–4.4 ms; WebGL: 36.65–38.05 ms.**
The current WebGL worker takes about 5.0–5.6 ms per sort round trip. Its response
fence wait is about 30.4–31.65 ms after submission, the larger observed component.

Decision: retain current display freshness. The next investigation is WebGL
completion behavior in a normal interactive browser and representative weaker
hardware. These observations do not justify changing the asynchronous-ordering
default on this workload. This is prioritization from measured components, not
proof of a driver/compositor/timer cause. Larger scenes can change the balance.
Faster fence polling was previously tried and rejected; it is not shipped here.

'''+ '\n'.join(table)+'''

[Interactive timing viewer](comparison.html) · [CSV](timings.csv) ·
[Full summary](summary.json) · [Validation receipt](validation.json)

## Method and limits

Six browser cases contain 36 phases, aggregated into 12 series with three
independent repetitions each. Backends alternate by repetition. The real React
App opens the bundled Bench example: 262,556 Gaussians, SH3, viewport/framebuffer
1280 × 800, DPR 1. Every phase resets to the same captured camera baseline,
warms up eight inputs, then measures 120 isolated or 240 stream inputs. Orbit
uses middle-drag, pan right-drag, zoom the wheel. Inputs are trusted browser
events and ordinary native camera handling; the fixture never renders manually.

The clock starts at document capture. The sampler captures an immutable pose at
CPU render entry and confirms actual submission sequence at render return. It
joins that exact display checkpoint's existing completion promise. Pre-input
poses cannot satisfy isolated latency. Streams can combine inputs into a later
changed pose; here every measured input had an individual observed pose at the
actual delivered rates. Pending displays stayed within the existing bound: two
on GL, one on GPU during measured active intervals. The production stale-query
observer is unchanged; camera advancement during display is expected.

Input-to-entry, response preparation and response fence wait describe selected
responses. Active-frame metrics separately include exact refinements/inertia
within the input window. Stage medians are independent and do not add to the
median of the complete path. Worker metrics include queue/transport/wakeup;
optional clocks and one rAF heartbeat are fixture-only. No competing test/build/
GPU workload ran during the accepted cohort. The calibration is separate.

Observed Windows build 10.0.26100, headless Chromium 156.0.8078.4, secure loopback,
cross-origin isolation false and the existing `--enable-unsafe-webgpu` launch
flag. A separate post-run same-launch observation identifies NVIDIA RTX 5090 /
ANGLE D3D11. The actual App runs in its Vite e2e development host; this is not
normal-launch, headed-browser, deployed-host or CSP qualification. See
[environment.json](environment.json).

The observed rAF cadence was about 31 ms. Despite an 8 ms requested pause,
sequential automation delivered pointer streams about every 31 ms and wheel
streams about every 62 ms. Submission intervals are approximately 31 ms during
streams. These are observed automation/submission clocks, not physical FPS or
physical dropped frames. Physical input hardware, presentation and driver memory
are unavailable. Higher-rate input/coalescing stress, other OS/browser/GPU,
real datasets beyond Bench, SH0–2 performance, larger scenes and normal browser
launches remain unqualified. There is no paired before/after latency improvement
claim and no external-engine parity claim.

## Validation and provenance

- Six accepted browser cases passed, with zero retries, skips, failures or flaky
  results. All 6,480 measured inputs have observed subsequent changed poses;
  every phase ends at exact rest and idle.
- The separate WebGL calibration passed; it is retained and excluded from the
  three-repetition summary.
- 6,470 portable tests and six independent analysis contracts passed. Analysis
  tests reject pre-input/unchanged poses, untrusted events, duplicate sequences,
  invalid clocks, excess pending work and missing exact rest; known-clock and
  coalescing examples verify aggregation.
- Both TypeScript projects, production build, 919-source/generated/native gates
  and 133 product registrations passed. All 111 app artifacts/four source maps
  and 63 standalone artifacts/isolated declaration consumer passed byte closure.
- The captured sampler and all 351 app inputs stayed unchanged through timing.
  App deployment/input and SDK source identities match the worker-sort packet.
  The earlier 437 browser checks are unchanged-source prior evidence, not a
  newly rerun total. No new native runtime/preview-host qualification is claimed.

The production build retains its existing large-chunk advisory and succeeds.
There were no failed browser or analysis cases in this slice. PowerShell stderr
formatting in a log does not override the recorded successful process result.

See the [feature review](../../../../design/feature-reviews/app-responsiveness-2026-10-25.md)
and [tool guide](../../../../tools/bench/APP_RESPONSIVENESS.md). Raw browser reports,
calibration, source manifest/archive, environment, app/SDK artifact manifests and
exact commands are linked by [validation.json](validation.json).
'''
(out/'README.md').write_text(text,encoding='utf-8')
html='''<!doctype html><meta charset="utf-8"><title>App camera responsiveness</title>
<style>body{max-width:1000px;margin:36px auto;padding:0 20px;font:16px system-ui;background:#111720;color:#e7eff8}select{padding:8px;margin:8px}a{color:#8fc8ff}.bar{height:20px;background:#64b9d1;margin:6px 0 18px}pre{white-space:pre-wrap}p{line-height:1.6}</style>
<h1>Actual App camera responsiveness</h1><p>Current policy. Bench SH3 · 262,556 sources · 1280 × 800 · three repetitions. DOM input to the existing display fence; physical presentation is unobserved.</p>
<label>Backend <select id="backend"><option>webgpu</option><option>webgl2</option></select></label><label>Gesture <select id="gesture"><option>orbit</option><option>pan</option><option>zoom</option></select></label><label>Input <select id="pattern"><option>isolated</option><option>stream</option></select></label>
<h2 id="latency"></h2><p id="entryLabel"></p><div class="bar" id="entry"></div><p id="prepLabel"></p><div class="bar" id="prep"></div><p id="fenceLabel"></p><div class="bar" id="fence"></div>
<p>Stage medians are separate summaries. All filters share a 0–41 ms scale; bars are not stacked.</p><pre id="detail"></pre><p>Automation delivered pointer streams around 31 ms and wheel streams around 62 ms. Higher-rate input is unqualified. No physical FPS, dropped-frame or before/after improvement claim.</p><a href="README.md">Method, decision and checks</a>
<script>const data=DATA,q=id=>document.getElementById(id);
function update(){const r=data.series.find(r=>r.backend===q('backend').value&&r.gesture===q('gesture').value&&r.pattern===q('pattern').value),total=r.inputToCompletion.medianMs;
q('latency').textContent=`Input → fence: ${total.toFixed(2)} ms median / ${r.inputToCompletion.p95Ms.toFixed(2)} ms p95`;
for(const [id,name,field] of [['entry','Input → draw entry','inputToDrawEntry'],['prep','CPU preparation','responseCpuPreparation'],['fence','After submission → fence','responseFenceWait']]){const ms=r[field].medianMs;q(id+'Label').textContent=`${name}: ${ms.toFixed(2)} ms`;q(id).style.width=Math.min(100,ms/41*100)+'%';}
q('detail').textContent=`Measured inputs: ${r.inputs}\nIndividually observed poses: ${r.individuallyRepresentedInputs}\nDelivered input interval median: ${r.inputDeliveryInterval.medianMs.toFixed(2)} ms\nSubmission interval median: ${r.submissionInterval.medianMs.toFixed(2)} ms\nrAF interval median: ${r.rafInterval.medianMs.toFixed(2)} ms\nMaximum pending displays: ${r.maxPendingDisplays}\nWorker sort round trip median: ${r.workerSort?r.workerSort.roundTripMs.medianMs.toFixed(2)+' ms':'not a CPU worker path'}`;}
for(const id of ['backend','gesture','pattern'])q(id).onchange=update;update();</script>'''.replace('DATA',json.dumps(summary,separators=(',',':')))
(out/'comparison.html').write_text(html,encoding='utf-8')

paths={entry['path'] for entry in app['applicationInputs']}
paths.update(tools+[entry['path'] for entry in read(phase/'measured-source-02.json')['files']])
paths.update(['AGENTS.md','README.md','design/feature-reviews/app-responsiveness-2026-10-25.md','playwright.config.ts','contracts/product-adapter.json'])
inventory=write('source-files.json',{'files':[record(path) for path in sorted(paths)]})
checks=[
 {'command':'npx playwright test --project=spec:app-responsiveness.spec.ts --reporter=json','exitCode':0,'tests':6,'phases':36,'measuredInputs':6480,'warmupInputs':288},
 {'command':"npx playwright test --project=spec:app-responsiveness.spec.ts --grep 'webgl2 actual App.*repetition 1' --reporter=json",'exitCode':0,'tests':1,'scope':'Calibration only.'},
 {'command':'python -B tools/bench/app-responsiveness-report.py .build/app-responsiveness-20261025-01/measured-01.json --out=.build/app-responsiveness-20261025-01/summary.json','exitCode':0,'series':12},
 {'command':'python -B tools/bench/app-responsiveness-report.test.py','exitCode':0,'tests':6},
 {'command':'npm test -- --maxWorkers=4 --reporter=json --outputFile=.build/app-responsiveness-20261025-01/unit.json','exitCode':0,'tests':6470},
 {'command':'npm run build','exitCode':0,'includes':['verify:sources','verify:build','prepare:web','typecheck','typecheck:bench','vite build']},
 {'command':'npm run typecheck','exitCode':0,'scope':'Repeated after balanced case ordering/progress logging.'},
 {'command':'python -B contracts/product/tool.py verify --root .','exitCode':0,'registrations':133,'nativeQualification':False},
 {'command':'node tools/check-engine.mjs','exitCode':0,'artifacts':63,'scope':'Unchanged SDK byte closure and isolated TypeScript consumer.'},
 {'command':'node .build/app-responsiveness-20261025-01/verify-artifacts.mjs','exitCode':0,'artifacts':111,'sourceMaps':4,'applicationInputs':351},
]
receipt={'schemaVersion':1,'kind':'app-responsiveness-measurement','status':'measured-and-locally-qualified','recordedAtUtc':datetime.now(timezone.utc).isoformat(),
 'featureId':'view.render','review':record('design/feature-reviews/app-responsiveness-2026-10-25.md'),'priorEvidenceUnchanged':prior,
 'sourceInventory':inventory,'measuredSource':record(out/'measured-source.json'),'sourceArchive':record(out/'measurement-sources.tar.gz'),
 'summary':record(out/'summary.json'),'rawCohort':record(out/'measured-01.json.gz'),'calibration':record(out/'calibration-01.json.gz'),
 'environment':record(out/'environment.json'),'appArtifacts':record(out/'app-artifacts.json'),'sdkManifest':record(out/'engine-manifest.json'),
 'portableReport':record(out/'unit.json.gz'),'checks':checks,'logs':logs,'humanReport':record(out/'README.md'),'interactiveComparison':record(out/'comparison.html'),
 'csv':record(out/'timings.csv'),'processors':[record('tools/bench/app-responsiveness-report.py'),record(out/'package-results.py')],
 'decision':{'asynchronousDisplayOrderingShipped':False,'renderingPolicyChanged':False,'nextTarget':'Qualify WebGL post-submission completion on normal/interactive browser and representative weaker hardware.',
             'reason':'About 30–32 ms post-submission wait is larger than about 5 ms worker sorting in this scene; the underlying cause and potential async gain are unproven.'},
 'scope':summary['scope']+['Headless Chromium/Windows/NVIDIA/loopback; no normal-launch/deployed/native/other-platform qualification.','Prior renderer browser cohorts are linked unchanged-source evidence, not newly rerun totals.']}
(phase/'receipt-draft.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print('Packaged 12 series, 6480 measured inputs,',len(paths),'source records; app source/deployment identity unchanged')
