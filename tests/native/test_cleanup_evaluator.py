"""Offline evaluator contracts: tiny fixtures and disposable fake processes only."""

import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import cleanup_model  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "evaluator", ROOT / "scripts/evaluate-cleanup-worker.py")
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)


class EvaluatorTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="voxloom-evaluator-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.model = self.root / "fixture.gguf"
        self.model.write_bytes(b"GGUFtest")
        self.pin = cleanup_model.Artifact(
            "synthetic", 8, hashlib.sha256(b"GGUFtest").hexdigest())
        self.worker = self.root / "worker"
        self.closed_fds = []

    def fake(self, body, read_request=True):
        prelude = (
            '#!/usr/bin/env python3\n'
            'import json, os, struct, sys, time\n'
            'def emit(value):\n'
            '    body = json.dumps(value).encode()\n'
            '    os.write(1, struct.pack(">I", len(body)) + body)\n'
        )
        if read_request:
            prelude += (
                'size = struct.unpack(">I", sys.stdin.buffer.read(4))[0]\n'
                'request = json.loads(sys.stdin.buffer.read(size))\n'
                'assert set(request) == {"requestId", "modelPath", "prompt"}\n'
                'assert open(request["modelPath"], "rb").read() == b"GGUFtest"\n'
            )
        self.worker.write_text(prelude + body + '\n')
        self.worker.chmod(0o700)

    def run_attempt(self, **kwargs):
        original = cleanup_model.verified_model
        from contextlib import contextmanager

        @contextmanager
        def tracked(*args):
            with original(*args) as fd:
                self.closed_fds.append(fd)
                yield fd

        with patch.object(evaluator, 'verified_model', tracked):
            result = evaluator.run_attempt(
                self.worker, self.model, kwargs.pop('prompt', 'synthetic'),
                'r1', artifact=self.pin, **kwargs)
        for fd in self.closed_fds:
            with self.assertRaises(OSError):
                os.fstat(fd)
        if result['pid'] is not None:
            with self.assertRaises(ChildProcessError):
                os.waitpid(result['pid'], os.WNOHANG)
            with self.assertRaises(ProcessLookupError):
                os.kill(result['pid'], 0)
        return result

    def success(self):
        self.fake('emit({"requestId": request["requestId"], '
                  '"status": "ok", "text": "Hello."})')

    def test_success_records_real_attempt_and_per_child_rss(self):
        self.success()
        result = self.run_attempt()
        self.assertEqual(result['candidate'], 'Hello.')
        self.assertIsNone(result['reason'])
        self.assertEqual(result['attempt'], {
            'modelId': self.pin.model_id, 'modelDigest': self.pin.sha256})
        self.assertGreater(result['peakRssBytes'], 0)
        self.assertGreater(result['workerSeconds'], 0)
        self.assertGreater(result['verificationSeconds'], 0)

    def test_early_error_before_large_input_is_not_lost_or_blocked(self):
        self.fake('emit({"requestId": "", "status": "error", '
                  '"errorCode": "model-missing", "error": "missing"})\n'
                  'time.sleep(60)', read_request=False)
        result = self.run_attempt(prompt='x' * 120_000, timeout=2)
        self.assertEqual(result['reason'], 'model-missing')
        self.assertIsNotNone(result['attempt'])
        self.assertLess(result['workerSeconds'], 2)

    def test_early_success_cannot_bypass_unwritten_input(self):
        self.fake('emit({"requestId":"r1","status":"ok","text":"Hello."})\n'
                  'time.sleep(60)', read_request=False)
        result = self.run_attempt(prompt='x' * 120000, timeout=2)
        self.assertEqual(result['reason'], 'runtime-error')
        self.assertIsNotNone(result['attempt'])

    def test_bad_frames_and_envelopes_reject_then_recover(self):
        responses = [
            b'', b'junk', struct.pack('>I', 0), struct.pack('>I', 131073),
            struct.pack('>I', 20) + b'{}',
            struct.pack('>I', 1) + b'\xff',
            struct.pack('>I', 2) + b'[]',
        ]
        for value in [
            {'requestId': 'wrong', 'status': 'ok', 'text': 'Hello.'},
            {'requestId': '', 'status': 'ok', 'text': 'Hello.'},
            {'requestId': 'r1', 'status': 'surprise', 'text': 'Hello.'},
            {'requestId': 'r1', 'status': 'ok', 'text': 7},
            {'requestId': 'r1', 'status': 'ok', 'text': '\ud800'},
            {'requestId': 'r1', 'status': 'ok', 'text': 'Hello.', 'error': 'bad'},
            {'requestId': 'r1', 'status': 'error', 'errorCode': 'model-missing', 'error': ''},
            {'requestId': 'r1', 'status': 'error', 'errorCode': 'x' * 65, 'error': 'bad'},
            {'requestId': 'r1', 'status': 'error', 'errorCode': 'model-missing', 'error': 'x' * 1025},
            {'requestId': 'wrong', 'status': 'error', 'errorCode': 'model-missing', 'error': 'bad'},
            {'requestId': 'r1', 'status': 'error', 'errorCode': 'model-missing', 'error': 'bad', 'text': 'Hello.'},
        ]:
            body = json.dumps(value).encode()
            responses.append(struct.pack('>I', len(body)) + body)
        for frame in responses:
            with self.subTest(frame=repr(frame[:60])):
                self.fake(f'os.write(1, {frame!r})')
                self.assertEqual(self.run_attempt()['reason'], 'runtime-error')
                self.success()
                self.assertIsNone(self.run_attempt()['reason'])

    def test_extra_output_noisy_stderr_and_timeout_are_bounded(self):
        for body, reason in [
            ('os.write(1, b"x" * 200000)', 'runtime-error'),
            ('os.write(2, b"x" * 200000)\ntime.sleep(60)', 'runtime-error'),
            ('time.sleep(60)', 'timeout'),
            ('emit({"requestId":"r1","status":"ok","text":"Hello."})\n'
             'os.write(1, b"extra")', 'runtime-error'),
        ]:
            with self.subTest(reason=reason, body=body):
                self.fake(body)
                result = self.run_attempt(timeout=0.5)
                self.assertEqual(result['reason'], reason)
                self.assertLess(result['workerSeconds'], 2)
                self.success()
                self.assertIsNone(self.run_attempt()['reason'])

    def test_preflight_and_spawn_failures_do_not_invent_attempts(self):
        for setup in ['overflow', 'missing-worker', 'tamper', 'missing-model']:
            with self.subTest(setup=setup):
                self.model.write_bytes(b'GGUFtest')
                self.worker = self.root / setup
                if setup != 'missing-worker':
                    self.success()
                if setup == 'tamper':
                    self.model.write_bytes(b'GGUFfake')
                if setup == 'missing-model':
                    self.model = self.root / 'absent.gguf'
                result = self.run_attempt(
                    prompt='\x00' * 30000 if setup == 'overflow' else 'test')
                self.assertIsNone(result['attempt'])
                self.assertIsNone(result['pid'])
                self.assertIsNone(result['peakRssBytes'])
                self.assertIsNone(result['workerSeconds'])
                self.assertEqual(result['reason'],
                                 'context-overflow' if setup == 'overflow' else
                                 'model-missing' if setup in ('tamper', 'missing-model') else
                                 'runtime-error')

    def test_parent_io_error_keeps_safe_errno_and_reaps_child(self):
        import cleanup_process
        self.fake('time.sleep(60)', read_request=False)
        with patch.object(cleanup_process.selectors.DefaultSelector, 'select',
                          side_effect=OSError(errno.EIO, 'synthetic-private-marker')):
            result = self.run_attempt()
        self.assertEqual(result['reason'], 'runtime-error')
        self.assertEqual(result['detail'], f'process-io-errno-{errno.EIO}')
        self.assertIsNotNone(result['attempt'])
        self.assertNotIn('synthetic-private-marker', json.dumps(result))

    def test_unexpected_harness_failure_is_not_labelled_model_missing(self):
        self.success()
        with patch.object(evaluator, 'exchange', side_effect=OSError('synthetic parent failure')):
            with self.assertRaises(OSError):
                self.run_attempt()
        for fd in self.closed_fds:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_each_attempt_reverifies_model_contents(self):
        self.success()
        self.assertIsNotNone(self.run_attempt()['attempt'])
        self.model.write_bytes(b'GGUFfake')
        result = self.run_attempt()
        self.assertEqual(result['reason'], 'model-missing')
        self.assertIsNone(result['attempt'])

    def test_rss_is_not_cumulative_across_children(self):
        self.fake('allocation = bytearray(96 * 1024 * 1024)\n'
                  'emit({"requestId":"r1","status":"ok","text":"Hello."})')
        large = self.run_attempt()['peakRssBytes']
        self.success()
        small = self.run_attempt()['peakRssBytes']
        self.assertGreater(large - small, 64 * 1024 * 1024)

    def test_malformed_json_duplicate_keys_and_trailing_bytes(self):
        for body in [
            b'{', b'{"requestId":"r1","status":"ok","text":NaN}',
            b'{"requestId":"r1","status":"ok","text":"Hello.","text":"Bad."}',
            b'{"requestId":"r1","status":"ok","text":"Hello."}x',
        ]:
            with self.subTest(body=body):
                frame = struct.pack('>I', len(body)) + body
                self.fake(f'os.write(1, {frame!r})')
                self.assertEqual(self.run_attempt()['reason'], 'runtime-error')

    def test_structured_error_mapping_and_truncation(self):
        for code, diagnostic, expected in [
            ('new-error', 'bad', 'runtime-error'),
            ('timeout', 'bad', 'runtime-error'),
            ('context-overflow', 'too long', 'context-overflow'),
            ('invalid-output', 'cleanup output was truncated', 'invalid-output'),
        ]:
            self.fake(f'emit({{"requestId":"r1","status":"error",'
                      f'"errorCode":{code!r},"error":{diagnostic!r}}})')
            result = self.run_attempt()
            self.assertEqual(result['reason'], expected)
            self.assertEqual(result['truncated'], diagnostic.endswith('was truncated'))

    def test_oversized_text_is_invalid_output(self):
        self.fake('emit({"requestId":"r1","status":"ok","text":"x"*32001})')
        self.assertEqual(self.run_attempt()['reason'], 'invalid-output')

    def test_bridge_uses_production_snapshot_prompt_identity_and_guards(self):
        prepared = evaluator.bridge('prepare', [{
            'rawText': 'send to Voxlom', 'dictionary': [' Voxloom ', 'voxloom'],
            'style': 'formal',
        }])
        item = prepared['items'][0]
        self.assertEqual(item['dictionary'], ['Voxloom'])
        self.assertIn('polished, professional', item['prompt'])
        self.assertEqual(prepared['modelId'], cleanup_model.PIN.model_id)
        self.assertEqual(prepared['modelDigest'], cleanup_model.PIN.sha256)
        self.assertEqual(item['dictionaryDigest'], hashlib.sha256(
            b'["Voxloom"]').hexdigest())
        checked = evaluator.bridge('validate', [
            {'rawText': 'send to Voxlom', 'candidate': 'Send to Voxloom.', 'dictionary': ['Voxloom']},
            {'rawText': 'send to Voxlom', 'candidate': 'Send to Voxloom.', 'dictionary': []},
            {'rawText': 'do not delete /tmp/data', 'candidate': 'Delete /tmp/data.', 'dictionary': []},
        ])
        self.assertEqual(checked['items'], ['Send to Voxloom.', None, None])
        overflow = evaluator.bridge('prepare', [{
            'rawText': 'é' * 8001, 'dictionary': [], 'style': 'casual'}])
        self.assertEqual(overflow['items'][0]['reason'], 'context-overflow')

    def test_bridge_errors_are_explicit_not_quality_success(self):
        with self.assertRaises(evaluator.EvaluationError):
            evaluator.bridge('prepare', [{'style': 'invented'}])
        with self.assertRaises(evaluator.EvaluationError):
            evaluator.bridge('unknown', [])

    def test_bridge_transport_and_schema_failures_are_harness_failures(self):
        for change in [
            {'fault': 'timeout'}, {'exitCode': 1}, {'stderrBytes': 8193},
            {'stdout': b'not-json'},
            {'stdout': json.dumps({
                'items': [7], 'modelId': cleanup_model.PIN.model_id,
                'modelDigest': cleanup_model.PIN.sha256, 'promptVersion': 'cleanup-v1',
            }).encode()},
        ]:
            result = dict(stdout=b'{}', fault=None, exitCode=0, stderrBytes=0)
            result.update(change)
            with self.subTest(change=change), patch.object(evaluator, 'exchange', return_value=result):
                with self.assertRaises(evaluator.EvaluationError):
                    evaluator.bridge('validate', [{'rawText': 'hello', 'candidate': 'Hello.', 'dictionary': []}])
        with patch.object(evaluator, 'exchange', side_effect=FileNotFoundError):
            with self.assertRaises(evaluator.EvaluationError):
                evaluator.bridge('prepare', [])

    def test_expansion_covers_every_style_and_dictionary_mode(self):
        corpus = evaluator.load_corpus(ROOT / 'tests/fixtures/cleanup-corpus.json')
        variants = evaluator.expand_corpus(corpus)
        self.assertEqual(len(variants), len(corpus['cases']) * 6)
        self.assertEqual(len({item['requestId'] for item in variants}), len(variants))
        self.assertEqual({item['style'] for item in variants},
                         {'casual', 'formal', 'very-casual'})
        self.assertEqual({item['dictionaryMode'] for item in variants}, {'on', 'off'})
        self.assertTrue(any(len(item['rawText'].encode()) > 16000 for item in variants))

    def small_corpus(self):
        corpus = self.root / 'small.json'
        corpus.write_text(json.dumps({'version': 1, 'cases': [{
            'id': 'short', 'categories': ['short'], 'rawText': 'hello',
            'dictionary': [], 'candidates': [],
        }]}))
        return corpus

    def test_validation_bridge_failure_preserves_attempts_without_quality_claim(self):
        self.success()
        original = evaluator.bridge

        def failed_validation(operation, items):
            if operation == 'validate':
                raise evaluator.EvaluationError('synthetic bridge failure')
            return original(operation, items)

        output = self.root / 'bridge-failure'
        with patch.object(evaluator, 'bridge', failed_validation):
            with self.assertRaises(evaluator.EvaluationError):
                evaluator.evaluate(self.worker, self.model, self.small_corpus(), output,
                                   artifact=self.pin, evidence_kind='synthetic-test')
        self.assertEqual(len((output / 'attempts.jsonl').read_text().splitlines()), 6)
        self.assertFalse((output / 'summary.json').exists())
        failure = json.loads((output / 'failure.json').read_text())
        self.assertFalse(failure['qualityPassed'])
        self.assertFalse(failure['complete'])

    def test_outcomes_separate_changed_unchanged_and_worker_failure(self):
        for candidate, outcome in [('Hello.', 'accepted-changed'), ('hello', 'accepted-unchanged')]:
            self.fake(f'emit({{"requestId":request["requestId"],"status":"ok","text":{candidate!r}}})')
            output = self.root / outcome
            summary = evaluator.evaluate(self.worker, self.model, self.small_corpus(), output,
                                         artifact=self.pin, evidence_kind='synthetic-test')
            self.assertEqual(summary['counts'], {outcome: 6})
            self.assertFalse(summary['qualityPassed'])
            self.assertEqual(summary['subsequentProcessSeconds']['count'], 5)
            self.assertFalse(summary['hasTenSubsequentSupportedProcesses'])
        self.fake('emit({"requestId":request["requestId"],"status":"error",'
                  '"errorCode":"invalid-output","error":"cleanup output was truncated"})')
        summary = evaluator.evaluate(self.worker, self.model, self.small_corpus(),
                                     self.root / 'worker-failure', artifact=self.pin,
                                     evidence_kind='synthetic-test')
        self.assertEqual(summary['counts'], {'worker-fallback': 6})
        self.assertEqual(summary['reportedTruncationCount'], 6)
        self.assertEqual(summary['supportedFailureCount'], 6)

    def test_invalid_corpora_fail_before_launch_or_output(self):
        for case in [None, [], {}, {'version': 2, 'cases': []},
                     {'version': 1, 'cases': 'invalid'}]:
            path = self.root / 'invalid.json'
            path.write_text(json.dumps(case))
            with self.subTest(case=case), self.assertRaises(evaluator.EvaluationError):
                evaluator.load_corpus(path)

    def test_synthetic_artifact_cannot_be_labelled_actual_model(self):
        self.success()
        with self.assertRaises(evaluator.EvaluationError):
            evaluator.evaluate(self.worker, self.model, self.small_corpus(),
                               self.root / 'mislabelled', artifact=self.pin)

    def test_end_to_end_synthetic_evidence_keeps_fallback_and_pending_review(self):
        self.fake('emit({"requestId":request["requestId"],"status":"ok",'
                  '"text":"Unsafe invented answer."})')
        corpus_path = self.root / 'corpus.json'
        corpus_path.write_text(json.dumps({'version': 1, 'cases': [{
            'id': 'example', 'categories': ['short'], 'rawText': 'hello',
            'dictionary': [], 'candidates': [],
        }]}))
        output = self.root / 'evidence'
        summary = evaluator.evaluate(self.worker, self.model, corpus_path, output,
                                     artifact=self.pin, evidence_kind='synthetic-test')
        self.assertEqual(summary['counts']['guard-fallback'], 6)
        self.assertEqual(summary['humanMeaningReview'], 'pending')
        self.assertFalse(summary['qualityPassed'])
        rows = [json.loads(line) for line in (output / 'cases.jsonl').read_text().splitlines()]
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertEqual(row['finalText'], 'hello')
            self.assertEqual(row['candidate'], 'Unsafe invented answer.')
            self.assertEqual(row['outcome'], 'guard-fallback')
            self.assertEqual(row['reason'], 'invalid-output')
        with self.assertRaises(FileExistsError):
            evaluator.evaluate(self.worker, self.model, corpus_path, output,
                               artifact=self.pin, evidence_kind='synthetic-test')


if __name__ == '__main__':
    unittest.main()
