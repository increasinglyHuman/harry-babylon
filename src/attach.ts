/**
 * attachHarryPhysics — wire a loaded Harry avatar's runtime behaviour into a scene, with
 * per-avatar options (enable toggles, distance LOD, off-screen pause, a crowd budget).
 */

import type { AbstractMesh, Camera, Scene, TransformNode } from '@babylonjs/core'
import { DeclaredSpringBones, installTailMoodProbe } from './springs/DeclaredSpringBones.js'
import { installSurfaceJiggleProbe, SurfaceJiggleReader } from './springs/SurfaceJiggleReader.js'
import type { SpringBoneDeclaration } from './springs/springBoneDeclaration.js'
import { getVRoidSynthesisHook } from './vroidHook.js'
import type { HarryBudget, HarryBudgetEntry } from './budget.js'

export interface HarryLodOptions {
  /** Full rate within this camera distance (default 20). */
  near?: number
  /** Reduced rate between `near` and this distance; frozen beyond it (default 50). */
  far?: number
  /** Steps per second in the reduced band (default 15, minimum 5). */
  farHz?: number
  /** The camera to measure from (default: `scene.activeCameras[0] ?? scene.activeCamera`). */
  camera?: Camera
}

export interface HarryPhysicsOptions {
  /** A short label for console warnings (default 'avatar'). */
  label?: string
  /** Run the springs (default true). Toggle later with `setSpringsEnabled`. */
  springs?: boolean
  /** Run the surface jiggle (default true). Toggle later with `setJiggleEnabled`. */
  jiggle?: boolean
  /** Distance LOD. Absent (the default): no LOD, full rate at any distance. */
  lod?: HarryLodOptions
  /** Hold the springs while every mesh of the avatar is outside the camera frustum (default false). */
  pauseOffscreen?: boolean
  /** A crowd budget from `createHarryBudget`: only its nearest `maxActive` avatars simulate. */
  budget?: HarryBudget
  /** Install the `__tailMood()` / `__surfaceJiggle()` console probes on `globalThis` (default false). */
  debug?: boolean
}

export interface HarryPhysics {
  /** The running spring system, or null when the file declares no usable springs. */
  readonly springs: DeclaredSpringBones | null
  /** The surface-jiggle reader, or null when no spring carries `extras.poqpoq.surface`. */
  readonly jiggle: SurfaceJiggleReader | null
  /**
   * Springs off: the bones return to their bind rotations once and then follow only the
   * animation, with no drift. On: the chain resets onto the current pose (no snap). Surface
   * jiggle runs in lockstep with the springs, so springs off also rests the jiggle.
   */
  setSpringsEnabled(enabled: boolean): void
  /** Jiggle off: every morph weight goes back to 0. */
  setJiggleEnabled(enabled: boolean): void
  /** Replace the distance LOD; null = none (full rate at any distance). */
  setLod(lod: HarryLodOptions | null): void
  /** Turn the off-screen pause on or off. */
  setPauseOffscreen(enabled: boolean): void
  /** Detach everything (observers removed, budget entry released). Safe to call more than once. */
  dispose(): void
}

export const DEFAULT_LOD_NEAR = 20
export const DEFAULT_LOD_FAR = 50
export const DEFAULT_LOD_FAR_HZ = 15

/** Install the `__tailMood()` and `__surfaceJiggle()` console probes on `globalThis`. */
export function installHarryDebugGlobals(): void {
  installTailMoodProbe()
  installSurfaceJiggleProbe()
}

/** True when the avatar has drawable meshes and none of them is inside `camera`'s frustum. */
export function isOffscreen(meshes: readonly AbstractMesh[], camera: Camera | null | undefined): boolean {
  if (!camera) return false
  // isInFrustum reads the camera's cached matrices: make sure they are current (both are cheap
  // no-ops when already computed this frame).
  camera.getViewMatrix()
  camera.getProjectionMatrix()
  let drawable = 0
  for (const m of meshes) {
    if (!m.isEnabled() || !m.isVisible || m.getTotalVertices() === 0) continue
    drawable++
    if (camera.isInFrustum(m)) return false
  }
  return drawable > 0
}

/**
 * Wire a loaded Harry avatar's runtime behaviour into the scene.
 *
 * Call AFTER the GLB has loaded and its final transform (scale, rotation, position) — and any
 * static pose — is set, and BEFORE any clip plays: the spring runtime captures each joint's
 * rest from the scene at this moment.
 *
 * Order (identical to the reference host):
 *  1. springs the FILE declares (`VRMC_springBone`) win;
 *  2. a file that declares none but whose skeleton names VRoid spring bones (`J_Sec_*`,
 *     `J_Opt_*`) gets VRoid Studio's own settings synthesised — when the VRoid module is
 *     registered (the main `harry-babylon` entry registers it);
 *  3. surface jiggle (`extras.poqpoq.surface`) attaches beside the springs, in lockstep with
 *     them (it steps only when they advanced, with the same dt).
 *
 * Never throws for a file without springs: returns nulls.
 *
 * @param optionsOrLabel options, or (legacy form) just the label string
 */
export function attachHarryPhysics(
  root: TransformNode,
  scene: Scene,
  meshes: AbstractMesh[],
  optionsOrLabel?: string | HarryPhysicsOptions,
): HarryPhysics {
  const options: HarryPhysicsOptions = typeof optionsOrLabel === 'string' ? { label: optionsOrLabel } : (optionsOrLabel ?? {})
  const label = options.label ?? 'avatar'
  if (options.debug === true) installHarryDebugGlobals()

  const skeleton = meshes.find((m) => m.skeleton)?.skeleton ?? null
  // VRoid's spring bones: J_Sec_* (hair, skirt, bust, sleeves) and J_Opt_* (tails, ears).
  const hasSecBones = skeleton?.bones.some((b: { name: string }) => /^J_(Sec|Opt)_/.test(b.name)) ?? false

  let springs: DeclaredSpringBones | null = null
  let springDeclaration: SpringBoneDeclaration | null = null
  let fileDeclaresSprings = false
  try {
    const declared = DeclaredSpringBones.fromLoad(root, scene, label)
    fileDeclaresSprings = declared.declared
    springs = declared.springs
    springDeclaration = declared.declaration ?? null
  } catch (e) {
    // fromLoad throws only after it found and parsed a declaration.
    fileDeclaresSprings = true
    console.warn(`[springs] ${label}: VRMC_springBone declared but could not run (no springs play):`, e)
  }

  // A VRoid body whose file lost its VRMC_springBone runs on the same runtime, with the
  // declaration VRoid Studio would have written. Never used for a file that declares its springs.
  const vroidHook = getVRoidSynthesisHook()
  if (!fileDeclaresSprings && hasSecBones && vroidHook) {
    try {
      const vroid = vroidHook(root, scene, label)
      if (vroid) {
        springs = vroid.springs
        springDeclaration = vroid.declaration
      }
    } catch (e) {
      console.warn(`[springs] ${label}: VRoid spring synthesis failed (no springs play):`, e)
    }
  }

  // Hair AND soft-tissue jiggle through the same doorway. Attached AFTER the springs, so its
  // onBeforeRenderObservable runs after the spring step each frame; the springs are its lockstep.
  let jiggle: SurfaceJiggleReader | null = null
  if (springDeclaration && springs) {
    try {
      jiggle = SurfaceJiggleReader.attach(root, scene, meshes, springDeclaration.springs, springs, label)
    } catch (e) {
      console.warn(`[surface-jiggle] ${label}: could not attach (no surface jiggle plays):`, e)
    }
  }

  // --- options ---
  let springsOn = options.springs !== false
  let jiggleOn = options.jiggle !== false
  let lodCamera: Camera | null = options.lod?.camera ?? null
  let pauseOffscreen = options.pauseOffscreen === true
  let budgetEntry: HarryBudgetEntry | null = springs && options.budget ? options.budget.register(root) : null

  const applyJiggle = (): void => jiggle?.setEnabled(jiggleOn && springsOn)
  const applyLod = (lod: HarryLodOptions | null | undefined): void => {
    lodCamera = lod?.camera ?? null
    springs?.setLod(
      lod
        ? {
            near: lod.near ?? DEFAULT_LOD_NEAR,
            far: lod.far ?? DEFAULT_LOD_FAR,
            farHz: lod.farHz ?? DEFAULT_LOD_FAR_HZ,
            camera: lod.camera ?? null,
          }
        : null,
    )
  }
  const camera = (): Camera | null => lodCamera ?? scene.activeCameras?.[0] ?? scene.activeCamera

  if (springs) {
    applyLod(options.lod)
    springs.setHoldPredicate(() => (budgetEntry !== null && !budgetEntry.isActive()) || (pauseOffscreen && isOffscreen(meshes, camera())))
    springs.setEnabled(springsOn)
  }
  applyJiggle()

  let disposed = false
  return {
    springs,
    jiggle,
    setSpringsEnabled(enabled) {
      springsOn = enabled
      springs?.setEnabled(enabled)
      applyJiggle()
    },
    setJiggleEnabled(enabled) {
      jiggleOn = enabled
      applyJiggle()
    },
    setLod(lod) {
      applyLod(lod)
    },
    setPauseOffscreen(enabled) {
      pauseOffscreen = enabled
    },
    dispose() {
      if (disposed) return
      disposed = true
      budgetEntry?.dispose()
      budgetEntry = null
      springs?.dispose()
      jiggle?.dispose()
    },
  }
}
