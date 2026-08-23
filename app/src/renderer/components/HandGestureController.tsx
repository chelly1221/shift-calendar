import { useEffect, useRef, useState } from 'react'
import type { HandLandmarker as HandLandmarkerInstance } from '@mediapipe/tasks-vision'
import {
  computeHandPoseFeatures,
  computePalmCenterX,
  createSwipeDetector,
  isEdgeOnHand,
  type SwipeDirection,
} from '../gesture/handEdgeSwipe'

type GestureStatus = 'starting' | 'ready' | 'error'

interface HandGestureControllerProps {
  enabled: boolean
  onSwipe: (direction: SwipeDirection) => void
}

/** 추론 간격(ms). 15fps면 스와이프(80~650ms) 판정에 충분하고 CPU 부담이 적습니다. */
const INFERENCE_INTERVAL_MS = 66
const PREVIEW_WIDTH = 320
const PREVIEW_HEIGHT = 240

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
 * 웹캠 영상에서 손날 스와이프를 인식해 onSwipe를 호출합니다.
 * 영상은 렌더러 메모리에서만 처리되며 저장·전송하지 않습니다.
 */
export function HandGestureController({ enabled, onSwipe }: HandGestureControllerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onSwipeRef = useRef(onSwipe)
  onSwipeRef.current = onSwipe

  const [status, setStatus] = useState<GestureStatus>('starting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [handVisible, setHandVisible] = useState(false)
  const [edgeOn, setEdgeOn] = useState(false)
  const [lastSwipe, setLastSwipe] = useState<SwipeDirection | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const video = videoRef.current
    if (!video) {
      return
    }

    let disposed = false
    let stream: MediaStream | null = null
    let landmarker: HandLandmarkerInstance | null = null
    let frameHandle: number | null = null
    let usingVideoFrameCallback = false
    let lastInferenceAt = 0
    let lastVideoTime = -1
    let handVisibleState = false
    let edgeOnState = false
    let swipeFlashTimer: ReturnType<typeof setTimeout> | null = null
    const detector = createSwipeDetector()

    setStatus('starting')
    setErrorMessage(null)
    setHandVisible(false)
    setEdgeOn(false)
    setLastSwipe(null)

    const updateHandVisible = (next: boolean) => {
      if (handVisibleState !== next) {
        handVisibleState = next
        setHandVisible(next)
      }
    }
    const updateEdgeOn = (next: boolean) => {
      if (edgeOnState !== next) {
        edgeOnState = next
        setEdgeOn(next)
      }
    }

    const processFrame = (now: number) => {
      if (!landmarker || disposed) {
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

      let result: ReturnType<HandLandmarkerInstance['detectForVideo']>
      try {
        result = landmarker.detectForVideo(video, now)
      } catch (err) {
        console.warn('손동작 추론 실패:', err)
        return
      }

      const landmarks = result.landmarks[0]
      const worldLandmarks = result.worldLandmarks[0]
      if (!landmarks || !worldLandmarks) {
        updateHandVisible(false)
        updateEdgeOn(false)
        detector.reset()
        return
      }

      updateHandVisible(true)
      const features = computeHandPoseFeatures(worldLandmarks)
      const edge = isEdgeOnHand(features)
      updateEdgeOn(edge)
      const x = computePalmCenterX(landmarks)
      if (x === null) {
        return
      }
      const direction = detector.push({ t: now, x, edgeOn: edge })
      if (direction) {
        setLastSwipe(direction)
        if (swipeFlashTimer) {
          clearTimeout(swipeFlashTimer)
        }
        swipeFlashTimer = setTimeout(() => setLastSwipe(null), 900)
        onSwipeRef.current(direction)
      }
    }

    const scheduleNext = () => {
      if (disposed) {
        return
      }
      if (usingVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback((now) => {
          processFrame(now)
          scheduleNext()
        })
        return
      }
      frameHandle = window.requestAnimationFrame((now) => {
        processFrame(now)
        scheduleNext()
      })
    }

    const start = async () => {
      try {
        const [{ FilesetResolver, HandLandmarker }, modelBuffer, mediaStream] = await Promise.all([
          import('@mediapipe/tasks-vision'),
          loadBinary(resolveAssetUrl('mediapipe/hand_landmarker.task')),
          navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: PREVIEW_WIDTH }, height: { ideal: PREVIEW_HEIGHT }, facingMode: 'user' },
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

        const fileset = await FilesetResolver.forVisionTasks(resolveAssetUrl('mediapipe/wasm'))
        const createLandmarker = (delegate: 'GPU' | 'CPU') =>
          HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: modelBuffer, delegate },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.6,
            minHandPresenceConfidence: 0.6,
            minTrackingConfidence: 0.5,
          })
        try {
          landmarker = await createLandmarker('GPU')
        } catch (err) {
          console.warn('GPU delegate 초기화 실패, CPU로 폴백:', err)
          landmarker = await createLandmarker('CPU')
        }
        if (disposed) {
          landmarker.close()
          landmarker = null
          return
        }

        usingVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function'
        setStatus('ready')
        scheduleNext()
      } catch (err) {
        if (disposed) {
          return
        }
        console.warn('손동작 인식 초기화 실패:', err)
        const message = err instanceof Error ? err.message : String(err)
        const errorName = err instanceof Error ? err.name : ''
        const combined = `${errorName} ${message}`
        setErrorMessage(
          /NotAllowed|Permission/i.test(combined)
            ? '카메라 권한이 거부되었습니다.'
            : /NotFound|Requested device not found/i.test(combined)
              ? '사용 가능한 카메라가 없습니다.'
              : /NotReadable|TrackStartError|in use/i.test(combined)
                ? '다른 프로그램이 카메라를 사용 중입니다.'
                : message,
        )
        setStatus('error')
      }
    }

    void start()

    return () => {
      disposed = true
      if (frameHandle !== null) {
        if (usingVideoFrameCallback) {
          video.cancelVideoFrameCallback(frameHandle)
        } else {
          window.cancelAnimationFrame(frameHandle)
        }
      }
      if (swipeFlashTimer) {
        clearTimeout(swipeFlashTimer)
      }
      landmarker?.close()
      landmarker = null
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      video.srcObject = null
    }
  }, [enabled])

  if (!enabled) {
    return null
  }

  const statusLabel =
    status === 'starting'
      ? '카메라 준비 중…'
      : status === 'error'
        ? (errorMessage ?? '오류')
        : lastSwipe
          ? (lastSwipe === 'left' ? '← 스와이프' : '스와이프 →')
          : edgeOn
            ? '손날 인식됨 — 좌우로 휘두르세요'
            : handVisible
              ? '손 감지됨 — 손날을 세우세요'
              : '손을 카메라에 보여주세요'

  return (
    <div
      className={`hand-gesture-widget is-${status}${edgeOn ? ' is-edge-on' : ''}${lastSwipe ? ' is-swiped' : ''}`}
      aria-live="polite"
    >
      <video ref={videoRef} className="hand-gesture-preview" muted playsInline />
      <p className="hand-gesture-status">{statusLabel}</p>
    </div>
  )
}
