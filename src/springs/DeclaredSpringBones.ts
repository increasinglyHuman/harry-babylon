/**
 * DeclaredSpringBones — one avatar's file-declared springs, wired into the
 * frame.
 *
 * ONE responsibility: WHEN the SpringBoneRuntime runs for this avatar. It
 * steps on `onBeforeRenderObservable`, which Babylon notifies AFTER
 * `scene.animate()` — so every substep sees this frame's animated pose (and
 * last frame's, for interpolation). The arithmetic lives in the runtime; the
 * file format in springBoneDeclaration; this class only schedules.
 *
 * `fromLoad`/`fromVRoidNames` also hand back the parsed `declaration` — the
 * SurfaceJiggleReader reads `declaration.springs[i].extras.poqpoq.surface`
 * off it (beside this class, never inside it: it drives morph targets, not
 * joint rotations, so it has no business in the solver).
 *
 * Resets the chain onto the current pose (never simulates across the gap):
 *   - on the first frame (the load captured the bind pose; the first clip
 *     pose arrives a frame later, and the tail must not swing in from bind);
 *   - on distance-LOD re-entry (the chain was frozen while far);
 *   - when a disabled root is enabled again (it is not stepped while disabled);
 *   - on a teleport — the avatar root jumping more than 1 m, or turning more
 *     than 90°, per 60 Hz step's worth of frame time.
 * Honours `DeclaredSpringBones.globalPaused` (the perf-attribution / graphics
 * tier toggle that pauses ALL spring bones).
 *
 * THE MOOD INPUT: `setMood` drives every layered spring on this
 * avatar (wag / lash / tuck / still / twitch / loose, 0.25 s cross-fade). The
 * file's mood is only where a tail starts. Debug probe, in the browser console:
 *   __tailMood()        → lists the live sprung avatars and their moods
 *   __tailMood('tuck')  → sets every driven tail's mood
 */

import { Quaternion, Vector3, type TransformNode, type Camera, type Nullable, type Observer, type Scene } from '@babylonjs/core'
import { parseVRMCSpringBone, type SpringBoneDeclaration } from './springBoneDeclaration.js'
import { SpringBoneRuntime, type GroundPlane } from './SpringBoneRuntime.js'
import { takeSpringBoneSource } from './vrmcSpringBoneLoaderExtension.js'
import { TAIL_MOODS, type TailMood } from './springDrive.js'

// Default distance LOD (a class default; `setLod` replaces it per avatar).
const LOD_FULL_SQ = 20 * 20
const LOD_DISABLE_SQ = 50 * 50
const LOD_FAR_EVERY_N_FRAMES = 3
/** Lowest far-band rate `setLod` accepts: below it one far step would exceed MAX_SUBSTEPS and stall-reset. */
export const MIN_LOD_FAR_HZ = 5
const TELEPORT_METERS = 1
const TELEPORT_RADIANS = Math.PI / 2
/**
 * Substeps one frame may run (12 = 200 ms at 60 Hz). Beyond it — a stall, a tab
 * refocus — the runtime resets onto the current pose instead of bursting. Wide
 * enough that the far LOD (every 3rd frame) still steps at 15 fps.
 */
const MAX_SUBSTEPS = 12
/** Airborne: keep the last ground this long, so a landing doesn't snap and a jump has no invisible floor. */
const GROUND_HOLD_S = 0.2
/** A held plane is dropped once the root is this far below it (walked off a ledge). */
const HELD_PLANE_BELOW_M = 0.02
const UP = new Vector3(0, 1, 0)

const live = new Set<DeclaredSpringBones>()

/**
 * This frame's spring result, for a reader that must stay in lockstep with the solver
 * (the SurfaceJiggleReader): 'advanced' with the dt just
 * simulated (including any LOD-accumulated time across held frames — use THIS dt for a
 * velocity, never the raw frame dt, or a 3-frame displacement divides by a 1-frame dt);
 * 'reset' (the pose just snapped onto the current frame — a teleport, LOD re-entry,
 * unpause, unhide — forget any previous sample); or 'held' (paused, hidden, beyond the
 * spring's own 50 m cutoff, or a skipped far-LOD frame — do nothing this frame, the pose
 * and the jiggle both freeze together).
 */
export type SpringFrameSignal = { kind: 'advanced'; dt: number } | { kind: 'reset' } | { kind: 'held' }

/**
 * Does a playing animation key this node's ROTATION? A clip that animates only
 * its position or scale (a direct clip bind keeps non-root position tracks)
 * leaves the quaternion to the spring — counting it as "animated" would feed
 * the spring's own output back in as authored input.
 */
export function rotationKeyed(scene: Scene, node: TransformNode): boolean {
  // getAllAnimatablesByTarget already filters by node (RuntimeAnimation.target is the resolved property, not the node).
  for (const a of scene.getAllAnimatablesByTarget(node)) {
    for (const ra of a.getAnimations()) {
      if (ra.animation.targetProperty === 'rotationQuaternion') return true
    }
  }
  return false
}

function tailMoodProbe(mood?: string): string {
  if (mood !== undefined) {
    if (!(TAIL_MOODS as readonly string[]).includes(mood)) return `unknown mood "${mood}" — one of ${TAIL_MOODS.join(', ')}`
    let n = 0
    for (const s of live) if (s.setMood(mood as TailMood)) n++
    return `mood "${mood}" set on ${n} driven avatar(s)`
  }
  if (live.size === 0) return 'no avatar with VRMC_springBone springs is loaded'
  return [...live]
    .map((s) => {
      const p = s.runtime.probe()
      return `${s.label}: ${s.springNames.join(', ')} · ${p.joints} joints · ${p.driven ? `driven, mood ${s.runtime.getMood()}` : 'passive'} · ${p.steps} steps`
    })
    .join('\n')
}

/**
 * Install the `__tailMood()` console probe on `globalThis`. Not done at import time:
 * a library must not add globals unless asked.
 */
export function installTailMoodProbe(): void {
  ;(globalThis as { __tailMood?: typeof tailMoodProbe }).__tailMood = tailMoodProbe
}

/**
 * Distance LOD for one avatar's springs, measured from `camera` (default: the scene's world
 * camera) to the avatar root. Within `near`: every frame. Between `near` and `far`: a reduced
 * rate — every `farEveryNFrames` frames, or `farHz` steps per second (time-accumulated; the dt
 * handed to the solver and to `frameSignal()` is the whole accumulated time). Beyond `far`:
 * held, and reset onto the current pose on re-entry.
 */
export interface SpringLodConfig {
  near: number
  far: number
  farEveryNFrames?: number
  farHz?: number
  camera?: Camera | null
}

/** See {@link DeclaredSpringBones.simulationState}. */
export type SpringSimulationState = 'full' | 'reduced' | 'held' | 'off'

interface LodState {
  nearSq: number
  farSq: number
  farEveryNFrames: number | null
  farInterval: number | null
  camera: Camera | null
}

export class DeclaredSpringBones {
  /** Pause every avatar's springs (the graphics tier and the perf toggle `springBones(false)`). */
  static globalPaused = false

  readonly runtime: SpringBoneRuntime
  readonly springNames: string[]
  readonly label: string
  private readonly scene: Scene
  private readonly root: TransformNode
  private observer: Nullable<Observer<Scene>> = null
  private needsReset = true
  private wasPaused = false
  private lodDisabled = false
  private hidden = false
  private frame = 0
  private pendingDt = 0
  private lod: LodState | null = { nearSq: LOD_FULL_SQ, farSq: LOD_DISABLE_SQ, farEveryNFrames: LOD_FAR_EVERY_N_FRAMES, farInterval: null, camera: null }
  private enabled = true
  private disabledSpan = false
  private holdPredicate: (() => boolean) | null = null
  private externallyHeld = false
  private simState: SpringSimulationState = 'full'
  private signal: SpringFrameSignal = { kind: 'held' }
  private groundProvider: (() => GroundPlane | null) | null
  private readonly lastGround: GroundPlane = { point: new Vector3(), normal: new Vector3(0, 1, 0) }
  private hasLastGround = false
  private sinceGroundS = 0
  private readonly lastRootPos = new Vector3()
  private readonly lastRootRot = new Quaternion()
  private readonly _p = new Vector3()
  private readonly _q = new Quaternion()
  private readonly _s = new Vector3()

  /**
   * The springs the load of `root` declared. `declared` says whether the FILE
   * carries VRMC_springBone at all — true even when its springs could not be
   * used (unknown specVersion, nothing simulatable, nodes missing), so the
   * caller never replaces an authored declaration with the legacy J_Sec_
   * guess: a declaring file fails CLOSED. `springs` is the
   * running system, or null.
   */
  static fromLoad(root: TransformNode, scene: Scene, label: string): { springs: DeclaredSpringBones | null; declared: boolean; declaration?: SpringBoneDeclaration } {
    const source = takeSpringBoneSource(root)
    if (!source) return { springs: null, declared: false }
    const warn = (m: string): void => console.warn(`[springs] ${label}: ${m}`)
    const declaration = parseVRMCSpringBone(source.extension, source.nodes.length, warn)
    if (!declaration || declaration.springs.length === 0) {
      warn('VRMC_springBone is declared but has no usable spring — no springs play (the J_Sec_ guess is not used)')
      return { springs: null, declared: true }
    }
    const runtime = new SpringBoneRuntime(declaration, source.nodes, {
      onWarn: warn,
      maxSubsteps: MAX_SUBSTEPS,
      // Exact ownership: a tail bone is "animated" when a playing clip keys its ROTATION.
      isKeyed: (node) => rotationKeyed(scene, node),
    })
    return { springs: new DeclaredSpringBones(runtime, declaration.springs.map((s) => s.name), root, scene, label), declared: true, declaration }
  }

  /**
   * Build the scheduled springs for an already-parsed declaration whose node indices resolve
   * through `nodes` (the VRoid synthesis door uses this; see `springsFromVRoidNames`). The same
   * runtime options as `fromLoad`.
   */
  static fromDeclaration(
    root: TransformNode,
    scene: Scene,
    label: string,
    declaration: SpringBoneDeclaration,
    nodes: (TransformNode | null)[],
  ): DeclaredSpringBones {
    const warn = (m: string): void => console.warn(`[springs] ${label}: ${m}`)
    const runtime = new SpringBoneRuntime(declaration, nodes, {
      onWarn: warn,
      maxSubsteps: MAX_SUBSTEPS,
      isKeyed: (node) => rotationKeyed(scene, node),
    })
    return new DeclaredSpringBones(runtime, declaration.springs.map((s) => s.name), root, scene, label)
  }

  private constructor(runtime: SpringBoneRuntime, springNames: string[], root: TransformNode, scene: Scene, label: string) {
    this.runtime = runtime
    this.springNames = springNames
    this.root = root
    this.scene = scene
    this.label = label
    // No ground until the consumer says where it is (setGround): a plane assumed at the root
    // would follow a flying or falling body upward and press its tail against a floor that
    // isn't there. Consumers that know the body stands: rootPlane().
    this.groundProvider = null
    this.observer = scene.onBeforeRenderObservable.add(() => this.onFrame())
    live.add(this)
  }

  /** Set the mood of every layered (driven) spring on this avatar. False when none is driven. */
  setMood(mood: TailMood): boolean {
    if (this.runtime.getMood() === null) return false
    this.runtime.setMood(mood)
    return true
  }

  /**
   * A flat plane at the body's root, for a body the host always keeps on its feet (NPCs; the
   * worn avatar when no controller contact is wired). Never for a body that can fly.
   */
  static rootPlane(root: TransformNode): () => GroundPlane {
    return () => ({ point: root.getAbsolutePosition(), normal: UP })
  }

  /**
   * Where the ground is under this body, per frame (null = airborne). None until set. Replaces the default
   * plane at the root; pass null to turn the ground off entirely.
   */
  setGround(provider: (() => GroundPlane | null) | null): void {
    this.groundProvider = provider
    // A new provider never inherits the old one's held plane.
    this.hasLastGround = false
    if (!provider) this.runtime.setGroundPlane(null)
  }

  /** Re-seat every chain onto the current pose next frame (a teleport, a final placement). */
  requestReset(): void {
    this.needsReset = true
  }

  /**
   * Turn this avatar's springs off or on. Off: the bones go back to their bind rotations once
   * (a keyed bone is rewritten by its clip every frame anyway), and nothing is written after
   * that — the pose is exactly what the animation makes it, with no drift. Back on: the chain
   * resets onto the current pose, so nothing snaps.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.runtime.restoreBind()
      this.signal = { kind: 'held' }
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * How this avatar's springs ran on the last frame: 'full' (every frame), 'reduced' (the LOD's
   * far band), 'held' (beyond the LOD's far distance, or held by the hold predicate — off-screen,
   * a crowd budget), or 'off' (disabled, globally paused, or the root is disabled).
   */
  get simulationState(): SpringSimulationState {
    return this.simState
  }

  /**
   * Replace the distance LOD (see {@link SpringLodConfig}); null = no LOD, every frame at full
   * rate regardless of camera distance. The class default is near 20 m, far 50 m, every 3rd frame.
   */
  setLod(lod: SpringLodConfig | null): void {
    if (lod === null) {
      this.lod = null
      if (this.lodDisabled) {
        this.lodDisabled = false
        this.needsReset = true
      }
      return
    }
    const near = Math.max(0, lod.near)
    const far = Math.max(near, lod.far)
    let farEveryNFrames: number | null = null
    let farInterval: number | null = null
    if (lod.farHz !== undefined) farInterval = 1 / Math.max(MIN_LOD_FAR_HZ, lod.farHz)
    else farEveryNFrames = Math.max(1, Math.round(lod.farEveryNFrames ?? LOD_FAR_EVERY_N_FRAMES))
    this.lod = { nearSq: near * near, farSq: far * far, farEveryNFrames, farInterval, camera: lod.camera ?? null }
  }

  /**
   * An extra hold condition evaluated every frame (off-screen, a crowd budget, ...). While it
   * returns true the springs are held (nothing written, nothing integrated); when it turns false
   * again the chain resets onto the current pose. Null removes it.
   */
  setHoldPredicate(predicate: (() => boolean) | null): void {
    this.holdPredicate = predicate
  }

  /** This frame's result — see {@link SpringFrameSignal}. */
  frameSignal(): SpringFrameSignal {
    return this.signal
  }

  dispose(): void {
    live.delete(this)
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer)
      this.observer = null
    }
  }

  private onFrame(): void {
    if (DeclaredSpringBones.globalPaused) {
      // The body kept animating while the springs were frozen: integrating the
      // stale tails against the resumed pose would whip them.
      this.wasPaused = true
      this.simState = 'off'
      this.signal = { kind: 'held' }
      return
    }
    if (this.wasPaused) {
      this.wasPaused = false
      this.needsReset = true
    }
    // A disabled root (a hidden corpse, a despawned-but-registered body) is never drawn:
    // don't solve it, and re-seat onto whatever pose it is shown in next.
    if (!this.root.isEnabled()) {
      this.hidden = true
      this.simState = 'off'
      this.signal = { kind: 'held' }
      return
    }
    if (this.hidden) {
      this.hidden = false
      this.needsReset = true
    }
    if (!this.enabled) {
      this.disabledSpan = true
      this.simState = 'off'
      this.signal = { kind: 'held' }
      return
    }
    if (this.disabledSpan) {
      this.disabledSpan = false
      this.needsReset = true
    }
    if (this.holdPredicate && this.holdPredicate()) {
      this.externallyHeld = true
      this.simState = 'held'
      this.signal = { kind: 'held' }
      return
    }
    if (this.externallyHeld) {
      this.externallyHeld = false
      this.needsReset = true
    }
    const frameDt = this.scene.getEngine().getDeltaTime() / 1000
    this.frame++

    // The WORLD camera: with a HUD overlay, activeCameras = [world, hud] and scene.activeCamera is
    // left on the HUD between frames (fixed at its origin), so prefer activeCameras[0].
    const lod = this.lod
    const camera = lod ? (lod.camera ?? this.scene.activeCameras?.[0] ?? this.scene.activeCamera) : null
    if (lod && camera) {
      const distSq = Vector3.DistanceSquared(camera.globalPosition, this.root.getAbsolutePosition())
      if (distSq > lod.farSq) {
        this.lodDisabled = true
        this.simState = 'held'
        this.signal = { kind: 'held' }
        return
      }
      if (this.lodDisabled) {
        this.lodDisabled = false
        this.needsReset = true
      }
      const skipFar =
        lod.farEveryNFrames !== null ? this.frame % lod.farEveryNFrames !== 0 : this.pendingDt + frameDt + 1e-9 < lod.farInterval!
      if (distSq > lod.nearSq && skipFar) {
        if (this.needsReset) {
          // Re-entering from beyond 50 m on a skipped frame: the saved solution is from
          // before the avatar was disabled — reset onto the current pose now rather than
          // holding a stale one for up to two frames.
          this.needsReset = false
          this.pendingDt = 0
          this.runtime.reset()
          // Re-seed the teleport baseline too, or the next eligible frame reads the
          // move made while disabled as a NEW teleport and resets again.
          this.root.computeWorldMatrix(true).decompose(this._s, this.lastRootRot, this.lastRootPos)
          this.simState = 'reduced'
          this.signal = { kind: 'reset' }
          return
        }
        this.pendingDt += frameDt
        // A clip may already have written keyed rotations this frame: keep the
        // reduced-rate solution on show instead of the raw clip.
        this.runtime.hold()
        this.simState = 'reduced'
        this.signal = { kind: 'held' }
        return
      }
    }
    const dt = this.pendingDt + frameDt
    this.pendingDt = 0
    this.simState = lod && camera && Vector3.DistanceSquared(camera.globalPosition, this.root.getAbsolutePosition()) > lod.nearSq ? 'reduced' : 'full'

    this.root.computeWorldMatrix(true).decompose(this._s, this._q, this._p)
    if (!this.needsReset && this.teleported(dt)) this.needsReset = true
    this.lastRootPos.copyFrom(this._p)
    this.lastRootRot.copyFrom(this._q)
    // A reset (teleport, LOD re-entry, unpause, unhide) ends any held plane: it may be minutes
    // old and far from the body.
    if (this.needsReset) this.hasLastGround = false
    this.updateGround(dt)

    if (this.needsReset) {
      this.needsReset = false
      this.runtime.reset()
      this.signal = { kind: 'reset' }
      return
    }
    this.runtime.advance(dt)
    this.signal = { kind: 'advanced', dt }
  }

  /** The provider's plane, or the last one for GROUND_HOLD_S after it goes airborne, else none. */
  private updateGround(dt: number): void {
    if (!this.groundProvider) return
    const g = this.groundProvider()
    if (g) {
      this.lastGround.point.copyFrom(g.point)
      this.lastGround.normal.copyFrom(g.normal)
      this.hasLastGround = true
      this.sinceGroundS = 0
      this.runtime.setGroundPlane(this.lastGround)
      return
    }
    this.sinceGroundS += dt
    // Never hold a plane the body has dropped below (a step off a ledge): it would lift the tail.
    const g0 = this.lastGround
    const below =
      (this._p.x - g0.point.x) * g0.normal.x + (this._p.y - g0.point.y) * g0.normal.y + (this._p.z - g0.point.z) * g0.normal.z <
      -HELD_PLANE_BELOW_M
    if (below) this.hasLastGround = false
    this.runtime.setGroundPlane(this.hasLastGround && this.sinceGroundS <= GROUND_HOLD_S ? this.lastGround : null)
  }

  /** Did the avatar root jump further than a step's worth of travel could explain? */
  private teleported(dt: number): boolean {
    const steps = Math.max(1, dt * this.runtime.stepHz)
    if (Vector3.Distance(this._p, this.lastRootPos) > TELEPORT_METERS * steps) return true
    const dot = Math.min(1, Math.abs(Quaternion.Dot(this._q, this.lastRootRot)))
    return 2 * Math.acos(dot) > TELEPORT_RADIANS * steps
  }
}
