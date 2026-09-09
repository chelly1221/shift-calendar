import { parentPort, workerData } from 'node:worker_threads'
import { NeuralSpeechSynthesizer } from './neuralSpeech'
import type { NeuralSpeechRequest, NeuralSpeechResponse } from './neuralSpeechClient'

const port = parentPort
if (!port || !workerData || typeof workerData.modelDirectory !== 'string') throw new Error('Invalid speech worker configuration')
const synthesizer = new NeuralSpeechSynthesizer(workerData.modelDirectory)
const controllers = new Map<number, AbortController>()

port.on('message', (message: NeuralSpeechRequest) => {
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  const controller = new AbortController()
  controllers.set(message.id, controller)
  void (async () => {
    try {
      if (message.type === 'warmup') {
        await synthesizer.warmup()
        port.postMessage({ type: 'ready', id: message.id } satisfies NeuralSpeechResponse)
      } else {
        const audio = await synthesizer.synthesize(message.text, controller.signal)
        // Copy into an owned buffer: Node's pooled Buffer storage cannot be transferred safely.
        const transferable = Uint8Array.from(audio)
        port.postMessage({ type: 'audio', id: message.id, audio: transferable } satisfies NeuralSpeechResponse, [transferable.buffer])
      }
    } catch (error) {
      port.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error' } satisfies NeuralSpeechResponse)
    } finally { controllers.delete(message.id) }
  })()
})
