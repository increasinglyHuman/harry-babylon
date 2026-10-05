/**
 * The demo avatar, when present. It is NOT distributed with the repository (demo/assets/ is
 * git-ignored); these tests skip with a message when it is absent. When present it must be the
 * sanitized walk export: no UUID / e-mail in its JSON chunk, the tail's wag at Harry's tuned
 * default (0.5 Hz, 45°), three springs, one animation group — and it must load in Babylon with
 * springs and surface jiggle attached.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FreeCamera, NullEngine, Scene, SceneLoader, Vector3, type AbstractMesh, type TransformNode } from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
// @ts-expect-error -- plain .mjs script, no type declarations
import { DEFAULT_WAG, readGlb, renameSingleAnimation, setDriveWag, setDriveWagKnobs, setSurfaceGain, UUID_RE } from '../scripts/sanitize-glb.mjs'
import { attachHarryPhysics, bindClipToSkeleton } from '../src/index.js'

const GLB = fileURLToPath(new URL('../demo/assets/lemur.glb', import.meta.url))
const CLIPS = ['hop', 'squat'].map((k) => [k, fileURLToPath(new URL(`../demo/assets/clips/${k}.glb`, import.meta.url))] as const)
const present = existsSync(GLB)
if (!present) {
  console.info(
    '[demo-asset] demo/assets/lemur.glb is not present (it is not distributed with the repo) — ' +
      'skipping the demo-asset checks. See "Demo assets" in the README.',
  )
}

let engine: NullEngine | null = null
afterEach(() => {
  engine?.dispose()
  engine = null
})

type Spring = { name: string; extras?: { poqpoq?: { drive?: { wag?: unknown } } } }

describe.skipIf(!present)('demo asset (demo/assets/lemur.glb)', () => {
  // The avatar is swappable (a fresh Harry export replaces it): these checks pin what the DEMO needs —
  // sanitized, the tuned wag, one walk, every declared spring and surface loading — not one export's numbers.
  const springsOf = (): { name: string; extras?: { poqpoq?: { drive?: { wag?: unknown }; surface?: { gain?: number } } } }[] => {
    const { json } = readGlb(readFileSync(GLB)) as { json: Record<string, unknown> }
    return (json.extensions as Record<string, { springs: Spring[] }>).VRMC_springBone.springs as never
  }
  it('is sanitized, wags as tuned, walks, and declares its springs and surface gains', () => {
    const { json } = readGlb(readFileSync(GLB)) as { json: Record<string, unknown> }
    const text = JSON.stringify(json)
    expect(UUID_RE.test(text)).toBe(false)
    expect(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)).toBe(false)
    const springs = springsOf()
    expect(springs[0]!.name).toBe('tail')
    expect(springs[0]!.extras?.poqpoq?.drive?.wag).toEqual({ amplitudeDeg: 65, hz: 0.5, bias: 0 })
    for (const s of springs.slice(1)) {
      expect(s.name).toMatch(/^jiggle-/)
      const gain = s.extras?.poqpoq?.surface?.gain
      expect(gain === undefined || (gain >= 0 && gain <= 1), `${s.name} gain ${gain}`).toBe(true)
    }
    expect(springs.some((s) => s.name === 'jiggle-Hair'), 'the ears bounce (hair surface)').toBe(true)
    expect((json.animations as { name: string }[]).map((a) => a.name)).toEqual(['walk'])
  })

  it('loads in Babylon (NullEngine) with its walk group, every declared spring and surface', async () => {
    engine = new NullEngine()
    ;(engine as unknown as { getDeltaTime(): number }).getDeltaTime = () => 1000 / 60
    const scene = new Scene(engine)
    new FreeCamera('cam', new Vector3(0, 1, -3), scene)
    const result = await SceneLoader.ImportMeshAsync('', '', new Uint8Array(readFileSync(GLB)), scene, undefined, '.glb')
    expect(result.animationGroups.length).toBe(1)
    const physics = attachHarryPhysics(result.meshes[0] as unknown as TransformNode, scene, result.meshes as AbstractMesh[], { label: 'demo' })
    const declared = springsOf()
    expect(physics.springs!.springNames).toEqual(declared.map((s) => s.name))
    const surfaces = declared.filter((s) => s.extras?.poqpoq?.surface !== undefined).map((s) => s.name)
    const regions = physics.jiggle!.probe().regions
    expect(regions.map((r) => r.springName)).toEqual(surfaces)
    for (const r of regions) expect(r.modes, r.springName).toBeGreaterThan(0)
    result.animationGroups[0]!.start(true)
    for (let i = 0; i < 5; i++) scene.render()
    expect(physics.springs!.runtime.probe().steps).toBeGreaterThan(0)
    physics.dispose()
  }, 60_000)
})

describe.skipIf(!present || CLIPS.some(([, f]) => !existsSync(f)))('demo clips (demo/assets/clips/*.glb)', () => {
  it('are sanitized, animation-only, one group each, and bind fully onto the demo avatar', async () => {
    engine = new NullEngine()
    const scene = new Scene(engine)
    const avatar = await SceneLoader.ImportMeshAsync('', '', new Uint8Array(readFileSync(GLB)), scene, undefined, '.glb')
    const skeleton = avatar.skeletons[0]!
    for (const [key, file] of CLIPS) {
      const { json } = readGlb(readFileSync(file)) as { json: { meshes?: unknown[]; animations: { name: string }[] } }
      expect(UUID_RE.test(JSON.stringify(json))).toBe(false)
      expect(json.meshes ?? []).toEqual([])
      expect(json.animations.map((a) => a.name)).toEqual([key])
      const clip = await SceneLoader.LoadAssetContainerAsync('', new Uint8Array(readFileSync(file)), scene, undefined, '.glb')
      const group = clip.animationGroups[0]!
      const r = bindClipToSkeleton(group, skeleton, key, false)
      expect(r.skipped).toBe(0)
      expect(r.bound).toBe(group.targetedAnimations.length)
    }
  }, 60_000)
})

describe('sanitizer knobs', () => {
  it('--wag-default sets only the wag knobs of every drive', () => {
    const json = {
      extensions: {
        VRMC_springBone: {
          springs: [
            { name: 'tail', extras: { poqpoq: { drive: { wag: { amplitudeDeg: 54, hz: 4.05, bias: 0.2 }, muscle: 0.5 } } } },
            { name: 'jiggle-Hair', extras: { poqpoq: { surface: {} } } },
          ],
        },
      },
    }
    const changed = setDriveWag(json)
    expect(changed).toEqual([{ spring: 'tail', from: { amplitudeDeg: 54, hz: 4.05, bias: 0.2 } }])
    expect(json.extensions.VRMC_springBone.springs[0]!.extras.poqpoq.drive).toEqual({ wag: DEFAULT_WAG, muscle: 0.5 })
    expect(json.extensions.VRMC_springBone.springs[1]).toEqual({ name: 'jiggle-Hair', extras: { poqpoq: { surface: {} } } })
  })

  it('--wag sets amplitude and rate (bias kept); --surface-gain sets one spring only', () => {
    const json = {
      extensions: {
        VRMC_springBone: {
          springs: [
            { name: 'tail', extras: { poqpoq: { drive: { wag: { amplitudeDeg: 54, hz: 4.05, bias: 0.1 } } } } },
            { name: 'jiggle-Hair', extras: { poqpoq: { surface: { gain: 0.4, version: 1 } } } },
            { name: 'jiggle-LeftBreast', extras: { poqpoq: { surface: { gain: 0.6, version: 1 } } } },
          ],
        },
      },
    }
    setDriveWagKnobs(json, 65, 0.5)
    expect(json.extensions.VRMC_springBone.springs[0]!.extras.poqpoq.drive!.wag).toEqual({ amplitudeDeg: 65, hz: 0.5, bias: 0.1 })
    expect(setSurfaceGain(json, 'jiggle-LeftBreast', 0.45)).toEqual({ from: 0.6 })
    expect(setSurfaceGain(json, 'tail', 0.45)).toBeNull()
    const surfaces = json.extensions.VRMC_springBone.springs.slice(1).map((s) => s.extras.poqpoq.surface)
    expect(surfaces).toEqual([{ gain: 0.4, version: 1 }, { gain: 0.45, version: 1 }])
  })

  it('--rename-animation only renames a single animation', () => {
    const one = { animations: [{ name: 'mixamo.com' }] }
    expect(renameSingleAnimation(one, 'walk')).toBe(true)
    expect(one.animations[0]!.name).toBe('walk')
    const two = { animations: [{ name: 'a' }, { name: 'b' }] }
    expect(renameSingleAnimation(two, 'walk')).toBe(false)
    expect(two.animations.map((a) => a.name)).toEqual(['a', 'b'])
  })
})
