"""Synthetic regression benchmark; runs the compiled Android gate with real Vosk PCM decoding.

Requires Python vosk==0.3.45, the pinned Korean model, a JDK, and the Kotlin/JSON
test classpath. Nothing is uploaded. Results are not an estimate of human accuracy.
"""
import argparse
import base64
import json
import re
import subprocess
import time
import wave
from pathlib import Path
from vosk import Model, KaldiRecognizer, SetLogLevel

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--corpus', type=Path, required=True)
parser.add_argument('--java', required=True)
parser.add_argument('--classpath', required=True)
parser.add_argument('--split', choices=['dev', 'holdout'], required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--case', help='Run one named WAV from the selected split')
parser.add_argument('--silence-prefix', type=float, default=0, help='Seconds of PCM silence before each utterance')
args = parser.parse_args()
if not 0 <= args.silence_prefix <= 3600:
    parser.error('--silence-prefix must be between 0 and 3600 seconds')
android = Path(__file__).resolve().parents[1]
grammar = (android/'app/src/main/assets/wake-grammar.json').read_text(encoding='utf-8')
SetLogLevel(-1)
model = Model(str(args.model))
bridge = subprocess.Popen([args.java, '--class-path', args.classpath, str(android/'scripts/WakeGateBridge.java')],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)

def send(value):
    bridge.stdin.write(json.dumps(value, ensure_ascii=False) + '\n')
    bridge.stdin.flush()

def receive():
    line = bridge.stdout.readline()
    if not line:
        raise RuntimeError(f'Kotlin bridge exited: {bridge.poll()}')
    return json.loads(line)

send({'grammar': grammar})
verification_grammar = receive()['grammar']
manifest = json.loads((args.corpus/'manifest.json').read_text(encoding='utf-8-sig'))
records = []
try:
    selected = [c for c in manifest if c['split'] == args.split and (args.case is None or c['file'] == args.case)]
    if not selected:
        raise ValueError('No matching corpus cases')
    for case in selected:
        send({'reset': True})
        assert receive()['ready']
        with wave.open(str(args.corpus/case['file'])) as source:
            assert (source.getframerate(), source.getsampwidth(), source.getnchannels()) == (16000, 2, 1)
            pcm = source.readframes(source.getnframes())
        # Both versions see exactly the same samples, followed by a bounded silence flush.
        pcm = bytes(int(args.silence_prefix*16000)*2) + pcm + bytes(48000)
        decoder = KaldiRecognizer(model, 16000, grammar)
        decoder.SetWords(True)
        decoder.SetPartialWords(True)
        detected = baseline_detected = stable_at = stable_end = None
        verification_ms = []
        trials = []
        question_from = None
        for offset in range(0, len(pcm), 3200):
            chunk = pcm[offset:offset+3200]
            at = (offset + len(chunk))/32000
            final = bool(decoder.AcceptWaveform(chunk))
            result = json.loads(decoder.Result() if final else decoder.PartialResult())
            # The pre-0.2.3 policy: exact tokens, retained timing and 150 ms stable partial.
            words = result.get('result' if final else 'partial_result', [])
            end = None
            if re.search(r'(?:^|\s)까\s*치\s*야(?=\s|$)', result.get('text' if final else 'partial', '')):
                for start in range(len(words)):
                    for finish in range(start, min(start+3, len(words))):
                        if ''.join(w['word'] for w in words[start:finish+1]) == '까치야':
                            value = words[finish].get('end', -1)
                            if max(0, at-4) <= value <= at:
                                end = value
                                break
                    if end is not None:
                        break
            if end is None:
                stable_at = stable_end = None
            else:
                if stable_at is None or abs(end-stable_end) > .15:
                    stable_at, stable_end = at, end
                if baseline_detected is None and (final or at-stable_at >= .15-1e-8):
                    baseline_detected = at
            if detected is not None:
                continue
            send({'pcm': base64.b64encode(chunk).decode(), 'result': result, 'final': final})
            answer = receive()
            while 'verify' in answer:
                started = time.perf_counter()
                verifier = KaldiRecognizer(model, 16000, verification_grammar)
                verifier.SetWords(True)
                verifier.AcceptWaveform(base64.b64decode(answer['verify']))
                verified = json.loads(verifier.FinalResult())
                verification_ms.append(round((time.perf_counter()-started)*1000, 1))
                trials.append({'at': at, 'candidate': result, 'verified': verified})
                send(verified)
                answer = receive()
            if answer['detected']:
                detected = at
                question_from = at - answer['questionSamples']/16000
        if detected is not None and detected < args.silence_prefix:
            raise AssertionError('Wake activated during the silence prefix')
        record = dict(case, silence_prefix=args.silence_prefix, detected=detected, baseline_detected=baseline_detected,
                      question_from=question_from, verification_ms=verification_ms, trials=trials)
        records.append(record)
        if (detected is not None) != case['expected']:
            print(json.dumps({k:v for k,v in record.items() if k not in ('trials', 'verification_ms')}, ensure_ascii=False), flush=True)
finally:
    bridge.stdin.close()
    try:
        bridge.wait(timeout=10)
    except subprocess.TimeoutExpired:
        bridge.kill()
        bridge.wait()

times = sorted(v for r in records for v in r['verification_ms'])
summary = {'split': args.split, 'positive_total': sum(r['expected'] for r in records),
           'negative_total': sum(not r['expected'] for r in records),
           'detected': sum(r['expected'] and r['detected'] is not None for r in records),
           'false_activations': sum(not r['expected'] and r['detected'] is not None for r in records),
           'baseline_detected': sum(r['expected'] and r['baseline_detected'] is not None for r in records),
           'baseline_false_activations': sum(not r['expected'] and r['baseline_detected'] is not None for r in records),
           'verification_count': len(times), 'verification_p95_ms': times[int((len(times)-1)*.95)] if times else None}
args.output.write_text(json.dumps({'summary': summary, 'cases': records}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False), flush=True)
