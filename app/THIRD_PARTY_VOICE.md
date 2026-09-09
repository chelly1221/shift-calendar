# Local AI speech synthesis

This application's PC voice is AI-generated audio synthesized locally using
Supertonic 3, with the supplied F1 voice style. Calendar answers and names are
not transmitted to Supertone or Hugging Face. The build downloads public model
assets; the installed application runs them without an inference API.

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
