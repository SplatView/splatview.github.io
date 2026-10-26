import importlib.util
import math
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('input_report',Path(__file__).with_name('app-responsiveness-report.py'))
report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)


def observation():
    events=[{'id':i,'atMs':i*10,'beforeRevision':i-1,'trusted':True} for i in range(1,7)]
    frames=[{'attempt':i,'sequence':i,'inputId':i,'startedMs':i*10+2,'submittedMs':i*10+3,'completedMs':i*10+5,
             'revision':i,'revisionAtSubmission':i,'revisionAtCompletion':i,'precision':32,'pending':1,'width':640,'height':400} for i in range(1,7)]
    return {'inputs':events,'frames':frames,'warmup':1,'intendedInputs':5,'pattern':'isolated','errors':[],
            'isolated':[{'inputId':i,'attempt':i,'inputToCompletionMs':5} for i in range(2,7)],
            'framebuffer':{'width':640,'height':400,'dpr':1},'scene':{'count':262556,'degree':3,'sourceRevision':0},
            'environment':{'secureContext':True,'visibility':'visible'},'initialCamera':[0]*11,'raf':list(range(0,80,10)),'work':[]}


class InputReportContracts(unittest.TestCase):
    def test_decomposes_independent_known_clocks(self):
        result=report.summarize([observation()])
        self.assertEqual(result['inputToCompletion']['medianMs'],5)
        self.assertEqual(result['inputToDrawEntry']['medianMs'],2)
        self.assertEqual(result['cpuPreparation']['medianMs'],1)
        self.assertEqual(result['postSubmissionFenceWait']['medianMs'],2)
        self.assertEqual(result['capturedPoseAgeAtCompletion']['medianMs'],3)
        self.assertEqual(result['individuallyRepresentedInputs'],5)

    def test_rejects_submission_time_attribution_to_pre_input_pose(self):
        value=observation();value['frames'][1]['startedMs']=19
        with self.assertRaises(AssertionError):report.validate(value)

    def test_rejects_unchanged_pose_as_direct_response(self):
        value=observation();value['frames'][1]['revision']=1
        with self.assertRaises(AssertionError):report.validate(value)

    def test_coalesced_stream_inputs_share_next_changed_pose(self):
        value=observation();value['pattern']='stream';value['isolated']=[];value['frames']=value['frames'][-1:]
        chosen=report.validate(value)
        self.assertEqual(len(chosen),5)
        self.assertEqual({frame['attempt'] for _,frame in chosen},{6})

    def test_rejects_untrusted_duplicate_or_nonmonotonic_observation(self):
        for mutate in [lambda v:v['inputs'][2].update(trusted=False),
                       lambda v:v['frames'][2].update(sequence=2),
                       lambda v:v['frames'][2].update(completedMs=0),
                       lambda v:v['frames'][-1].update(precision=24),
                       lambda v:v['frames'][2].update(pending=3)]:
            value=observation();mutate(value)
            with self.assertRaises(AssertionError):report.validate(value)

    def test_nearest_rank_percentile_and_invalid_values(self):
        self.assertEqual(report.distribution(list(range(1,21)))['p95Ms'],19)
        for values in [[],[-1],[math.nan],[math.inf]]:
            with self.assertRaises(ValueError):report.distribution(values)


if __name__=='__main__':unittest.main()
