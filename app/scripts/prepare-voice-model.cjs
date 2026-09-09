/* Downloads only public model files. No application text or user data is sent. */
const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const manifest = require('../voice-model-manifest.json')

const destination = path.resolve(__dirname, '..', 'voice-model')

async function validFile(file, expected) {
  try {
    if ((await fs.stat(file)).size !== expected.size) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    return digest.digest('hex') === expected.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function prepareFile(expected) {
  const file = path.resolve(destination, expected.path)
  if (!file.startsWith(destination + path.sep)) throw new Error('Invalid model path')
  if (await validFile(file, expected)) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.download`
  const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${expected.path}`
  try {
    console.log(`Downloading ${expected.path} (${(expected.size / 1e6).toFixed(1)} MB)`)
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }))
    if (!(await validFile(temporary, expected))) throw new Error(`Model checksum mismatch: ${expected.path}`)
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function main() {
  // Bound concurrent downloads, and keep failed/partial files out of production paths.
  for (let index = 0; index < manifest.files.length; index += 2) {
    const results = await Promise.allSettled(manifest.files.slice(index, index + 2).map(prepareFile))
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  await fs.copyFile(path.resolve(__dirname, '..', 'THIRD_PARTY_VOICE.md'), path.join(destination, 'THIRD_PARTY_VOICE.md'))
  console.log(`Supertonic 3 model verified: ${destination}`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
