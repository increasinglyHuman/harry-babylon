/**
 * SurfaceJiggleReader — the surface-jiggle reader: drives sparse `surface.<Region>.<k>` morph targets from the motion of
 * a declared bounce leaf (`jiggle-<Region>` on `VRMC_springBone`), through
 * `extras.poqpoq.surface` beside that spring's own `extras.poqpoq.drive`.
 *
 * ONE responsibility: WHEN and HOW the morph weights are written, each frame,
 * for the regions a loaded file actually declares. The oscillator math lives
 * in modalOscillator.ts (arithmetic identical to Harry's preview); the JSON
 * validation in surfaceJiggleDeclaration.ts. This module only resolves glTF
 * node NAMES to the loaded scene's TransformNodes and morph target NAMES to
 * the loaded mesh's MorphTargets, and runs the per-frame step.
 *
 * Absent `extras.poqpoq.surface` on every spring: `attach()` returns null and
 * NO OBSERVER is registered — zero cost, and the file's rest shape plays
 * exactly (the same "a reader that knows none of it" guarantee the export
 * side promises).
 *
 * SAME DOORWAY FOR HAIR: a `jiggle-Hair` spring with
 * a `HairJiggle` leaf carries this exact shape, morph targets `surface.Hair.*`
 * — no new fields, no special casing here. Soft tissue (chest/belly/glutes)
 * and hair are the same code path.
 *
 * Runs on `scene.onBeforeRenderObservable`, registered AFTER DeclaredSpringBones
 * for the same avatar (`attachHarryPhysics` builds this right after it), so each
 * frame reads the bounce leaf's position AFTER the spring step moved it.
 *
 * ONE AUTHORITY, NOT A SECOND TOGGLE: rather
 * than its own LOD/pause bookkeeping, this reader rides DeclaredSpringBones'
 * own signal for the SAME avatar — {@link SpringLockstep.frameSignal} — for
 * both WHETHER to step and WHICH dt to use:
 *   - 'advanced' → step with THAT dt (which may be several frames' worth,
 *     accumulated across a far-LOD hold — never the raw per-frame delta, or a
 *     3-frame displacement gets divided by a 1-frame dt and kicks a phantom
 *     velocity);
 *   - 'held' → do nothing; the pose and the jiggle freeze together;
 *   - 'reset' → forget the last sample (a teleport, LOD re-entry, unpause,
 *     unhide just snapped the pose) without stepping.
 * `DeclaredSpringBones.globalPaused` (the graphics-tier toggle) is checked
 * directly — the SAME static flag, not a mirror of it — and additionally
 * SETTLES every morph to rest (weight 0, oscillator state cleared) once on
 * the transition into paused, so a held LOD frame (freeze) and a paused tier
 * (rest) read differently, as they should.
 *
 * GUARDRAIL (a throw inside a Babylon frame observer freezes the
 * render loop): the per-frame step is wrapped — a bad model logs ONCE, rests
 * every weight it was driving, and detaches its observer; it never throws a
 * second time.
 */

import { Matrix, TransformNode, Vector3, type AbstractMesh, type Nullable, type Observer, type Scene } from '@babylonjs/core'
import type { MorphTarget } from '@babylonjs/core/Morph/morphTarget'
import type { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager'
import { DeclaredSpringBones, type SpringFrameSignal } from './DeclaredSpringBones.js'
import { createModalOscillator, type ModalOscillator } from './modalOscillator.js'
import { parseSurfaceJiggle, type SurfaceJiggleDeclaration } from './surfaceJiggleDeclaration.js'

/** One spring's raw `extras` — the shape DeclaredSpringBones' declaration already carries per spring. */
export interface SurfaceJiggleSpringSource {
  readonly name: string
  readonly extras: unknown
}

/**
 * What SurfaceJiggleReader needs from the avatar's spring runtime to stay in lockstep
 * with it — satisfied by `DeclaredSpringBones` itself; a minimal interface so tests can
 * fake it without building a full spring rig.
 */
export interface SpringLockstep {
  frameSignal(): SpringFrameSignal
}

interface LiveMode {
  readonly entries: readonly MorphTarget[]
  readonly px: number
  readonly py: number
  readonly pz: number
}

interface LiveRegion {
  readonly springName: string
  readonly tip: TransformNode
  readonly owner: TransformNode
  /** The owner's world matrix at attach time (before any clip plays) — captured once. */
  readonly ownerBindWorld: Matrix
  readonly gain: number
  readonly modes: readonly LiveMode[]
  readonly osc: ModalOscillator
  prevT: Vector3 | null
  prevV: Vector3 | null
  // Scratch buffers — reused every frame, never reallocated (no per-frame allocation).
  readonly _ownerInv: Matrix
  readonly _tipPos: Vector3
  readonly _local: Vector3
  readonly _T: Vector3
  readonly _vel: Vector3
  readonly _dv: Vector3
}

const live = new Set<SurfaceJiggleReader>()

/** Every TransformNode name reachable from `root` (including `root` itself), for the tip/owner lookup. */
function nodeIndex(root: TransformNode): Map<string, TransformNode> {
  const map = new Map<string, TransformNode>()
  map.set(root.name, root)
  for (const n of root.getChildTransformNodes(false)) map.set(n.name, n)
  return map
}

/** Every morph target name across `meshes`, however many sub-meshes carry it (VRoid splits a face into several). */
function morphIndex(meshes: readonly AbstractMesh[]): Map<string, MorphTarget[]> {
  const map = new Map<string, MorphTarget[]>()
  for (const mesh of meshes) {
    const manager = (mesh as unknown as { morphTargetManager: MorphTargetManager | null }).morphTargetManager
    if (!manager) continue
    for (let i = 0; i < manager.numTargets; i++) {
      const target = manager.getTarget(i)
      let list = map.get(target.name)
      if (!list) map.set(target.name, (list = []))
      list.push(target)
    }
  }
  return map
}

export class SurfaceJiggleReader {
  private readonly scene: Scene
  private readonly label: string
  private readonly regions: LiveRegion[]
  private readonly lockstep: SpringLockstep
  private observer: Nullable<Observer<Scene>> = null
  private failed = false
  /** True once every mode has been rest-settled for the CURRENT pause span — set() runs once per span, not every paused frame. */
  private settledForPause = false
  private enabled = true

  // `root` is resolved against once in attach() (nodeIndex) and never needed again: the
  // enabled/hidden/LOD state it used to drive directly now all arrives via `lockstep`
  // (DeclaredSpringBones owns the single `isEnabled()`/distance check).
  private constructor(scene: Scene, label: string, regions: LiveRegion[], lockstep: SpringLockstep) {
    this.scene = scene
    this.label = label
    this.regions = regions
    this.lockstep = lockstep
    this.observer = scene.onBeforeRenderObservable.add(() => this.onFrame())
    live.add(this)
  }

  /**
   * Builds the reader for every spring whose `extras.poqpoq.surface` parses AND whose tip/owner
   * nodes and every mode's morph target can be resolved on the loaded scene. Returns null — no
   * observer registered — when nothing resolves (the common case: a file with no surface jiggle).
   * `lockstep` is the SAME DeclaredSpringBones instance that owns these springs — its frameSignal()
   * is this reader's only source of WHEN to step and WHAT dt to use.
   */
  static attach(
    root: TransformNode,
    scene: Scene,
    meshes: readonly AbstractMesh[],
    springs: readonly SurfaceJiggleSpringSource[],
    lockstep: SpringLockstep,
    label: string,
  ): SurfaceJiggleReader | null {
    if (springs.length === 0) return null
    const nodes = nodeIndex(root)
    const morphs = morphIndex(meshes)
    const warn = (m: string): void => console.warn(`[surface-jiggle] ${label}: ${m}`)
    const regions: LiveRegion[] = []
    for (const spring of springs) {
      const decl = parseSurfaceJiggle(spring.extras, (why) => warn(`spring "${spring.name}": ${why}`))
      if (!decl) continue
      const region = buildRegion(spring.name, decl, nodes, morphs, warn)
      if (region) regions.push(region)
    }
    if (regions.length === 0) return null
    return new SurfaceJiggleReader(scene, label, regions, lockstep)
  }

  /**
   * Turn this avatar's surface jiggle off or on. Off: every morph weight and oscillator goes to
   * rest at once and no per-frame work is done. On: the next sample starts fresh (no kick from the
   * motion made while off).
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) this.restAllModes()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  dispose(): void {
    this.detach()
    this.restAllModes()
  }

  private detach(): void {
    live.delete(this)
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer)
      this.observer = null
    }
  }

  /** Zero every morph weight AND the oscillator state behind it — a clean rest, never a frozen pose. */
  private restAllModes(): void {
    for (const region of this.regions) {
      region.osc.reset()
      region.prevT = null
      region.prevV = null
      for (const mode of region.modes) for (const entry of mode.entries) entry.influence = 0
    }
  }

  private onFrame(): void {
    try {
      this.step()
    } catch (e) {
      if (!this.failed) {
        this.failed = true
        console.warn(`[surface-jiggle] ${this.label}: applyFrame threw — detaching (the rest shape plays from here):`, e)
      }
      this.detach()
      try {
        this.restAllModes()
      } catch {
        // Best effort: the model is already broken and we're detaching — a second throw out
        // of a catch block would still freeze the render loop, so cleanup never rethrows.
      }
    }
  }

  private step(): void {
    if (!this.enabled) return
    // TIER GATE: the SAME flag DeclaredSpringBones honours, not a second toggle — a
    // low graphics tier pauses every spring bone AND every surface jiggle together.
    if (DeclaredSpringBones.globalPaused) {
      if (!this.settledForPause) {
        this.settledForPause = true
        this.restAllModes()
      }
      return
    }
    this.settledForPause = false

    // LOD CADENCE: step only when the spring solver for this avatar actually
    // advanced this frame, using its dt — which may already be several frames' worth,
    // accumulated across a far-LOD hold. 'held' (including beyond the spring's own cutoff,
    // hidden, or a skipped far-LOD frame) does nothing; 'reset' forgets the last sample.
    const signal = this.lockstep.frameSignal()
    if (signal.kind === 'held') return
    if (signal.kind === 'reset') {
      for (const region of this.regions) {
        region.prevT = null
        region.prevV = null
      }
      return
    }
    const dt = Math.min(Math.max(signal.dt, 0), 0.25)
    for (const region of this.regions) this.stepRegion(region, dt)
  }

  /** Debug probe support (`__surfaceJiggle()`): this reader's label and its live regions. */
  probe(): { label: string; regions: { springName: string; modes: number; gain: number }[] } {
    return { label: this.label, regions: this.regions.map((r) => ({ springName: r.springName, modes: r.modes.length, gain: r.gain })) }
  }

  private stepRegion(region: LiveRegion, dt: number): void {
    if (dt > 0) {
      region.owner.computeWorldMatrix(true)
      region.tip.computeWorldMatrix(true)
      region.owner.getWorldMatrix().invertToRef(region._ownerInv)
      region.tip.getWorldMatrix().getTranslationToRef(region._tipPos)
      Vector3.TransformCoordinatesToRef(region._tipPos, region._ownerInv, region._local)
      Vector3.TransformCoordinatesToRef(region._local, region.ownerBindWorld, region._T)
      if (region.prevT) {
        region._vel.copyFrom(region._T).subtractInPlace(region.prevT).scaleInPlace(1 / dt)
        if (region.prevV && dt < 0.1) {
          region._dv.copyFrom(region._vel).subtractInPlace(region.prevV)
          region.modes.forEach((m, k) => {
            const kick = region.gain * (region._dv.x * m.px + region._dv.y * m.py + region._dv.z * m.pz)
            region.osc.kick(k, kick)
          })
        }
        if (!region.prevV) region.prevV = new Vector3()
        region.prevV.copyFrom(region._vel)
      }
      if (!region.prevT) region.prevT = new Vector3()
      region.prevT.copyFrom(region._T)
    }
    region.osc.step(dt)
    const weights = region.osc.weights()
    region.modes.forEach((m, k) => {
      const w = weights[k]!
      for (const entry of m.entries) entry.influence = w
    })
  }
}

function buildRegion(
  springName: string,
  decl: SurfaceJiggleDeclaration,
  nodes: ReadonlyMap<string, TransformNode>,
  morphs: ReadonlyMap<string, MorphTarget[]>,
  warn: (m: string) => void,
): LiveRegion | null {
  const tip = nodes.get(decl.tip)
  const owner = nodes.get(decl.owner)
  if (!tip) {
    warn(`spring "${springName}": tip node "${decl.tip}" not found in this file — surface jiggle off for this region`)
    return null
  }
  if (!owner) {
    warn(`spring "${springName}": owner node "${decl.owner}" not found in this file — surface jiggle off for this region`)
    return null
  }
  const modes: LiveMode[] = []
  const oscModes: { freqHz: number; zeta: number; max: number }[] = []
  for (const m of decl.modes) {
    const entries = morphs.get(m.target)
    if (!entries || entries.length === 0) {
      warn(`spring "${springName}": morph target "${m.target}" not found on this mesh — mode skipped`)
      continue
    }
    modes.push({ entries, px: m.participation[0], py: m.participation[1], pz: m.participation[2] })
    oscModes.push({ freqHz: m.freqHz, zeta: m.zeta, max: m.max })
  }
  if (modes.length === 0) {
    warn(`spring "${springName}": no mode's morph target resolved — surface jiggle off for this region`)
    return null
  }
  owner.computeWorldMatrix(true)
  return {
    springName,
    tip,
    owner,
    ownerBindWorld: owner.getWorldMatrix().clone(),
    gain: decl.gain,
    modes,
    osc: createModalOscillator(oscModes),
    prevT: null,
    prevV: null,
    _ownerInv: new Matrix(),
    _tipPos: new Vector3(),
    _local: new Vector3(),
    _T: new Vector3(),
    _vel: new Vector3(),
    _dv: new Vector3(),
  }
}

/** Debug probe, in the browser console: `__surfaceJiggle()` lists every live reader and its regions. */
function surfaceJiggleProbe(): string {
  if (live.size === 0) return 'no avatar with surface jiggle (extras.poqpoq.surface) is loaded'
  return [...live]
    .map((r) => {
      const p = r.probe()
      return `${p.label}: ${p.regions.map((x) => `${x.springName} (${x.modes} modes, gain ${x.gain})`).join(', ')}`
    })
    .join('\n')
}

/** Install the `__surfaceJiggle()` console probe on `globalThis` (never done at import time). */
export function installSurfaceJiggleProbe(): void {
  ;(globalThis as { __surfaceJiggle?: typeof surfaceJiggleProbe }).__surfaceJiggle = surfaceJiggleProbe
}
