# MediaPipe 자산

- `hand_landmarker.task`: Google MediaPipe Hand Landmarker (float16, v1). Apache-2.0.
  출처: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- `wasm/`: `@mediapipe/tasks-vision` 패키지의 WASM 런타임. `vite.config.ts`의 `syncMediapipeWasm()`이
  `node_modules`에서 자동 복사하며 gitignore 대상입니다 (`npm i` 후 `npm run dev`/`build` 시 생성).
