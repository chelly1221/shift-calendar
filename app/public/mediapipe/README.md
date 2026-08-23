# MediaPipe 자산

- `gesture_recognizer.task`: Google MediaPipe Gesture Recognizer (float16, v1). Apache-2.0.
  손 랜드마크 + 내장 제스처 분류(Closed_Fist, Open_Palm, Pointing_Up, Thumb_Up, Thumb_Down, Victory, ILoveYou) 포함.
  출처: https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
- `wasm/`: `@mediapipe/tasks-vision` 패키지의 WASM 런타임. `vite.config.ts`의 `syncMediapipeWasm()`이
  `node_modules`에서 자동 복사하며 gitignore 대상입니다 (`npm i` 후 `npm run dev`/`build` 시 생성).
