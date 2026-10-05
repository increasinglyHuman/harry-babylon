/**
 * createHarryBudget — a scene-level crowd budget. Avatars attached with `options.budget` are
 * ranked by camera distance every `everyNFrames` frames; only the nearest `maxActive` simulate,
 * the rest are held (and reset onto their current pose when they become active again).
 */

import { Vector3, type Camera, type Nullable, type Observer, type Scene, type TransformNode } from '@babylonjs/core'

export interface HarryBudgetOptions {
  /** How many avatars may simulate at once. */
  maxActive: number
  /** The camera to rank from (default: `scene.activeCameras[0] ?? scene.activeCamera`). */
  camera?: Camera
  /** Re-rank every this many frames (default 30). */
  everyNFrames?: number
}

export interface HarryBudgetEntry {
  isActive(): boolean
  dispose(): void
}

export interface HarryBudget {
  maxActive: number
  /** Register an avatar root (attachHarryPhysics does this for `options.budget`). */
  register(root: TransformNode): HarryBudgetEntry
  /** Re-rank now (also runs on its own every `everyNFrames` frames). */
  rank(): void
  /** How many registered avatars are active after the last ranking. */
  readonly activeCount: number
  /** How many avatars are registered. */
  readonly size: number
  dispose(): void
}

interface Entry {
  root: TransformNode
  active: boolean
  distSq: number
}

export function createHarryBudget(scene: Scene, options: HarryBudgetOptions): HarryBudget {
  const entries: Entry[] = []
  const every = Math.max(1, Math.round(options.everyNFrames ?? 30))
  let frame = 0
  let observer: Nullable<Observer<Scene>> = null

  const budget: HarryBudget = {
    maxActive: Math.max(0, Math.floor(options.maxActive)),
    register(root) {
      const e: Entry = { root, active: false, distSq: Infinity }
      entries.push(e)
      budget.rank()
      return {
        isActive: () => e.active,
        dispose: () => {
          const i = entries.indexOf(e)
          if (i >= 0) {
            entries.splice(i, 1)
            budget.rank()
          }
        },
      }
    },
    rank() {
      const camera = options.camera ?? scene.activeCameras?.[0] ?? scene.activeCamera
      for (const e of entries) e.distSq = camera ? Vector3.DistanceSquared(camera.globalPosition, e.root.getAbsolutePosition()) : 0
      // Stable: ties keep registration order.
      const order = entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.distSq - b.e.distSq || a.i - b.i)
      order.forEach(({ e }, k) => (e.active = k < budget.maxActive))
    },
    get activeCount() {
      return entries.filter((e) => e.active).length
    },
    get size() {
      return entries.length
    },
    dispose() {
      if (observer) {
        scene.onBeforeAnimationsObservable.remove(observer)
        observer = null
      }
      for (const e of entries) e.active = false
      entries.length = 0
    },
  }
  // Before animations (and so before every avatar's spring observer), so a new ranking applies this frame.
  observer = scene.onBeforeAnimationsObservable.add(() => {
    if (++frame % every === 0) budget.rank()
  })
  return budget
}
