# Decoder source and replacement

The application uses the unmodified `mpg123-decoder` 1.0.3 npm package. It is
loaded as an external Node.js module, not folded into the application bundle.
The MPEG decoding library compiled into that package is mpg123, licensed under
LGPL 2.1. See the full upstream `mpg123-COPYING.txt`, including its notice of
copyright and absence of warranty. The JavaScript wrapper is MIT-licensed.

## Included sources

| File in `source/` | Origin |
| --- | --- |
| `mpg123-08247b317163175e62035893af3ff9e71a5dfefd.tar.gz` | Complete source archive of the mpg123 submodule pinned by the decoder release |
| `wasm-audio-decoders-source.zip` | Unmodified decoder package, common package, root build scripts, Makefile, package manifests, and lock files from the release commits below |
| `mpg123-decoder-1.0.3.tgz` | Exact npm release, including the distributed embedded WASM |
| `common-9.0.7.tgz` | Exact npm release of `@wasm-audio-decoders/common` |
| `web-worker-1.2.2.tgz` | Exact npm release of `@eshaz/web-worker`, including its JavaScript source and Apache 2.0 license |
| `simple-yenc-1.0.4.tgz` | Exact npm release, including its JavaScript source and MIT license |

`SOURCE-MANIFEST.json` identifies every collected upstream source file, its
immutable URL, Git blob SHA-1, and SHA-256. Every collected file was checked
against the upstream Git blob. `ARCHIVES.json` records the archive URLs and
checksums. `collect-source.mjs` can retrieve the same pinned files again and
verify their Git hashes; it does not install or execute upstream code.

- Decoder: [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders/tree/8f2428c1cd96b54dab74836c8471ff75fe35cbee), commit `8f2428c1cd96b54dab74836c8471ff75fe35cbee`.
- Common: [same repository](https://github.com/eshaz/wasm-audio-decoders/tree/e4f7eef8cda48719a884023582d8efc5b8d76f6c), commit `e4f7eef8cda48719a884023582d8efc5b8d76f6c`, the npm release's `gitHead`.
- mpg123: [madebr/mpg123](https://github.com/madebr/mpg123/tree/08247b317163175e62035893af3ff9e71a5dfefd), commit `08247b317163175e62035893af3ff9e71a5dfefd`, as pinned in the decoder's Git submodule.
- Web worker: [eshaz/web-worker](https://github.com/eshaz/web-worker/tree/8d1e4bbf49f283fe59fdda20f633286148770696), commit `8d1e4bbf49f283fe59fdda20f633286148770696`.
- yEnc: [eshaz/simple-yenc](https://github.com/eshaz/simple-yenc/tree/3f87552b39abc2791f1e5331cb444a2726abeb86), commit `3f87552b39abc2791f1e5331cb444a2726abeb86`.

The common release's Git commit still labels `package.json` as 9.0.6, while
the npm tarball labels it 9.0.7. All distributed JavaScript and type files were
checked and are byte-identical to that commit. Both original manifests are
preserved rather than silently changing the upstream source.

The source ZIP omits unrelated codec packages, their Git submodules, demo
pages, and test audio. It includes the complete mpg123 wrapper and common
source. The separate mpg123 tarball is complete. No changes to upstream
decoder, mpg123, or common implementation files were made by this application.

## Rebuild a modified mpg123 decoder

Use Linux or WSL, Node.js 18 or later, GNU make, autoconf, automake, libtool,
and [Emscripten 4.0.7](https://github.com/emscripten-core/emscripten/tree/4.0.7),
the compiler version specified by the decoder release's README. Load
`emsdk_env.sh` in the build shell. Building optional puff changes additionally
uses LLVM/clang and Binaryen, as shown in the supplied Makefile.

Extract the ZIP to a working directory. Inside its `wasm-audio-decoders`
directory, extract the complete mpg123 archive into `modules/mpg123`:

```sh
mkdir -p modules/mpg123 demo
tar -xzf /path/to/mpg123-08247b317163175e62035893af3ff9e71a5dfefd.tar.gz \
  --strip-components=1 -C modules/mpg123
```

The root upstream manifest contains local links to all of the unrelated
codecs. For this focused source distribution, remove only those local build
dependency entries in your extracted working copy before installing build
tools. This changes build metadata in that working copy, not decoder source:

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const [name, value] of Object.entries(pkg.devDependencies)) {
  if (value.startsWith('file:')) delete pkg.devDependencies[name];
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
JS
npm install
npm install --prefix src/mpg123-decoder
make mpg123-configure
make mpg123-decoder
```

The final two commands are the supplied upstream Makefile's MPG-only targets.
The configure target generates the mpg123 configuration with upstream flags,
including its `NOQUIET` definition. The build target compiles and links the
library and wrapper, compresses and embeds WASM, and emits
`src/mpg123-decoder/src/EmscriptenWasm.js` and the `dist/` bundles. Compiler and
build-tool packages are external prerequisites. A byte-for-byte reproduction
of the npm binary is not claimed; these sources and targets permit rebuilding
the library with modifications.

For changes to puff, its original source and build script are under
`src/common/src/puff/`; `make puff` rebuilds and embeds it into
`src/common/src/WASMAudioDecoderCommon.js`. Keep the source's original license
notice and identify your modifications.

## Run with a compatible replacement

1. Exit the calendar program before changing library files. Keep a backup of
   the installed library directory.
2. The installed decoder is at
   `resources/app.asar.unpacked/node_modules/mpg123-decoder/`, relative to the
   calendar executable. Replace its `src/EmscriptenWasm.js` with your rebuilt
   file to use a modified mpg123 library with the same wrapper ABI. You can
   also replace the full package with a compatible version preserving its
   `MPEGDecoder` API. No application rebuild is required for that replacement.
3. If changing the common wrapper or its dependencies, the corresponding
   editable directories are also under `resources/app.asar.unpacked/node_modules/`:
   `@wasm-audio-decoders/common/`, `@eshaz/web-worker/`, and `simple-yenc/`.
4. Start the same calendar executable normally and play a short answer. A
   decoder replacement must preserve the expected API and valid PCM output.

Modifying these LGPL-covered components and reverse engineering to debug
those modifications are permitted. Retain their license and source notices
when redistributing them and mark modified versions. The full applicable
terms are in the accompanying upstream licenses.

## Notice origins

`mpg123-COPYING.txt` and `mpg123-AUTHORS.txt` are byte-for-byte upstream files
from the pinned mpg123 commit. `puff-LICENSE.h` is the complete original
`src/common/src/puff/puff.h` at the common commit. The web-worker and yEnc
licenses and READMEs are copied unchanged from their npm packages.

The decoder repository declares MIT in its README and package manifests but
does not contain a standalone MIT license file. `WASM-AUDIO-DECODERS-MIT.txt`
therefore records its exact copyright banner from the release's
`src/mpg123-decoder/terser.json`, followed by the standard MIT permission and
disclaimer text used in the same author's accompanying `simple-yenc` license.
This assembled notice is not presented as an upstream file.

The Emscripten `LICENSE`, `AUTHORS`, and `system/lib/libc/musl/COPYRIGHT` files
are copied unchanged from the official `4.0.7` tag. They preserve the compiler
runtime and bundled libc notices referenced by the upstream build.
