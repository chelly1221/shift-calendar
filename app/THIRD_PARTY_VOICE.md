# PC speech and third-party notices

The current PC voice is Microsoft's online Korean female voice
`ko-KR-SunHiNeural`, through the Edge Read Aloud service. The text to be read
aloud, including names in the answer, is sent to Microsoft over an encrypted
WebSocket to obtain audio. Calendar database files, account tokens, and the
original question are not sent by this speech component. No Azure Speech
subscription or account credentials are configured. This is an unofficial
client of the Edge service, not a supported Azure Speech API integration.
Playback requires an Internet connection. Service errors are reported without
automatically switching to Google, Windows speech, or the local model.

SunHi uses its native `+0%` speaking-rate setting (normal speed) with unchanged pitch. The
application does not stretch or resample the returned speech, add pauses
between every word, or add a fixed delay between answer items. Pronunciation
normalization for Korean clock times, noon, and midnight is retained.

WebSocket transport uses `ws` 8.21.3 (MIT). Its original license and protocol
references are included under `resources/licenses/microsoft-speech/`.

The earlier Supertonic 3 implementation and model assets remain in the source
and PC distribution but are not used by the current speech path. No local model
warmup or inference is performed for the default PC voice. The notices below
remain applicable to those bundled assets and their runtime.

## MP3 decoding on the PC

Audio returned by Microsoft is decoded locally with `mpg123-decoder` 1.0.3 and
`@wasm-audio-decoders/common` 9.0.7. These JavaScript wrappers use the MIT
license; the embedded mpg123 library uses the GNU LGPL 2.1. The wrappers' MIT
declaration does not replace the embedded library's license.

Copyright (c) 1995-2020 by Michael Hipp and others,
free software under the terms of the LGPL v2.1.

The following notices are distributed under
`resources/licenses/mpg123-decoder/`:

| Component | License / notice |
| --- | --- |
| WASM Audio Decoders, Ethan Halsall | `WASM-AUDIO-DECODERS-MIT.txt` (upstream copyright notice and MIT terms) |
| mpg123, pinned source `08247b317163175e62035893af3ff9e71a5dfefd` | Complete `mpg123-COPYING.txt` and `mpg123-AUTHORS.txt` |
| puff 2.3, Mark Adler, included by common | `puff-LICENSE.h`, retaining the complete original zlib-style notice |
| `@eshaz/web-worker` 1.2.2 | Apache 2.0, `web-worker-LICENSE.txt` and upstream `web-worker-README.md` |
| `simple-yenc` 1.0.4, Ethan Halsall | MIT, `simple-yenc-LICENSE.txt` |
| Emscripten 4.0.7 generated runtime | `emscripten-LICENSE.txt`, `emscripten-AUTHORS.txt`, and `musl-COPYRIGHT.txt` |

The same directory includes complete mpg123 source, the decoder and common
source and build files, exact npm package archives, provenance and checksums,
and `REBUILD.md` instructions for rebuilding and replacing the library. These
files accompany the distribution; a separate source request is not needed.
The LGPL-covered library may be modified or replaced, including reverse
engineering needed to debug modifications to it. The runtime decoder package
and its dependencies are kept outside `app.asar`, under
`resources/app.asar.unpacked/node_modules/`, to allow compatible replacements.
No modifications have been made to the distributed third-party decoder code.

## Preserved local model: Supertonic 3

The previous local implementation uses Supertonic 3 with the supplied F1
voice style. When explicitly used by that implementation, synthesis is local
and does not send text to Supertone or Hugging Face. The build downloads public
model assets. This is not the current Microsoft speech path described above.

## Model and voice assets: BigScience Open RAIL-M

- Publisher: Supertone Inc.
- Model: https://huggingface.co/Supertone/supertonic-3
- Pinned revision: `3cadd1ee6394adea1bd021217a0e650ede09a323`
- License: BigScience Open RAIL-M, dated August 18, 2022.
- The complete model license is included as `voice-model/LICENSE` in source
  assets and as `resources/voice-model/LICENSE` in the PC distribution.

Use of the bundled model and its derivatives is governed by that license,
including its paragraph 5 and Attachment A use-based restrictions. Every
recipient and user of the bundled model must comply with those restrictions.
Any redistribution must include the complete model license, retain its notices,
and carry forward the license's required use-based restrictions. No model
weights or voice style values are modified by this application.

## Inference code: MIT

`src/main/voice/neuralSpeech.ts` adapts the official Supertonic Node.js inference
example from https://github.com/supertone-inc/supertonic at revision
`1e9799e964ea4c0dad7cde993b65c3c813a7b373` (`nodejs/helper.js`).
Application changes include TypeScript types, typed-array memory handling,
reused sessions, cancellation, bounded Korean chunks, and in-memory WAV output.

MIT License

Copyright (c) 2025 Supertone Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ONNX Runtime

Inference uses Microsoft's `onnxruntime-node` 1.29.0 with the CPU provider.
The runtime's MIT license and complete upstream third-party notices are copied
without content changes from the official ONNX Runtime `v1.29.0` commit
`2e2543fbe9fae542f921d47a72d21d5a4ef0b710`:

- [LICENSE](https://raw.githubusercontent.com/microsoft/onnxruntime/2e2543fbe9fae542f921d47a72d21d5a4ef0b710/LICENSE)
- [ThirdPartyNotices.txt](https://raw.githubusercontent.com/microsoft/onnxruntime/2e2543fbe9fae542f921d47a72d21d5a4ef0b710/ThirdPartyNotices.txt)

They are tracked under `app/licenses/onnxruntime/` and included in the PC
distribution at `resources/licenses/onnxruntime/` as `LICENSE` and
`ThirdPartyNotices.txt`. The npm package itself does not supply these root files.

The Windows runtime package also contains DirectML 1.15.4 and DirectX Shader
Compiler binaries, although this application's speech uses CPU inference.
Their separate upstream license files are included in the same directory:

| Distributed file | Official source |
| --- | --- |
| `DIRECTML-LICENSE.txt` | `LICENSE.txt` from [Microsoft.AI.DirectML 1.15.4](https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg) |
| `DIRECTML-LICENSE-CODE.txt` | `LICENSE-CODE.txt` from that same fixed-version NuGet package |
| `DIRECTML-ThirdPartyNotices.txt` | `ThirdPartyNotices.txt` from that same fixed-version NuGet package |
| `DXC-LICENSE.TXT` | [LICENSE.TXT](https://raw.githubusercontent.com/microsoft/DirectXShaderCompiler/b4711839eb9a87da7c3436d9b212e0492359fbbd/LICENSE.TXT) from DirectXShaderCompiler commit `b4711839eb9a87da7c3436d9b212e0492359fbbd` |
| `DXC-ThirdPartyNotices.txt` | [ThirdPartyNotices.txt](https://raw.githubusercontent.com/microsoft/DirectXShaderCompiler/b4711839eb9a87da7c3436d9b212e0492359fbbd/ThirdPartyNotices.txt) from that same commit |

The DirectML version matches the bundled DLL and the ONNX Runtime build's
[pinned DirectML package](https://github.com/microsoft/onnxruntime/blob/2e2543fbe9fae542f921d47a72d21d5a4ef0b710/cmake/external/dml.cmake).
The DXC revision matches bundled `dxcompiler.dll` product version
`1.8.2502.8 (b4711839e)`. The original ONNX Runtime third-party notice does not
contain the DirectML terms; the separate files above preserve them.
