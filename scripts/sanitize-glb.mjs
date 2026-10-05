/**
 * sanitize-glb — strip identifying metadata from a GLB's JSON chunk, in place
 * (or to a second path), without touching geometry, bones, or Harry's runtime
 * data.
 *
 *   node scripts/sanitize-glb.mjs [options] <in.glb> [out.glb]
 *
 * Options:
 *   --wag-default              set every layered spring drive's wag knobs
 *                              (`springs[i].extras.poqpoq.drive.wag`) to Harry's tuned default,
 *                              { amplitudeDeg: 45, hz: 0.5, bias: 0 }. No other knob is touched.
 *   --wag <amplitudeDeg>,<hz>  set the wag amplitude and rate explicitly (bias is kept). Applied
 *                              after --wag-default when both are given.
 *   --surface-gain <spring>=<gain>
 *                              set `extras.poqpoq.surface.gain` on the named spring (repeatable).
 *                              Other springs, and every other surface field, are left alone.
 *   --rename-animation <name>  rename the file's animation (only when it has exactly one).
 *
 * What it changes:
 *  - generator-assigned names of the form `tripo_<kind>_<uuid>[_<n>]` (nodes,
 *    meshes, materials, textures, images, skins — and the same string wherever
 *    it is repeated, e.g. a node's `extras.name`) become neutral names:
 *    `body`, `body_material`, `body_texture_<n>`, ...;
 *  - `asset.extras`, `asset.copyright`, and scene-level `extras` are removed;
 *  - any OTHER `extras` string that holds a UUID, an e-mail address, or a
 *    filesystem path is removed (its key deleted).
 *  - PNG/JPEG text metadata is NOT rewritten (image bytes are left alone); the
 *    script reports any PNG text chunks it finds so you can decide.
 *
 * What it keeps exactly: bone/node names that are not generator UUIDs, the
 * `VRMC_springBone` extension, every `extras.poqpoq.*` block (Harry's extras
 * namespace), morph target names, and the binary chunk.
 *
 * The re-packed GLB follows the spec: the JSON chunk is padded with spaces to a
 * 4-byte boundary and all lengths are rewritten.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PATH_RE = /(^|[\s"'])([A-Za-z]:[\\/]|\/(home|Users|var|tmp|mnt|opt)\/|~\/)/
const GENERATED_NAME_RE = /^tripo_(node|mat|mesh|image|texture|skin)_[0-9a-f-]{36}(?:_(\d+))?$/i

/** Parse a GLB buffer into { json, bin }. */
export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB (bad magic)')
  if (buf.readUInt32LE(4) !== 2) throw new Error(`unsupported GLB version ${buf.readUInt32LE(4)}`)
  let off = 12
  let json = null
  let bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'))
    else if (type === CHUNK_BIN) bin = Buffer.from(data)
    off += 8 + len
  }
  if (!json) throw new Error('GLB has no JSON chunk')
  return { json, bin }
}

/** Pack { json, bin } into a GLB buffer (JSON padded with spaces, BIN with zeros). */
export function writeGlb(json, bin) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)])
  const parts = []
  const header = Buffer.alloc(12)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonBuf.length, 0)
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4)
  parts.push(header, jsonHeader, jsonBuf)
  if (bin) {
    const binPad = (4 - (bin.length % 4)) % 4
    const binBuf = binPad ? Buffer.concat([bin, Buffer.alloc(binPad, 0)]) : bin
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binBuf.length, 0)
    binHeader.writeUInt32LE(CHUNK_BIN, 4)
    parts.push(binHeader, binBuf)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  return Buffer.concat(parts, total)
}

const NEUTRAL = { node: 'body', mesh: 'body_mesh', mat: 'body_material', image: 'body_image', texture: 'body_texture', skin: 'body_skin' }

/** Sanitize a parsed glTF JSON in place. Returns a report of what changed. */
export function sanitizeGltf(json) {
  const report = { renamed: new Map(), removed: [] }
  const neutralFor = (name) => {
    const m = GENERATED_NAME_RE.exec(name)
    if (!m) return null
    const base = NEUTRAL[m[1].toLowerCase()]
    return m[2] !== undefined ? `${base}_${m[2]}` : base
  }

  // 1. Generator names, wherever the string appears (names, extras.name, ...).
  const rewrite = (v) => {
    if (typeof v === 'string') {
      const n = neutralFor(v)
      if (n) {
        report.renamed.set(v, n)
        return n
      }
      return v
    }
    if (Array.isArray(v)) return v.map(rewrite)
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = rewrite(v[k])
      return v
    }
    return v
  }
  rewrite(json)

  // 2. Document-level metadata.
  if (json.asset) {
    if ('extras' in json.asset) {
      delete json.asset.extras
      report.removed.push('asset.extras')
    }
    if ('copyright' in json.asset) {
      delete json.asset.copyright
      report.removed.push('asset.copyright')
    }
  }
  if ('extras' in json) {
    delete json.extras
    report.removed.push('extras (document)')
  }
  for (const [i, scene] of (json.scenes ?? []).entries()) {
    if (scene && 'extras' in scene) {
      delete scene.extras
      report.removed.push(`scenes[${i}].extras`)
    }
  }

  // 3. Any remaining identifying string inside an `extras` object.
  const identifying = (s) => UUID_RE.test(s) || EMAIL_RE.test(s) || PATH_RE.test(s)
  const scrubExtras = (obj, path) => {
    if (!obj || typeof obj !== 'object') return
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'string') {
        if (identifying(v)) {
          delete obj[k]
          report.removed.push(`${path}.${k}`)
        }
      } else if (v && typeof v === 'object') scrubExtras(v, `${path}.${k}`)
    }
  }
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return
    for (const k of Object.keys(v)) {
      if (k === 'extras') scrubExtras(v[k], `${path}.extras`)
      else walk(v[k], `${path}.${k}`)
    }
  }
  walk(json, '$')
  return report
}

/** Harry's tuned default wag for the layered tail drive. */
export const DEFAULT_WAG = Object.freeze({ amplitudeDeg: 45, hz: 0.5, bias: 0 })

/**
 * Set the wag knobs of every spring whose `extras.poqpoq.drive` carries them to `wag`.
 * Returns the names of the springs changed, with their previous values.
 */
export function setDriveWag(json, wag = DEFAULT_WAG) {
  const changed = []
  for (const s of json.extensions?.VRMC_springBone?.springs ?? []) {
    const drive = s?.extras?.poqpoq?.drive
    if (!drive || typeof drive !== 'object' || !drive.wag || typeof drive.wag !== 'object') continue
    changed.push({ spring: s.name, from: { ...drive.wag } })
    drive.wag = { amplitudeDeg: wag.amplitudeDeg, hz: wag.hz, bias: wag.bias }
  }
  return changed
}

/** Set the wag amplitude/rate of every drive, keeping its bias. Returns the springs changed. */
export function setDriveWagKnobs(json, amplitudeDeg, hz) {
  const changed = []
  for (const s of json.extensions?.VRMC_springBone?.springs ?? []) {
    const wag = s?.extras?.poqpoq?.drive?.wag
    if (!wag || typeof wag !== 'object') continue
    changed.push({ spring: s.name, from: { ...wag } })
    wag.amplitudeDeg = amplitudeDeg
    wag.hz = hz
  }
  return changed
}

/** Set `extras.poqpoq.surface.gain` on the spring named `name`. Returns the previous gain, or null if absent. */
export function setSurfaceGain(json, name, gain) {
  for (const s of json.extensions?.VRMC_springBone?.springs ?? []) {
    if (s?.name !== name) continue
    const surface = s?.extras?.poqpoq?.surface
    if (!surface || typeof surface !== 'object') return null
    const from = surface.gain
    surface.gain = gain
    return { from }
  }
  return null
}

/** Rename the file's single animation. Refuses (returns false) when there is not exactly one. */
export function renameSingleAnimation(json, name) {
  if (!Array.isArray(json.animations) || json.animations.length !== 1) return false
  json.animations[0].name = name
  return true
}

/** PNG tEXt/iTXt/zTXt chunk keywords found in the GLB's embedded images (report only). */
export function pngTextChunks(json, bin) {
  const found = []
  if (!bin) return found
  for (const [i, img] of (json.images ?? []).entries()) {
    if (img.bufferView === undefined || img.mimeType !== 'image/png') continue
    const bv = json.bufferViews[img.bufferView]
    const png = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
    let off = 8
    while (off + 8 <= png.length) {
      const len = png.readUInt32BE(off)
      const type = png.toString('latin1', off + 4, off + 8)
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const body = png.subarray(off + 8, off + 8 + len)
        found.push({ image: i, type, keyword: body.toString('latin1', 0, body.indexOf(0)) })
      }
      if (type === 'IEND') break
      off += 12 + len
    }
  }
  return found
}

function main() {
  const args = process.argv.slice(2)
  let wagDefault = false
  let renameTo = null
  let wag = null
  const gains = []
  const paths = []
  const usage = (why) => {
    console.error(`${why ? `${why}\n` : ''}usage: node scripts/sanitize-glb.mjs [--wag-default] [--wag <deg>,<hz>] [--surface-gain <spring>=<gain>]... [--rename-animation <name>] <in.glb> [out.glb]`)
    process.exit(2)
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wag-default') wagDefault = true
    else if (args[i] === '--rename-animation') renameTo = args[++i] ?? null
    else if (args[i] === '--wag') {
      const [a, h] = String(args[++i] ?? '').split(',').map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(h) || !(h > 0)) usage('--wag needs <amplitudeDeg>,<hz> with hz > 0')
      wag = { amplitudeDeg: a, hz: h }
    } else if (args[i] === '--surface-gain') {
      const m = /^(.+)=(-?[0-9.]+)$/.exec(String(args[++i] ?? ''))
      if (!m || !Number.isFinite(Number(m[2]))) usage('--surface-gain needs <spring>=<gain>')
      gains.push({ name: m[1], gain: Number(m[2]) })
    } else paths.push(args[i])
  }
  const [inPath, outPath = inPath] = paths
  if (!inPath || (args.includes('--rename-animation') && !renameTo)) usage()
  const { json, bin } = readGlb(readFileSync(inPath))
  const report = sanitizeGltf(json)
  if (wagDefault) {
    const changed = setDriveWag(json)
    if (changed.length === 0) console.log('  note: --wag-default found no spring drive with wag knobs')
    for (const c of changed) console.log(`  wag      spring "${c.spring}": ${JSON.stringify(c.from)} -> ${JSON.stringify(DEFAULT_WAG)}`)
  }
  if (wag) {
    const changed = setDriveWagKnobs(json, wag.amplitudeDeg, wag.hz)
    if (changed.length === 0) console.log('  note: --wag found no spring drive with wag knobs')
    for (const c of changed) console.log(`  wag      spring "${c.spring}": ${JSON.stringify(c.from)} -> amplitudeDeg ${wag.amplitudeDeg}, hz ${wag.hz}`)
  }
  for (const g of gains) {
    const r = setSurfaceGain(json, g.name, g.gain)
    if (r) console.log(`  gain     spring "${g.name}" surface.gain ${r.from} -> ${g.gain}`)
    else console.log(`  note: --surface-gain: spring "${g.name}" has no extras.poqpoq.surface (skipped)`)
  }
  if (renameTo) {
    if (renameSingleAnimation(json, renameTo)) console.log(`  renamed  animation -> "${renameTo}"`)
    else console.log('  note: --rename-animation skipped (the file does not have exactly one animation)')
  }
  const out = writeGlb(json, bin)
  writeFileSync(outPath, out)
  const text = JSON.stringify(json)
  console.log(`wrote ${outPath} (${out.length} bytes)`)
  for (const [from, to] of report.renamed) console.log(`  renamed  ${from} -> ${to}`)
  for (const r of report.removed) console.log(`  removed  ${r}`)
  const pngText = pngTextChunks(json, bin)
  for (const t of pngText) console.log(`  note: image ${t.image} has a PNG ${t.type} chunk "${t.keyword}" (not rewritten)`)
  if (UUID_RE.test(text) || EMAIL_RE.test(text)) {
    console.error('FAILED: a UUID or e-mail address is still present in the JSON chunk')
    process.exit(1)
  }
  console.log('  ok: no UUID or e-mail address left in the JSON chunk')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
