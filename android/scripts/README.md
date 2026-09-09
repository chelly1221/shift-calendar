# 호출어 회귀 검증

`generate_wake_corpus.ps1`은 Microsoft Heami Desktop 한 목소리로 고정 문장 48개를 속도 -2/0/2에서 합성한다. 조정용(dev)과 별도 검증용(holdout)은 서로 다른 문장 각 24개다. 각 묶음에 실제 호출 36건과 호출이 아닌 문장 36건이 있다. WAV는 16 kHz, mono, signed PCM16이다. 생성물은 저장소의 `.local-tools`처럼 Git에서 제외되는 경로에 둔다.

`benchmark_wake.py`는 Windows Vosk 0.3.45의 실제 인식 결과와 PCM을 **빌드된 Android Kotlin `WakeAudioGate`** 에 전달한다. Java 브리지는 재판독할 PCM을 요청하고 Vosk 결과를 돌려받는다. 재판독 문법도 실제 `WakeGrammar`에서 읽는다. 같은 첫 인식 결과에 0.2.2의 정확한 호출어·시각·150 ms 안정화 규칙을 적용한 값을 비교 기준으로 기록한다. Android Vosk 0.3.75 바이너리를 PC에서 실행하는 테스트는 아니다.

준비: JDK, Python의 `vosk==0.3.45`, `vosk-model-small-ko-0.22` 압축 해제본, Android `testDebugUnitTest` 빌드 결과. 다음은 저장소 루트에서 실행하는 예다. Python과 Java는 개발 환경에 설치된 실행 파일을 지정한다.

```powershell
.\android\scripts\generate_wake_corpus.ps1 -OutputDirectory '.local-tools\voice-corpus'
$jsonJar = rg --files "$env:GRADLE_USER_HOME/caches" -g 'json-20250517.jar' | Select-Object -First 1
$kotlinJar = rg --files "$env:GRADLE_USER_HOME/caches" -g 'kotlin-stdlib-2.2.0.jar' | Select-Object -First 1
$classpath = 'android/app/build/tmp/kotlin-classes/debug;' + $jsonJar + ';' + $kotlinJar
python android/scripts/benchmark_wake.py --model .local-tools/vosk/vosk-model-small-ko-0.22 --corpus .local-tools/voice-corpus --java "$env:JAVA_HOME/bin/java.exe" --classpath $classpath --split dev --output .local-tools/wake-dev.json
python android/scripts/benchmark_wake.py --model .local-tools/vosk/vosk-model-small-ko-0.22 --corpus .local-tools/voice-corpus --java "$env:JAVA_HOME/bin/java.exe" --classpath $classpath --split holdout --output .local-tools/wake-holdout.json
```

`--case dev-positive-3-rate-0.wav --silence-prefix 650`을 추가하면 한 샘플에 650초 분량의 무음을 앞붙여 엔진의 긴 입력 처리와 버퍼 순환을 검증한다. 실제로 태블릿을 650초 대기시키는 시험이 아니라 PCM을 빠르게 재생하는 시험이다.

숫자는 호출 감지와 오호출을 따로 본다. `detected`는 WAV 시작부터의 오디오 시간이며 실제 기기의 응답 지연이 아니다. `verification_ms`도 PC에서의 재판독 시간이다. 샘플 한 목소리의 결과를 사람의 음성 정확도나 소음 환경의 정확도로 해석하지 않는다. 누락·오호출 샘플도 결과에 그대로 남긴다. 실제 태블릿의 마이크, 제조사 절전, 다른 앱과의 마이크 충돌, 화면 꺼짐·장시간 사용은 별도 실기기 검증 대상이다.
