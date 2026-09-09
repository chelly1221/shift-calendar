# Microsoft online speech: implementation and dependency notices

The PC voice client uses Microsoft's online Edge Read Aloud service with the
Korean voice `ko-KR-SunHiNeural`. Synthesis sends the requested speech text to
Microsoft. The application does not distribute Microsoft voice models or
voice-style assets. This web interface is separate from the Azure Speech SDK
and can change independently of this application.

## WebSocket transport

The client uses [`ws`](https://github.com/websockets/ws), version `8.21.3`,
distributed under the MIT license. `ws-LICENSE.txt` is an unchanged copy of
`node_modules/ws/LICENSE` from that npm package, including all copyright notices
and the complete permission and disclaimer text.

The existing MP3 decoding dependency and its notices are documented separately
under `../mpg123-decoder/`.

## Protocol provenance

The application's TypeScript client implements the observed request and reply
protocol. Public interoperability information from
[`rany2/edge-tts`](https://github.com/rany2/edge-tts) was consulted as a protocol
reference. That Python package is not imported or bundled, and its source code
was not copied into the application.

The `ws` MIT license covers the WebSocket library; it does not license
Microsoft's speech service or voices. Microsoft identifies SunHi in its
[Korean voice listing](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts).
