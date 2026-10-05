#!/usr/bin/env node
/**
 * Build the Playground / CDN bundle and report sizes.
 *
 *  - dist/harry-babylon.playground.js: one minified ESM file of the whole package that reads
 *    Babylon from the global `BABYLON` (as the Babylon Playground and the UMD CDN builds
 *    provide it) instead of bundling it. glTF loader symbols are read from `BABYLON.GLTF2`
 *    (where the UMD loaders build puts them), falling back to `BABYLON`.
 *  - A size report (minified and gzipped) for that file and for each package entry point
 *    bundled on its own with Babylon external.
 */
import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Map every `@babylonjs/*` import onto the global namespace. */
const babylonGlobal = {
  name: 'babylon-global',
  setup(b) {
    b.onResolve({ filter: /^@babylonjs\// }, (args) => ({ path: args.path, namespace: 'babylon-global' }))
    b.onLoad({ filter: /.*/, namespace: 'babylon-global' }, (args) => {
      const isGltf = args.path.startsWith('@babylonjs/loaders/glTF')
      const expr = isGltf ? '(globalThis.BABYLON.GLTF2 || globalThis.BABYLON)' : 'globalThis.BABYLON'
      return {
        contents: `if (!globalThis.BABYLON) throw new Error('harry-babylon playground build: load Babylon.js first (global BABYLON)');\nmodule.exports = ${expr};`,
        loader: 'js',
      }
    })
  },
}

const banner = '/*! harry-babylon (MIT) — Playground/CDN build: expects Babylon.js as the global BABYLON */'

async function bundle(entry, opts) {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    ...opts,
  })
  return r.outputFiles[0].contents
}

const sizes = (buf) => ({ min: buf.length, gzip: gzipSync(buf, { level: 9 }).length })
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

const playground = await bundle(`${root}src/index.ts`, { plugins: [babylonGlobal], banner: { js: banner } })
mkdirSync(`${root}dist`, { recursive: true })
writeFileSync(`${root}dist/harry-babylon.playground.js`, playground)

const rows = [['dist/harry-babylon.playground.js', sizes(playground)]]
for (const [name, entry] of [
  ['harry-babylon', 'src/index.ts'],
  ['harry-babylon/springs', 'src/entries/springs.ts'],
  ['harry-babylon/jiggle', 'src/entries/jiggle.ts'],
  ['harry-babylon/clips', 'src/entries/clips.ts'],
  ['harry-babylon/vroid', 'src/entries/vroid.ts'],
]) {
  rows.push([`${name} (Babylon external)`, sizes(await bundle(`${root}${entry}`, { external: ['@babylonjs/*'] }))])
}
const report = rows.map(([n, s]) => `${n.padEnd(42)} ${kb(s.min).padStart(9)} min  ${kb(s.gzip).padStart(9)} gzip`).join('\n')
console.log(report)
writeFileSync(`${root}dist/sizes.txt`, report + '\n')
