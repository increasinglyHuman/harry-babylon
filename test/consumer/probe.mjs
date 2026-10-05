#!/usr/bin/env node
/**
 * The consumer check: install the PACKED tarball (exactly what npm would publish) into a scratch
 * project beside Babylon, then import every public entry point the way a user would, by its
 * package name. It proves the `exports` map, the `files` list and the built output agree — the
 * things the repo's own tests (which import from src/) cannot see.
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const pkg = JSON.parse(execSync('npm pkg get name version', { cwd: root }).toString())
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

const scratch = mkdtempSync(join(tmpdir(), 'harry-babylon-consumer-'))
let failed = false
const check = (ok, line) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`)
  if (!ok) failed = true
}
try {
  // Build first (what `prepack` does on publish), then pack without re-running it, so the build's
  // size report stays out of npm's JSON.
  execSync('npm run build', { cwd: root, stdio: 'inherit' })
  const packed = JSON.parse(run(`npm pack --json --ignore-scripts --pack-destination "${scratch}"`, root))[0]
  const tarball = join(scratch, packed.filename)
  const listing = packed.files.map((f) => f.path)
  for (const f of ['package.json', 'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'dist/index.js', 'dist/index.d.ts', 'dist/harry-babylon.playground.js']) {
    check(listing.includes(f), `tarball has ${f}`)
  }
  check(!listing.some((f) => /^(src|test|demo|scripts)\//.test(f) || f.endsWith('.glb')), 'tarball has no sources, tests, demo or GLB files')

  const app = join(scratch, 'app')
  execSync(`mkdir "${app}"`)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  const peers = JSON.parse(run('npm pkg get peerDependencies', root))
  const peerArgs = Object.entries(peers).map(([n, v]) => `"${n}@${v}"`).join(' ')
  run(`npm install --no-audit --no-fund --silent "${tarball}" ${peerArgs}`, app)

  const name = pkg.name
  const entries = {
    [name]: ['attachHarryPhysics', 'createHarryBudget', 'registerHarryLoaderExtension', 'bindClipToSkeleton', 'SpringBoneRuntime'],
    [`${name}/springs`]: ['SpringBoneRuntime', 'DeclaredSpringBones'],
    [`${name}/jiggle`]: ['SurfaceJiggleReader', 'parseSurfaceJiggle', 'createModalOscillator'],
    [`${name}/clips`]: ['bindClipToSkeleton', 'REST_ANCHORED_BONES'],
    [`${name}/vroid`]: ['springsFromVRoidNames', 'springsForBody', 'registerVRoidSynthesis'],
  }
  writeFileSync(
    join(app, 'probe.mjs'),
    `const entries = ${JSON.stringify(entries)}\n` +
      `const out = {}\n` +
      `for (const [spec, names] of Object.entries(entries)) {\n` +
      `  try { const m = await import(spec); out[spec] = names.filter((n) => !(n in m)) } catch (e) { out[spec] = 'import failed: ' + e.message }\n` +
      `}\n` +
      `console.log(JSON.stringify(out))\n`,
  )
  const result = JSON.parse(run('node probe.mjs', app))
  for (const [spec, missing] of Object.entries(result)) {
    check(Array.isArray(missing) && missing.length === 0, `import '${spec}'${Array.isArray(missing) && missing.length ? ` — missing ${missing.join(', ')}` : typeof missing === 'string' ? ` — ${missing}` : ''}`)
  }
  check(existsSync(join(app, 'node_modules', ...name.split('/'), 'dist', 'harry-babylon.playground.js')), `'${name}/playground' resolves to the bundled file`)
  console.log(`\n${pkg.name}@${pkg.version}: ${listing.length} files in the tarball`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
