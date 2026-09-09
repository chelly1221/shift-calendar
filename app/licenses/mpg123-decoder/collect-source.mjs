// Collect the unmodified, pinned decoder sources needed by the build recipe.
// This downloads source only. It does not build, install, or run third-party code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const decoderRevision = '8f2428c1cd96b54dab74836c8471ff75fe35cbee';
const commonRevision = 'e4f7eef8cda48719a884023582d8efc5b8d76f6c';
const repository = 'eshaz/wasm-audio-decoders';
const output = path.join(root, 'source', 'wasm-audio-decoders');
const hashes = [];

async function request(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'shift-calendar-source-notices' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}

async function collect(revision, include) {
  const treeUrl = `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`;
  const tree = await (await request(treeUrl)).json();
  if (tree.truncated) throw new Error('Refusing an incomplete source tree');
  const files = tree.tree.filter((entry) => entry.type === 'blob' && include(entry.path));
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < files.length) {
      const entry = files[cursor++];
      const url = `https://raw.githubusercontent.com/${repository}/${revision}/${entry.path}`;
      const content = Buffer.from(await (await request(url)).arrayBuffer());
      const gitSha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
      if (gitSha !== entry.sha) throw new Error(`Source hash mismatch: ${entry.path}`);
      const destination = path.join(output, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
      hashes.push({ path: entry.path, revision, url, gitBlobSha: gitSha,
        sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
    }
  }));
}

await collect(decoderRevision, (name) =>
  ['.gitattributes', '.gitignore', '.gitmodules', 'README.md', 'Makefile',
    'build.js', 'decoder-npm-install.sh', 'package.json', 'package-lock.json'].includes(name)
  || name.startsWith('src/mpg123-decoder/'));
await collect(commonRevision, (name) => name.startsWith('src/common/'));
hashes.sort((a, b) => a.path.localeCompare(b.path));
await fs.writeFile(path.join(root, 'SOURCE-MANIFEST.json'), JSON.stringify({
  repository: `https://github.com/${repository}`,
  decoderRevision, commonRevision,
  mpg123Revision: '08247b317163175e62035893af3ff9e71a5dfefd',
  description: 'Unmodified root build files, complete mpg123-decoder package source, and complete common package source. The mpg123 submodule is supplied separately in full. Unrelated decoders, their submodules, demos, and test audio are omitted.',
  files: hashes,
}, null, 2) + '\n');
console.log(`Collected and verified ${hashes.length} upstream files (${hashes.reduce((sum, file) => sum + file.bytes, 0)} bytes).`);
