"""Aggregate trusted App input through captured pose, submission and real fence."""
import argparse
import base64
import json
import math
from pathlib import Path
from statistics import median


def distribution(values):
    values=sorted(values)
    if not values or any(not math.isfinite(x) or x<0 for x in values):
        raise ValueError('Missing/non-finite/negative timing samples')
    return {'count':len(values),'medianMs':median(values),'p95Ms':values[math.ceil(len(values)*.95)-1]}


def attachments(value):
    if isinstance(value,dict):
        for item in value.get('attachments',[]):
            if item['name'].startswith('app-responsiveness-') and item['name'].endswith('.json'):
                yield json.loads(base64.b64decode(item['body'])) if 'body' in item else json.loads(Path(item['path']).read_text(encoding='utf-8'))
        for child in value.values():yield from attachments(child)
    elif isinstance(value,list):
        for child in value:yield from attachments(child)


def validate(value):
    inputs=value['inputs'];frames=value['frames'];warm=value['warmup'];expected=value['intendedInputs']
    assert not value['errors'] and len(inputs)==warm+expected
    assert [x['id'] for x in inputs]==list(range(1,len(inputs)+1)) and all(x['trusted'] for x in inputs)
    assert all(a['atMs']<=b['atMs'] for a,b in zip(inputs,inputs[1:]))
    assert len(set(f['sequence'] for f in frames))==len(frames)
    assert len(set(f['attempt'] for f in frames))==len(frames)
    assert frames and frames[-1]['precision']==32
    assert all(f['startedMs']<=f['submittedMs']<=f['completedMs'] and 0<f['pending']<=2 for f in frames)
    assert all(f['width']==value['framebuffer']['width'] and f['height']==value['framebuffer']['height'] for f in frames)
    assert value['scene']['count']==262556 and value['scene']['degree']==3
    assert value['environment']['secureContext'] and value['environment']['visibility']=='visible'
    chosen=[]
    for event in inputs[warm:]:
        eligible=[f for f in frames if f['inputId']>=event['id'] and f['startedMs']>=event['atMs'] and f['revision']>event['beforeRevision']]
        if eligible:chosen.append((event,min(eligible,key=lambda f:f['submittedMs'])))
    if value['pattern']=='isolated':
        assert len(value['isolated'])==expected and len(chosen)==expected
        for sample,(event,frame) in zip(value['isolated'],chosen):
            assert frame['inputId']==event['id']==sample['inputId'] and frame['attempt']==sample['attempt']
            assert abs(sample['inputToCompletionMs']-(frame['completedMs']-event['atMs']))<1e-6
    else:assert not value['isolated']
    return chosen


def summarize(values):
    pairs=[]
    active=[];event_intervals=[];frame_intervals=[];raf_intervals=[];work=[];individually=0;uncovered=0
    for value in values:
        matched=validate(value)
        pairs.extend(matched)
        events=value['inputs'][value['warmup']:];start=events[0]['atMs'];stop=events[-1]['atMs']
        moving=[f for f in value['frames'] if start<=f['startedMs']<=stop]
        assert len(moving)>2
        active.extend(moving)
        event_intervals.extend(b['atMs']-a['atMs'] for a,b in zip(events,events[1:]))
        frame_intervals.extend(b['submittedMs']-a['submittedMs'] for a,b in zip(moving,moving[1:]))
        raf=[t for t in value['raf'] if start<=t<=stop]
        raf_intervals.extend(b-a for a,b in zip(raf,raf[1:]))
        attempts={f['attempt'] for f in moving};work.extend(w for w in value['work'] if w['attempt'] in attempts)
        represented={f['inputId'] for f in value['frames'] if f['inputId']>value['warmup'] and
                     f['startedMs']>=value['inputs'][f['inputId']-1]['atMs'] and f['revision']>value['inputs'][f['inputId']-1]['beforeRevision']}
        individually+=len(represented);uncovered+=len(events)-len(matched)
    result={'repetitions':len(values),'inputs':sum(v['intendedInputs'] for v in values),'coveredByNextChangedPose':len(pairs),
        'withoutObservedSubsequentChangedPose':uncovered,'individuallyRepresentedInputs':individually,
        'inputsWithoutIndividualPose':sum(v['intendedInputs'] for v in values)-individually,
        'inputToCompletion':distribution([f['completedMs']-e['atMs'] for e,f in pairs]),
        'inputToDrawEntry':distribution([f['startedMs']-e['atMs'] for e,f in pairs]),
        'responseCpuPreparation':distribution([f['submittedMs']-f['startedMs'] for _,f in pairs]),
        'responseFenceWait':distribution([f['completedMs']-f['submittedMs'] for _,f in pairs]),
        'inputDeliveryInterval':distribution(event_intervals),'submissionInterval':distribution(frame_intervals),
        'rafInterval':distribution(raf_intervals),'cpuPreparation':distribution([f['submittedMs']-f['startedMs'] for f in active]),
        'postSubmissionFenceWait':distribution([f['completedMs']-f['submittedMs'] for f in active]),
        'capturedPoseAgeAtCompletion':distribution([f['completedMs']-f['startedMs'] for f in active]),
        'activeFrames':len(active),'maxPendingDisplays':max(f['pending'] for f in active),
        'activePrecisionCounts':{str(bits):sum(f['precision']==bits for f in active) for bits in (16,24,32)},
        'framesWithCameraAdvanceBeforeSubmit':sum(f['revisionAtSubmission']>f['revision'] for f in active),
        'framesWithCameraAdvanceBeforeFence':sum(f['revisionAtCompletion']>f['revision'] for f in active),
        'sortJobs':len(work),'workerSort':{field:distribution([w[field] for w in work]) for field in
            ('roundTripMs','queueMs','computeMs','transportAndWakeupMs')} if work else None,
        'workerRoundTripShareOfPreparation':sum(w['roundTripMs'] for w in work)/sum(f['submittedMs']-f['startedMs'] for f in active) if work else None,
        'scene':values[0]['scene'],'framebuffer':values[0]['framebuffer'],'initialCamera':values[0]['initialCamera'],
        'environment':values[0]['environment']}
    for value in values:
        assert value['scene']==result['scene'] and value['framebuffer']==result['framebuffer'] and value['initialCamera']==result['initialCamera']
    return result


def report(path,calibration=False):
    raw=Path(path).read_bytes();run=json.loads(raw.decode('utf-16') if raw.startswith(b'\xff\xfe') else raw.decode('utf-8-sig'))
    assert run['stats']['unexpected']==run['stats']['flaky']==run['stats']['skipped']==0
    groups={};observations=list(attachments(run))
    for value in observations:
        key=(value['backend'],value['gesture'],value['pattern']);groups.setdefault(key,[]).append(value)
    expected={(b,g,p) for b in (('webgl2',) if calibration else ('webgpu','webgl2')) for g in ('orbit','pan','zoom') for p in ('isolated','stream')}
    assert groups.keys()==expected and len(observations)==(6 if calibration else 36)
    series=[]
    for key,values in sorted(groups.items()):
        assert {v['repetition'] for v in values}==({0} if calibration else {0,1,2})
        series.append({'backend':key[0],'gesture':key[1],'pattern':key[2],**summarize(values)})
    return {'schemaVersion':1,'kind':'app-responsiveness','calibration':calibration,'browserStats':run['stats'],'series':series,
        'scope':['Trusted Playwright input through actual App/native camera and sorted display; bundled Bench SH3, fixed viewport/DPR.',
                 'Clock starts at DOM capture, not physical device input. Fence completion does not observe presentation.',
                 'Stream coverage uses the next changed pose after an input, which can combine multiple inputs. Isolated inputs have direct pose attribution.',
                 'Observed rAF/submission gaps and coalesced input counts do not measure physical dropped frames.',
                 'Worker timing diagnostics and one rAF observer are enabled only in the fixture.']}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report');parser.add_argument('--out',required=True)
    parser.add_argument('--calibration',action='store_true');args=parser.parse_args()
    result=report(args.report,args.calibration);Path(args.out).write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    for row in result['series']:
        print(row['backend'],row['gesture'],row['pattern'],'input median/p95',round(row['inputToCompletion']['medianMs'],2),round(row['inputToCompletion']['p95Ms'],2),
              'prep',round(row['cpuPreparation']['medianMs'],2),'fence',round(row['postSubmissionFenceWait']['medianMs'],2),'rAF',round(row['rafInterval']['medianMs'],2))
