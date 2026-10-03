#!/usr/bin/env python3
"""Offline cleanup evaluation. Completion is NOT a model-quality certification."""

import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
import math
from pathlib import Path
import platform
import statistics
import struct
import time

from cleanup_model import PIN, verified_model
from cleanup_process import MAX_FRAME_BYTES, ProcessStartError, exchange

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_LIMIT = 8 * 1024 * 1024


class EvaluationError(Exception):
    """Harness failure; do not confuse with a model or validation outcome."""


def strict_json(data):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError('non-JSON numeric constant')

    return json.loads(data.decode('utf-8', errors='strict'),
                      object_pairs_hook=pairs, parse_constant=invalid_constant)


def run_attempt(worker, model, prompt, request_id, *, artifact=PIN, timeout=30):
    """Verify the held descriptor on EVERY attempt; never reopen it by pathname.

    artifact/timeout are weight-free test seams, not CLI allowlist/deadline flags.
    Attempt attribution means successful child launch with the verified fd, not
    model loading or generation success. Diagnostic labels never echo child text.
    """
    result = {
        'attempt': None, 'candidate': None, 'reason': None, 'detail': None,
        'pid': None, 'exitCode': None, 'workerSeconds': None,
        'verificationSeconds': 0, 'peakRssBytes': None, 'stderrBytes': 0,
        'truncated': False,
    }
    started = time.monotonic()
    with ExitStack() as stack:
        try:
            fd = stack.enter_context(verified_model(model, artifact))
        except (OSError, ValueError):
            result['verificationSeconds'] = time.monotonic() - started
            return dict(result, reason='model-missing', detail='descriptor-verification-failed')
        result['verificationSeconds'] = time.monotonic() - started
        request = {'requestId': request_id, 'modelPath': f'/dev/fd/{fd}',
                   'prompt': prompt}
        body = bytearray()
        for chunk in json.JSONEncoder(ensure_ascii=False, separators=(',', ':')).iterencode(request):
            encoded = chunk.encode('utf-8')
            if len(body) + len(encoded) > MAX_FRAME_BYTES:
                return dict(result, reason='context-overflow', detail='request-frame-limit')
            body.extend(encoded)
        try:
            process = exchange(
                [str(worker)], struct.pack('>I', len(body)) + body,
                timeout=timeout, stdout_limit=MAX_FRAME_BYTES + 4,
                pass_fds=(fd,), framed=True)
        except ProcessStartError:
            return dict(result, reason='runtime-error', detail='spawn-failed')
        result.update({
            'attempt': {'modelId': artifact.model_id, 'modelDigest': artifact.sha256},
            'pid': process['pid'], 'exitCode': process['exitCode'],
            'workerSeconds': process['seconds'],
            'peakRssBytes': process['peakRssBytes'],
            'stderrBytes': process['stderrBytes'],
        })
    if process['fault']:
        return dict(result, reason='timeout' if process['fault'] == 'timeout' else
                    'runtime-error', detail=process['fault'])
    try:
        frame = process['stdout']
        if len(frame) < 4:
            raise ValueError('missing header')
        size = struct.unpack('>I', frame[:4])[0]
        if not 0 < size <= MAX_FRAME_BYTES or len(frame) != size + 4:
            raise ValueError('invalid frame length')
        response = strict_json(frame[4:])
        if not isinstance(response, dict):
            raise ValueError('not an object')
        status = response.get('status')
        if response.get('requestId') != request_id and not (
                status == 'error' and response.get('requestId') == ''):
            raise ValueError('wrong ID')
        if status == 'error':
            code, message = response.get('errorCode'), response.get('error')
            if (not isinstance(code, str) or not 0 < len(code.encode('utf-8')) <= 64
                    or not isinstance(message, str)
                    or not 0 < len(message.encode('utf-8')) <= 1024
                    or response.get('text') is not None):
                raise ValueError('invalid error')
            return dict(result, reason=code if code in (
                'context-overflow', 'model-missing', 'invalid-output') else 'runtime-error',
                detail='worker-error', truncated=(
                    code == 'invalid-output' and message == 'cleanup output was truncated'))
        text = response.get('text')
        if (status != 'ok' or not isinstance(text, str)
                or response.get('error') is not None
                or response.get('errorCode') is not None
                or not process['inputComplete']):
            raise ValueError('invalid success')
        if len(text.encode('utf-8')) > 32000:
            return dict(result, reason='invalid-output', detail='response-text-limit')
        return dict(result, candidate=text)
    except (ValueError, UnicodeError, RecursionError):
        return dict(result, reason='runtime-error', detail='invalid-response')


def bridge(operation, items):
    payload = json.dumps({'operation': operation, 'items': items},
                         ensure_ascii=False).encode('utf-8')
    if len(payload) > BRIDGE_LIMIT:
        raise EvaluationError('bridge input exceeds 8 MiB')
    try:
        process = exchange(
            ['node', str(ROOT / 'scripts/cleanup-eval-bridge.mjs')], payload,
            timeout=30, stdout_limit=BRIDGE_LIMIT)
        if process['fault'] or process['exitCode'] != 0 or process['stderrBytes']:
            raise EvaluationError('production TS bridge failed')
        result = strict_json(process['stdout'])
        if (not isinstance(result, dict) or not isinstance(result.get('items'), list)
                or len(result['items']) != len(items)
                or result.get('modelId') != PIN.model_id
                or result.get('modelDigest') != PIN.sha256
                or not isinstance(result.get('promptVersion'), str)):
            raise EvaluationError('invalid production TS bridge response')
        for item in result['items']:
            if operation == 'validate':
                if item is not None and not isinstance(item, str):
                    raise EvaluationError('invalid guard result')
            elif (not isinstance(item, dict)
                  or not isinstance(item.get('dictionary'), list)
                  or not all(isinstance(word, str) for word in item['dictionary'])
                  or not isinstance(item.get('dictionaryDigest'), str)
                  or len(item['dictionaryDigest']) != 64
                  or any(c not in '0123456789abcdef' for c in item['dictionaryDigest'])
                  or not ((item.get('reason') is None and isinstance(item.get('prompt'), str))
                          or (item.get('reason') == 'context-overflow' and item.get('prompt') is None))):
                raise EvaluationError('invalid prepared prompt')
        return result
    except (OSError, ValueError, RecursionError) as error:
        raise EvaluationError('production TS bridge unavailable or malformed') from error


def load_corpus(path):
    with Path(path).open('rb') as stream:
        data = stream.read(BRIDGE_LIMIT + 1)
    if len(data) > BRIDGE_LIMIT:
        raise EvaluationError('corpus exceeds 8 MiB')
    try:
        corpus = strict_json(data)
        if (not isinstance(corpus, dict) or type(corpus.get('version')) is not int
                or corpus['version'] != 1 or not isinstance(corpus.get('cases'), list)
                or not 0 < len(corpus['cases']) <= 100):
            raise ValueError('unsupported corpus')
        ids = set()
        for item in corpus['cases']:
            case_id = item['id']
            if (not isinstance(case_id, str) or not case_id
                    or len(case_id) > 80 or not all(c.isascii() and (c.isalnum() or c == '-') for c in case_id)
                    or case_id in ids):
                raise ValueError('invalid or duplicate case ID')
            ids.add(case_id)
            if (not isinstance(item['rawText'], str)
                    or not isinstance(item['dictionary'], list)
                    or not all(isinstance(word, str) for word in item['dictionary'])
                    or not isinstance(item['categories'], list)
                    or not item['categories']
                    or not all(isinstance(category, str) for category in item['categories'])
                    or type(item.get('repeat', 1)) is not int
                    or not 1 <= item.get('repeat', 1) <= 20000
                    or len(item['rawText'].encode('utf-8')) * item.get('repeat', 1) > 64000
                    or item.get('lengthClass', 'supported') not in ('supported', 'length-limit')):
                raise ValueError('invalid case')
        return corpus
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        raise EvaluationError('invalid version-1 corpus') from error


def expand_corpus(corpus):
    return [dict(
        caseId=item['id'], requestId=f"{item['id']}-{style}-{mode}",
        categories=item['categories'], lengthClass=item.get('lengthClass', 'supported'),
        rawText=item['rawText'] * item.get('repeat', 1),
        dictionary=item['dictionary'] if mode == 'on' else [],
        dictionaryMode=mode, style=style,
    ) for item in corpus['cases'] for style in ('casual', 'formal', 'very-casual')
        for mode in ('off', 'on')]


def distribution(values):
    if not values:
        return None
    ordered = sorted(values)
    return {'count': len(values), 'median': statistics.median(values),
            'p95': ordered[math.ceil(len(values) * 0.95) - 1], 'max': max(values)}


def summarize(rows):
    launched = [row for row in rows if row['attempt'] is not None]
    supported = [row for row in launched if row['lengthClass'] == 'supported']
    return {
        'counts': dict(Counter(row['outcome'] for row in rows)),
        'byStyleAndDictionary': {
            f'{style}/{mode}': dict(Counter(row['outcome'] for row in rows
                if row['style'] == style and row['dictionaryMode'] == mode))
            for style in ('casual', 'formal', 'very-casual') for mode in ('off', 'on')},
        'timeoutCount': sum(row['reason'] == 'timeout' for row in rows),
        'reportedTruncationCount': sum(row['truncated'] for row in rows),
        'lengthLimitFallbackCount': sum(row['lengthClass'] == 'length-limit'
                                       and row['reason'] is not None for row in rows),
        'supportedFailureCount': sum(row['lengthClass'] == 'supported'
                                    and row['outcome'] in ('worker-fallback', 'preflight-fallback')
                                    for row in rows),
        'firstProcess': ({key: launched[0][key] for key in (
            'requestId', 'workerSeconds', 'verificationSeconds', 'peakRssBytes',
            'outcome', 'reason')} if launched else None),
        'subsequentProcessSeconds': distribution([row['workerSeconds'] for row in launched[1:]]),
        'supportedProcessSeconds': distribution([row['workerSeconds'] for row in supported]),
        'supportedAcceptedProcessSeconds': distribution([
            row['workerSeconds'] for row in supported
            if row['outcome'] in ('accepted-changed', 'accepted-unchanged')]),
        'verificationSeconds': distribution([row['verificationSeconds'] for row in rows]),
        'peakRssBytes': distribution([row['peakRssBytes'] for row in launched]),
        'hasTenSubsequentSupportedProcesses': len(supported[1:]) >= 10,
        'humanMeaningReview': 'pending', 'qualityPassed': False,
        'timingNote': 'Fresh process per attempt; no resident-model warm runs or cache-clearing claim. Worker wall time includes startup, I/O and teardown, not just inference.',
        'rssNote': 'Per-child wait4 high-water RSS, converted to bytes; excludes parent/Node and is not a total system or GPU memory measurement.',
    }


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def evaluate(worker, model, corpus_path, output, *, artifact=PIN,
             evidence_kind='actual-model'):
    if evidence_kind not in ('actual-model', 'synthetic-test') or (
            artifact != PIN and evidence_kind != 'synthetic-test'):
        raise EvaluationError('test artifacts require synthetic-test evidence')
    worker, model = Path(worker).absolute(), Path(model).absolute()
    corpus = load_corpus(corpus_path)
    variants = expand_corpus(corpus)
    output = Path(output).resolve()
    if output == ROOT or ROOT in output.parents:
        raise EvaluationError('evidence must be outside the repository')
    output.mkdir(mode=0o700)  # Exclusive: never overwrite a prior run.
    manifest = {
        'schemaVersion': 1, 'corpusVersion': corpus['version'],
        'evidenceKind': evidence_kind,
        'corpusSha256': hashlib.sha256(Path(corpus_path).read_bytes()).hexdigest(),
        'workerSha256': None, 'modelId': artifact.model_id,
        'modelDigest': artifact.sha256, 'host': platform.platform(),
        'machine': platform.machine(), 'workerDeadlineSeconds': 30,
        'humanMeaningReview': 'pending', 'qualityPassed': False,
    }
    rows = []
    try:
        manifest['workerSha256'] = file_digest(worker)
        bridge_start = time.monotonic()
        prepared = bridge('prepare', variants)
        manifest['prepareBridgeSeconds'] = time.monotonic() - bridge_start
        manifest['promptVersion'] = prepared['promptVersion']
        write_json(output / 'manifest.json', manifest)
        with (output / 'attempts.jsonl').open('x', encoding='utf-8') as evidence:
            for variant, prompt in zip(variants, prepared['items']):
                if prompt['reason']:
                    attempt = {
                        'attempt': None, 'candidate': None, 'reason': prompt['reason'],
                        'detail': 'prompt-preflight', 'pid': None, 'exitCode': None,
                        'workerSeconds': None, 'verificationSeconds': 0,
                        'peakRssBytes': None, 'stderrBytes': 0, 'truncated': False,
                    }
                else:
                    attempt = run_attempt(worker, model, prompt['prompt'],
                                          variant['requestId'], artifact=artifact)
                row = dict(variant, **attempt)
                row.update(dictionary=prompt['dictionary'],
                           dictionaryDigest=prompt['dictionaryDigest'],
                           promptVersion=prepared['promptVersion'],
                           workerSha256=manifest['workerSha256'])
                rows.append(row)
                evidence.write(json.dumps(row, ensure_ascii=False) + '\n')
                evidence.flush()  # Keep raw evidence if later validation fails.
        candidates = [row for row in rows if row['candidate'] is not None]
        bridge_start = time.monotonic()
        checked = bridge('validate', candidates)
        validation_seconds = time.monotonic() - bridge_start
        accepted = iter(checked['items'])
        with (output / 'cases.jsonl').open('x', encoding='utf-8') as evidence:
            for row in rows:
                final = next(accepted) if row['candidate'] is not None else None
                row['finalText'] = final if final is not None else row['rawText']
                if final is not None:
                    row['outcome'] = ('accepted-unchanged' if final == row['rawText']
                                      else 'accepted-changed')
                elif row['candidate'] is not None:
                    row.update(outcome='guard-fallback', reason='invalid-output',
                               detail='production-guard-rejected')
                else:
                    row['outcome'] = ('worker-fallback' if row['attempt'] else 'preflight-fallback')
                row['humanMeaningReview'] = 'pending'
                evidence.write(json.dumps(row, ensure_ascii=False) + '\n')
        summary = dict(summarize(rows), schemaVersion=1, complete=True,
                       evidenceKind=evidence_kind, validationBridgeSeconds=validation_seconds)
        write_json(output / 'summary.json', summary)
        return summary
    except BaseException:
        write_json(output / 'failure.json', dict(
            complete=False, qualityPassed=False, humanMeaningReview='pending',
            completedAttempts=len(rows), detail='evaluation-interrupted-or-failed'))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('worker', 'model', 'corpus', 'output'):
        parser.add_argument(f'--{name}', required=True, type=Path)
    args = parser.parse_args()
    try:
        summary = evaluate(args.worker, args.model, args.corpus, args.output)
    except (EvaluationError, OSError, ValueError):
        parser.exit(1, 'Evaluation failed; inspect existing evidence. No quality pass claimed.\n')
    print(f"Evidence: {args.output}\nHuman meaning review: pending; quality NOT certified.")
    return 1 if summary['supportedFailureCount'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
