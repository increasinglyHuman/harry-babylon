/**
 * Clip moves for the demo: load animation-only clip files, bind them to an avatar with the kit's
 * `bindClipToSkeleton`, and blend between the avatar's own walk and those clips with Babylon's
 * animation-group weights.
 *
 * Every transition is smooth: eased (smootherstep) weight fades, phase-aware entries (the hop
 * waits for the next foot plant, the squat for the feet passing, the walk resumes with its feet
 * together, the squat is left near its standing top), and a speed factor the circling root reads,
 * so travel ramps down into the squat and back up out of it. Physics is never reset here: the
 * springs carry their momentum through every transition.
 */
import { SceneLoader, type AnimationGroup, type Scene, type Skeleton } from '@babylonjs/core'
import { bindClipToSkeleton } from '../src/index.js'

/**
 * Load an animation-only GLB (no meshes) into a container and return its first group, stopped.
 * The group still targets the container's own nodes, which carry the clip donor's rest pose;
 * `bindClip` re-points a copy of it onto a real skeleton. Null (with a warning) when unavailable.
 */
export async function loadClip(url: string, scene: Scene): Promise<AnimationGroup | null> {
  try {
    const container = await SceneLoader.LoadAssetContainerAsync('', url, scene, undefined, '.glb')
    for (const g of container.animationGroups) g.stop()
    return container.animationGroups[0] ?? null
  } catch (e) {
    console.warn(`[demo] clip ${url} could not be loaded; that move falls back or is disabled.`, e)
    return null
  }
}

let cloneCount = 0

/**
 * A per-avatar copy of `source`, bound to `skeleton`. The copy has its own animations AND keys,
 * because binding re-points targets and rewrites keys (hip-height scale, rest-anchored clavicles).
 */
export function bindClip(source: AnimationGroup, skeleton: Skeleton, key: string): AnimationGroup {
  const group = source.clone(`${key}#${++cloneCount}`, (t) => t, true, true)
  const result = bindClipToSkeleton(group, skeleton, key, /* stripRootMotion */ false)
  if (result.skipped > 0) console.info(`[demo] ${key}: ${result.skipped} track(s) name bones this avatar does not have`, result.unboundSample)
  return group
}

/** Phases (fractions of a loop, 0..1) measured from the clips — see `measureClipPhases` in main.ts. */
export interface ClipPhases {
  /** Walk: the feet pass each other (feet together). */
  walkTogether: number[]
  /** Walk: a foot plants (the feet are furthest apart). */
  walkPlants: number[]
  /** Squat: standing tops (hip highest). */
  squatTops: number[]
}

/** Transition timings, seconds. */
export const TIMING = {
  hopIn: 0.25,
  hopOut: 0.35,
  squatIn: 0.7,
  squatOut: 0.7,
  /** Longest an entry waits for its phase before going anyway. */
  maxWait: 0.6,
}

/** Smootherstep: zero velocity AND acceleration at both ends, so a blend never kinks. */
export const ease = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

interface Fade {
  from: number
  to: number
  t: number
  duration: number
  onDone?: () => void
}

/** Weighted, phase-aware blends between an avatar's walk and its bound clips. */
export class Moves {
  private readonly fades = new Map<AnimationGroup, Fade>()
  private hopElapsed = -1
  private hopOutStarted = false
  private squatOn = false
  private paused = false
  /** A move waiting for its phase: seconds left, and what to do then. */
  private pending: { wait: number; run: () => void } | null = null
  /** Travel speed factor for the circling root: 1 walking, 0 squatting, ramps between. */
  private speed = { from: 1, to: 1, t: 0, duration: 0 }
  private carry = 0

  constructor(
    scene: Scene,
    private readonly walk: AnimationGroup | null,
    private readonly hopClip: AnimationGroup | null,
    private readonly squatClip: AnimationGroup | null,
    private readonly phases: ClipPhases,
  ) {
    // Weights only blend when set (−1 = unweighted): the walk owns the pose at weight 1.
    if (walk) walk.weight = 1
    scene.onBeforeAnimationsObservable.add(() => this.update(scene.getEngine().getDeltaTime() / 1000))
  }

  get canHop(): boolean {
    return this.hopClip !== null
  }

  get canSquat(): boolean {
    return this.squatClip !== null
  }

  /** The requested state (true from the press, through the entry wait and the fade). */
  get squatting(): boolean {
    return this.squatOn
  }

  /** The move on show: 'squat', 'hop', or the walk group's own name. */
  get current(): string {
    if (this.squatOn) return 'squat'
    if (this.hopElapsed >= 0) return 'hop'
    return this.walk?.name ?? 'none'
  }

  /** Multiplier for the root's travel speed this frame (ramps; a hop adds a little forward carry). */
  get speedFactor(): number {
    const s = this.speed
    const u = s.duration > 0 ? s.t / s.duration : 1
    return s.from + (s.to - s.from) * ease(u) + this.carry
  }

  /** Walk → hop → walk, once, starting on the next foot plant. False without a hop clip or in a squat. */
  hop(): boolean {
    const hop = this.hopClip
    if (!hop || this.squatOn) return false
    if (this.hopElapsed >= 0 || this.pending) return true
    this.whenWalkReaches(this.phases.walkPlants, 0, () => {
      hop.weight = 0
      hop.start(false, 1, hop.from, hop.to)
      this.hopElapsed = 0
      this.hopOutStarted = false
      this.fade(hop, 1, TIMING.hopIn)
      if (this.walk) this.fade(this.walk, 0, TIMING.hopIn)
    })
    return true
  }

  /** Blend into the squat (looping) or back to the walk. Returns the new requested state. */
  toggleSquat(): boolean {
    const squat = this.squatClip
    if (!squat || this.pending) return this.squatOn
    this.squatOn = !this.squatOn
    if (this.squatOn) {
      // Enter as the feet pass (the walk's most upright, both-feet-under moment), centred on the fade.
      this.whenWalkReaches(this.phases.walkTogether, TIMING.squatIn / 2, () => {
        if (this.hopElapsed >= 0) this.endHop()
        squat.weight = 0
        squat.start(true, 1, squat.from, squat.to)
        this.fade(squat, 1, TIMING.squatIn)
        if (this.walk) this.fade(this.walk, 0, TIMING.squatIn)
        this.rampSpeed(0, TIMING.squatIn)
      })
    } else {
      // Leave near the squat's standing top, and pick the walk up with its feet together.
      this.whenReaches(squat, this.phases.squatTops, TIMING.squatOut / 2, () => {
        const walk = this.walk
        if (walk) {
          const together = this.phases.walkTogether[0] ?? 0
          walk.goToFrame(walk.from + together * (walk.to - walk.from))
          this.fade(walk, 1, TIMING.squatOut)
        }
        this.fade(squat, 0, TIMING.squatOut, () => squat.stop())
        this.rampSpeed(1, TIMING.squatOut)
      })
    }
    return this.squatOn
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    for (const g of [this.walk, this.hopClip, this.squatClip]) {
      if (!g || !g.isStarted) continue
      if (paused) g.pause()
      else g.play(g === this.walk || g === this.squatClip)
    }
  }

  // --- internals ---------------------------------------------------------------------------------

  private phaseOf(group: AnimationGroup): number {
    const frame = group.animatables[0]?.masterFrame ?? group.from
    const span = group.to - group.from
    return span > 0 ? (((frame - group.from) / span) % 1 + 1) % 1 : 0
  }

  private secondsOf(group: AnimationGroup): number {
    const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 60
    return (group.to - group.from) / fps / Math.max(1e-6, group.speedRatio)
  }

  /**
   * Run `run` when `group` is `lead` seconds before the next of `phases` (so a fade of 2·lead is
   * centred on it). Runs at once without a playing group or phases; never waits longer than maxWait.
   */
  private whenReaches(group: AnimationGroup | null, phases: number[], lead: number, run: () => void): void {
    if (!group || !group.isPlaying || phases.length === 0) {
      run()
      return
    }
    const loop = this.secondsOf(group)
    const now = this.phaseOf(group)
    let best = Infinity
    for (const p of phases) {
      let wait = ((p - now) * loop - lead) % loop
      if (wait < 0) wait += loop
      best = Math.min(best, wait)
    }
    if (best > TIMING.maxWait || best < 1e-3) {
      run()
      return
    }
    this.pending = { wait: best, run }
  }

  private whenWalkReaches(phases: number[], lead: number, run: () => void): void {
    this.whenReaches(this.walk, phases, lead, run)
  }

  private fade(group: AnimationGroup, to: number, duration: number, onDone?: () => void): void {
    this.fades.set(group, { from: Math.max(0, group.weight), to, t: 0, duration, onDone })
  }

  private rampSpeed(to: number, duration: number): void {
    this.speed = { from: this.speedFactor - this.carry, to, t: 0, duration }
  }

  private endHop(): void {
    const hop = this.hopClip!
    hop.stop()
    hop.weight = 0
    this.fades.delete(hop)
    this.hopElapsed = -1
    this.carry = 0
  }

  private update(dt: number): void {
    if (this.paused || !(dt > 0)) return
    if (this.pending) {
      this.pending.wait -= dt
      if (this.pending.wait <= 0) {
        const run = this.pending.run
        this.pending = null
        run()
      }
    }
    if (this.speed.t < this.speed.duration) this.speed.t = Math.min(this.speed.duration, this.speed.t + dt)

    const hop = this.hopClip
    if (hop && this.hopElapsed >= 0) {
      this.hopElapsed += dt
      const duration = this.secondsOf(hop)
      // A little forward carry while airborne: a bump over the hop's middle.
      const u = Math.min(1, this.hopElapsed / duration)
      this.carry = 0.35 * Math.sin(Math.PI * u) ** 2
      if (!this.hopOutStarted && this.hopElapsed >= duration - TIMING.hopOut) {
        this.hopOutStarted = true
        this.fade(hop, 0, TIMING.hopOut)
        if (this.walk) this.fade(this.walk, 1, TIMING.hopOut)
      }
      if (this.hopElapsed >= duration) this.endHop()
    }

    for (const [group, f] of this.fades) {
      f.t = Math.min(f.duration, f.t + dt)
      const u = f.duration > 0 ? f.t / f.duration : 1
      group.weight = f.from + (f.to - f.from) * ease(u)
      if (u >= 1) {
        this.fades.delete(group)
        f.onDone?.()
      }
    }
  }
}
