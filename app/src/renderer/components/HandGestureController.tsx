import { useEffect, useRef } from 'react'
import type { GestureRecognizer as GestureRecognizerInstance } from '@mediapipe/tasks-vision'
import { createPoseModeResolver, type ViewMode } from '../gesture/handPoseMode'
import { INITIAL_HAND_GESTURE_STATE, type HandGestureState } from '../gesture/gestureState'

interface HandGestureControllerProps {
  enabled: boolean
  /** 현재 화면 모드 — 외부에서 바뀐 경우에도 인식기와 동기화하기 위해 받습니다. */
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  onStateChange: (state: HandGestureState) => void
}

/** 추론 간격(ms). ~15fps면 0.6초 다수결 창에 샘플 9개가 들어가고 CPU 부담이 적습니다. */
const INFERENCE_INTERVAL_MS = 66
/**
 * 캡처 해상도 FHD. 검출 단계는 내부적으로 192×192로 축소되지만, 손을 찾은 뒤 원본에서 잘라 쓰는
 * 랜드마크/제스처 분류 단계는 해상도가 높을수록 멀리 있는 작은 손에서도 안정적입니다.
 */
const CAPTURE_WIDTH = 1920
const CAPTURE_HEIGHT = 1080

function resolveAssetUrl(relativePath: string): string {
  return new URL(relativePath, document.baseURI).href
}

/** file:// 와 http:// 모두에서 동작하도록 XHR로 모델 바이너리를 읽습니다 (Chromium fetch는 file: 스킴을 거부). */
function loadBinary(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => {
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
        resolve(new Uint8Array(xhr.response as ArrayBuffer))
        return
      }
      reject(new Error(`모델 로드 실패 (${xhr.status}): ${url}`))
    }
    xhr.onerror = () => reject(new Error(`모델 로드 실패: ${url}`))
    xhr.send(null)
  })
}

/**
 * 웹캠 영상에서 손 자세를 인식합니다. 주먹 → 캘린더, 손바닥 → 근무표.
 * 화면에는 아무것도 그리지 않고(숨김 video) 상태만 onStateChange로 올립니다.
 * 영상은 렌더러 메모리에서만 처리되며 저장·전송하지 않습니다.
 */
export function HandGestureController({ enabled, mode, onModeChange, onStateChange }: HandGestureControllerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onModeChangeRef = useRef(onModeChange)
  onModeChangeRef.current = onModeChange
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const resolverRef = useRef(createPoseModeResolver(mode))

  // 버튼·Esc 등 외부에서 모드가 바뀌면 인식기 상태를 맞춰 같은 자세로 되돌아가는 일을 막습니다.
  useEffect(() => {
    resolverRef.current.setCurrent(mode)
  }, [mode])

  useEffect(() => {
    if (!enabled) {
      onStateChangeRef.current(INITIAL_HAND_GESTURE_STATE)
      return
    }
    const video = videoRef.current
    if (!video) {
      return
    }

    let disposed = false
    let stream: MediaStream | null = null
    let recognizer: GestureRecognizerInstance | null = null
    let frameHandle: number | null = null
    let lastInferenceAt = 0
    let lastVideoTime = -1
    let state: HandGestureState = { ...INITIAL_HAND_GESTURE_STATE }
    const resolver = resolverRef.current

    const patchState = (patch: Partial<HandGestureState>) => {
      let changed = false
      for (const key of Object.keys(patch) as (keyof HandGestureState)[]) {
        if (state[key] !== patch[key]) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...patch }
      onStateChangeRef.current(state)
    }

    onStateChangeRef.current(state)

    const processFrame = (now: number) => {
      if (!recognizer || disposed) {
        return
      }
      if (document.hidden || video.readyState < 2) {
        return
      }
      if (now - lastInferenceAt < INFERENCE_INTERVAL_MS) {
        return
      }
      // 같은 프레임을 두 번 추론하지 않도록 currentTime으로 중복 방지
      if (video.currentTime === lastVideoTime) {
        return
      }
      lastVideoTime = video.currentTime
      lastInferenceAt = now

      let result: ReturnType<GestureRecognizerInstance['recognizeForVideo']>
      try {
        result = recognizer.recognizeForVideo(video, now)
      } catch (err) {
        console.warn('손동작 추론 실패:', err)
        return
      }

      const top = result.gestures[0]?.[0]
      const nextMode = resolver.push({ t: now, gesture: top?.categoryName ?? null, score: top?.score ?? 0 })
      patchState({
        handVisible: result.landmarks.length > 0,
        gesture: top && top.categoryName !== 'None' ? top.categoryName : null,
        pendingMode: resolver.pending()?.mode ?? null,
      })
      if (nextMode) {
        onModeChangeRef.current(nextMode)
      }
    }

    // rAF 사용: 숨김 video에서는 requestVideoFrameCallback이 프레임 제시 여부에 따라 멈출 수 있음
    const loop = (now: number) => {
      if (disposed) {
        return
      }
      processFrame(now)
      frameHandle = window.requestAnimationFrame(loop)
    }

    const start = async () => {
      try {
        const [{ FilesetResolver, GestureRecognizer }, modelBuffer, mediaStream] = await Promise.all([
          import('@mediapipe/tasks-vision'),
          loadBinary(resolveAssetUrl('mediapipe/gesture_recognizer.task')),
          navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT }, facingMode: 'user' },
            audio: false,
          }),
        ])
        if (disposed) {
          mediaStream.getTracks().forEach((track) => track.stop())
          return
        }
        stream = mediaStream
        video.srcObject = mediaStream
        await video.play()
        patchState({ stream: mediaStream })

        const fileset = await FilesetResolver.forVisionTasks(resolveAssetUrl('mediapipe/wasm'))
        const createRecognizer = (delegate: 'GPU' | 'CPU') =>
          GestureRecognizer.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: modelBuffer, delegate },
            runningMode: 'VIDEO',
            numHands: 1,
            // 멀리 있는 작은 손도 놓치지 않도록 완화. 오탐은 handPoseMode의 다수결·dwell이 걸러냅니다.
            minHandDetectionConfidence: 0.3,
            minHandPresenceConfidence: 0.3,
            minTrackingConfidence: 0.3,
          })
        try {
          recognizer = await createRecognizer('GPU')
        } catch (err) {
          console.warn('GPU delegate 초기화 실패, CPU로 폴백:', err)
          recognizer = await createRecognizer('CPU')
        }
        if (disposed) {
          recognizer.close()
          recognizer = null
          return
        }

        patchState({ status: 'ready' })
        frameHandle = window.requestAnimationFrame(loop)
      } catch (err) {
        if (disposed) {
          return
        }
        console.warn('손동작 인식 초기화 실패:', err)
        const message = err instanceof Error ? err.message : String(err)
        const errorName = err instanceof Error ? err.name : ''
        const combined = `${errorName} ${message}`
        patchState({
          status: 'error',
          errorMessage: /NotAllowed|Permission/i.test(combined)
            ? '카메라 권한이 거부되었습니다.'
            : /NotFound|Requested device not found/i.test(combined)
              ? '사용 가능한 카메라가 없습니다.'
              : /NotReadable|TrackStartError|in use/i.test(combined)
                ? '다른 프로그램이 카메라를 사용 중입니다.'
                : message,
        })
      }
    }

    void start()

    return () => {
      disposed = true
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle)
      }
      recognizer?.close()
      recognizer = null
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      video.srcObject = null
      onStateChangeRef.current(INITIAL_HAND_GESTURE_STATE)
    }
  }, [enabled])

  if (!enabled) {
    return null
  }

  // 추론용 숨김 video — 화면 밖에 두되 display:none은 피함(디코딩이 멈출 수 있음)
  return <video ref={videoRef} className="hand-gesture-capture" muted playsInline aria-hidden="true" />
}
