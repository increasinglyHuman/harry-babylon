/**
 * springDrive — the layered drive a file declares beside `VRMC_springBone`
 * (design rule: "the spring follows the animation").
 *
 * ONE responsibility: the engine-free half. Parse `springs[i].extras.poqpoq.drive`,
 * and evaluate the mood set it names (`tail-moods@1`) from the table THE FILE
 * carries — per-bone yaw/pitch angles, per-joint gains, the mood cross-fade.
 * The runtime composes quaternions and runs the solver.
 *
 * Why beside the standard: plain VRMC_springBone writes each joint's rotation
 * from its REST (`initialLocalRotation · fromTo(...)`), discarding any
 * animation on the joint — no authored tail key, no wag, no mood survives. The
 * drive re-seats each joint's target to animated ⊕ mood every step, then adds
 * a muscle (a half-life gain toward the target) and a cone limit.
 *
 * The arithmetic (`moodAngles`, `moodGains`, `moodFade`, and the
 * mood-quaternion step) matches Harry's own three.js tail drive, so a tail
 * plays the same in Harry's preview and in Babylon.
 */

import type { Vec3Tuple } from './springBoneDeclaration.js'

export const TAIL_MOODS = ['wag', 'lash', 'tuck', 'still', 'twitch', 'loose'] as const
export type TailMood = (typeof TAIL_MOODS)[number]
export const TAIL_MOOD_SET = 'tail-moods@1'
/** Seconds a mood change cross-fades over (smoothstep on angles AND gains). */
export const TAIL_MOOD_FADE_SECONDS = 0.25

export interface MoodDefinition {
  gain: { base: number; mid: number; tip: number }
  /** Held carriage: total pitch in degrees (+ = DOWN), spread over the proximal `carriageReach` of the chain. */
  pitchDeg: number
  carriageReach: number
  /** Base oscillator (yaw) on the first `joints` bones only — the spring carries the wave. */
  osc?: { ampDeg: number; hz: number; lagRad: number; sharpness: number; burstHz: number; joints: number }
  /** A tip-only yaw twitch over t ≥ `from`: a sine (`hz`) or pulses (`cycleS`, `at`, `widthS`). */
  twitch?: { ampDeg: number; from: number; hz?: number; cycleS?: number; at?: number[]; widthS?: number }
}

export interface WagKnobs {
  amplitudeDeg: number
  hz: number
  bias: number
}

export interface SpringDynamics {
  stepHz: number
  tightHalfLifeS: number
  maxDegPerS: number
  muscleMomentum: number
  coneDeg: number
  inertia: number
  maxInheritSpeed: number
  maxInheritDegPerS: number
  maxParticleSpeed: number
  teleportMeters: number
  teleportDeg: number
  reflex: { gainS: number; maxDeg: number; smoothHalfLifeS: number; joints: number }
}

export interface SpringDrive {
  mood: TailMood
  muscle: number
  wag: WagKnobs
  reflex: boolean
  /** Per sprung joint, for the declared mood (recorded by Harry; cross-checked, never trusted over the table). */
  gains: number[]
  dynamics: SpringDynamics
  moods: Record<TailMood, MoodDefinition>
  /** Per chain bone (root → tip): yaw (body up) and pitch (down) axes in the bone's LOCAL bind frame. */
  axes: { yaw: Vec3Tuple; pitch: Vec3Tuple }[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const unit = (v: Vec3Tuple): Vec3Tuple => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
const isVec3 = (v: unknown): v is Vec3Tuple => Array.isArray(v) && v.length === 3 && v.every(isNum)

function isMood(v: unknown): v is TailMood {
  return typeof v === 'string' && (TAIL_MOODS as readonly string[]).includes(v)
}

function checkMood(m: unknown): string | null {
  if (!isObj(m) || !isObj(m.gain) || !isNum(m.pitchDeg) || !isNum(m.carriageReach) || m.carriageReach <= 0) return 'gain/pitchDeg/carriageReach'
  const g = m.gain
  if (!isNum(g.base) || !isNum(g.mid) || !isNum(g.tip)) return 'gain profile'
  if (m.osc !== undefined) {
    const o = m.osc
    if (!isObj(o) || ![o.ampDeg, o.hz, o.lagRad, o.sharpness, o.burstHz, o.joints].every(isNum)) return 'osc'
    // Strictly positive where the formula divides or takes a period (a zero would poison the target with NaN).
    if ((o.joints as number) < 1 || (o.hz as number) <= 0 || (o.sharpness as number) <= 0 || (o.burstHz as number) < 0) return 'osc (joints ≥ 1, hz > 0, sharpness > 0, burstHz ≥ 0)'
  }
  if (m.twitch !== undefined) {
    const t = m.twitch
    if (!isObj(t) || !isNum(t.ampDeg) || !isNum(t.from) || t.from < 0 || t.from >= 1) return 'twitch'
    // The evaluator takes the sine branch whenever `hz` is present, so a present `hz` must itself be valid.
    if (t.hz !== undefined && !(isNum(t.hz) && t.hz > 0)) return 'twitch (hz, when present, must be > 0)'
    const pulses = isNum(t.cycleS) && t.cycleS > 0 && Array.isArray(t.at) && t.at.every(isNum) && isNum(t.widthS) && t.widthS > 0
    const sine = isNum(t.hz)
    if (!sine && !pulses) return 'twitch (needs hz > 0, or cycleS > 0 + at + widthS > 0)'
  }
  return null
}

/**
 * Parse `springs[i].extras.poqpoq.drive` for a chain of `bones` bones. Returns
 * null (with a named reason via `onWarn`) when absent or malformed — the
 * spring then plays passive, which is correct, just inexpressive.
 */
export function parseSpringDrive(extras: unknown, bones: number, onWarn: (m: string) => void = () => {}): SpringDrive | null {
  const d = isObj(extras) && isObj(extras.poqpoq) ? extras.poqpoq.drive : undefined
  if (d === undefined) return null
  const bad = (why: string): null => {
    onWarn(`poqpoq.drive ignored (${why}) — the spring plays passive`)
    return null
  }
  if (!isObj(d)) return bad('not an object')
  if (d.target !== 'animated-pose') return bad(`target "${String(d.target)}"`)
  if (d.moodSet !== TAIL_MOOD_SET) return bad(`unknown moodSet "${String(d.moodSet)}"`)
  if (!isMood(d.mood)) return bad(`unknown mood "${String(d.mood)}"`)
  if (!isNum(d.muscle) || d.muscle < 0 || d.muscle > 1) return bad('muscle')
  const w = d.wag
  if (!isObj(w) || !isNum(w.amplitudeDeg) || !isNum(w.hz) || !isNum(w.bias)) return bad('wag')
  // The wag knobs REPLACE the wag mood's oscillator hz, so the same domain applies.
  if (w.hz <= 0) return bad('wag.hz (must be > 0)')
  if (typeof d.reflex !== 'boolean') return bad('reflex')
  if (!Array.isArray(d.gains) || !d.gains.every(isNum) || d.gains.length !== bones - 1) return bad(`gains (need ${bones - 1})`)
  const y = d.dynamics
  const dynKeys = ['stepHz', 'tightHalfLifeS', 'maxDegPerS', 'muscleMomentum', 'coneDeg', 'inertia', 'maxInheritSpeed', 'maxInheritDegPerS', 'maxParticleSpeed', 'teleportMeters', 'teleportDeg'] as const
  if (!isObj(y) || !dynKeys.every((k) => isNum(y[k]))) return bad('dynamics')
  const r = y.reflex
  if (!isObj(r) || ![r.gainS, r.maxDeg, r.smoothHalfLifeS, r.joints].every(isNum)) return bad('dynamics.reflex')
  // Each formula's domain: a divisor, a period, a speed cap or a half-life must be > 0;
  // a share must lie in [0, 1]; the cone in (0, 180]. A value outside it poisons the chain with NaN.
  const Y = y as Record<string, number>
  const R = r as Record<string, number>
  const positive = ['stepHz', 'tightHalfLifeS', 'maxDegPerS', 'maxInheritSpeed', 'maxInheritDegPerS', 'maxParticleSpeed', 'teleportMeters', 'teleportDeg']
  const outOfRange = [
    ...positive.filter((k) => !(Y[k] > 0)),
    ...(['muscleMomentum', 'inertia'] as const).filter((k) => !(Y[k] >= 0 && Y[k] <= 1)),
    ...(Y.coneDeg > 0 && Y.coneDeg <= 180 ? [] : ['coneDeg']),
    ...(R.gainS >= 0 ? [] : ['reflex.gainS']),
    ...(R.maxDeg >= 0 ? [] : ['reflex.maxDeg']),
    ...(R.smoothHalfLifeS > 0 ? [] : ['reflex.smoothHalfLifeS']),
    ...(Number.isInteger(R.joints) && R.joints >= 1 ? [] : ['reflex.joints']),
  ]
  if (outOfRange.length > 0) return bad(`dynamics out of range: ${outOfRange.join(', ')}`)
  if (!isObj(d.moods)) return bad('moods')
  for (const m of TAIL_MOODS) {
    const why = checkMood(d.moods[m])
    if (why) return bad(`mood "${m}": ${why}`)
  }
  if (!Array.isArray(d.axes) || d.axes.length !== bones || !d.axes.every((a) => isObj(a) && isVec3(a.yaw) && isVec3(a.pitch))) {
    return bad(`axes (need ${bones})`)
  }
  // fromAxisAngle assumes UNIT axes: a zero axis is refused, a non-unit one normalised.
  if ((d.axes as { yaw: Vec3Tuple; pitch: Vec3Tuple }[]).some((a) => Math.hypot(...a.yaw) < 1e-6 || Math.hypot(...a.pitch) < 1e-6)) {
    return bad('axes (a zero-length axis)')
  }
  return {
    mood: d.mood,
    muscle: d.muscle,
    wag: { amplitudeDeg: w.amplitudeDeg, hz: w.hz, bias: w.bias },
    reflex: d.reflex,
    gains: d.gains as number[],
    dynamics: { ...(y as unknown as SpringDynamics), reflex: { ...(r as unknown as SpringDynamics['reflex']) } },
    moods: d.moods as unknown as Record<TailMood, MoodDefinition>,
    axes: (d.axes as { yaw: Vec3Tuple; pitch: Vec3Tuple }[]).map((a) => ({ yaw: unit(a.yaw), pitch: unit(a.pitch) })),
  }
}

// --- tail-moods@1, evaluated from the file's table ---

const RAD = Math.PI / 180

/** Per-bone shares (summing to 1) of a profile over `n` bones, t = k/(n−1). */
function shares(n: number, profile: (t: number, k: number) => number): number[] {
  const raw = Array.from({ length: n }, (_, k) => profile(n === 1 ? 0 : k / (n - 1), k))
  const sum = raw.reduce((a, b) => a + b, 0)
  return sum === 0 ? raw : raw.map((v) => v / sum)
}

/** A bump of width `w` seconds centred at `c`, sin² shaped, 0 elsewhere. */
function bump(t: number, c: number, w: number): number {
  const u = (t - c) / w + 0.5
  return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) ** 2
}

/** One mood's per-bone angles at time `t` (radians), root → tip, over `n` bones. */
export function moodAngles(table: Record<TailMood, MoodDefinition>, mood: TailMood, t: number, n: number, wag: WagKnobs): { yaw: number[]; pitch: number[] } {
  const def = table[mood]
  const yaw = Array.from({ length: n }, () => 0)
  const pitch = shares(n, (u) => Math.max(0, 1 - u / def.carriageReach)).map((s) => def.pitchDeg * RAD * s)
  if (def.osc !== undefined) {
    const o = mood === 'wag' ? { ...def.osc, ampDeg: wag.amplitudeDeg, hz: wag.hz } : def.osc
    const bias = mood === 'wag' ? wag.bias : 0
    const driven = Math.min(o.joints, n)
    const s = shares(n, (_, k) => (k < driven ? driven - k : 0))
    const envelope = o.burstHz > 0 ? 0.55 + 0.45 * Math.sin(2 * Math.PI * o.burstHz * t) : 1
    s.forEach((sk, k) => {
      if (sk === 0) return
      const w = Math.sin(2 * Math.PI * o.hz * t - k * o.lagRad)
      const shaped = o.sharpness === 1 ? w : Math.sign(w) * Math.abs(w) ** o.sharpness
      yaw[k] = o.ampDeg * RAD * sk * envelope * (shaped + 0.5 * bias)
    })
  }
  if (def.twitch !== undefined) {
    const tw = def.twitch
    let drive = 0
    if (tw.hz !== undefined) drive = Math.sin(2 * Math.PI * tw.hz * t)
    else if (tw.cycleS !== undefined && tw.at !== undefined && tw.widthS !== undefined) {
      const phase = ((t % tw.cycleS) + tw.cycleS) % tw.cycleS
      tw.at.forEach((c, i) => (drive += (i % 2 === 0 ? 1 : -1) * bump(phase, c, tw.widthS!)))
    }
    shares(n, (u) => Math.max(0, (u - tw.from) / (1 - tw.from))).forEach((sk, k) => (yaw[k] = yaw[k] + tw.ampDeg * RAD * sk * drive))
  }
  return { yaw, pitch }
}

/** Per-sprung-joint gains in [0, 1]: the mood's base/mid/tip profile, piecewise linear, × the muscle knob. */
export function moodGains(table: Record<TailMood, MoodDefinition>, mood: TailMood, muscle: number, joints: number): number[] {
  const g = table[mood].gain
  return Array.from({ length: joints }, (_, k) => {
    const t = joints <= 1 ? 0 : k / joints
    const p = t <= 0.5 ? g.base + (g.mid - g.base) * (t / 0.5) : g.mid + (g.tip - g.mid) * ((t - 0.5) / 0.5)
    return Math.min(1, 2 * muscle * p)
  })
}

/** Smoothstep 0 → 1 over the fade. */
export function moodFade(since: number): number {
  const s = Math.min(1, Math.max(0, since / TAIL_MOOD_FADE_SECONDS))
  return s * s * (3 - 2 * s)
}

/**
 * The drive's live settings: the declared starting mood, a mood INPUT the host
 * may set (character affect, an emote), and the cross-fade between them in
 * the runtime's step clock.
 */
/**
 * A mood and the transition INTO it: while `since` is within the fade, this
 * state blends from `from` (itself a state — possibly still mid-fade) to `mood`.
 * A mood set during a fade therefore starts from the blend the tail is
 * actually wearing, never from the previous destination.
 */
interface MoodState {
  mood: TailMood
  from: MoodState | null
  since: number
  /** A collapsed history: the blend that was being worn when the fade chain was truncated, held fixed. */
  frozen?: { yaw: number[]; pitch: number[]; gains: number[] }
}

/** Deepest chain of unfinished fades kept; older ones collapse onto their destination. */
const MAX_FADE_DEPTH = 4

/**
 * The drive's live settings: the declared starting mood, a mood INPUT the host
 * may set (character affect, an emote), and the cross-fade between them in
 * the runtime's step clock.
 */
export class DriveState {
  private state: MoodState

  constructor(readonly drive: SpringDrive) {
    this.state = { mood: drive.mood, from: null, since: -Infinity }
  }

  get mood(): TailMood {
    return this.state.mood
  }

  /** Change mood at simulation time `seconds`; angles AND gains cross-fade over 0.25 s from the current blend. */
  setMood(mood: TailMood, seconds: number): void {
    if (mood === this.state.mood && !this.state.frozen) return
    this.state = { mood, from: this.state, since: seconds }
    // Bound the chain: a finished fade is fully at its destination (cut it); past
    // MAX_FADE_DEPTH, the older history is COLLAPSED into the blend it evaluates to
    // right now — frozen, and fading out — never cut, which would jump.
    const bones = this.drive.axes.length
    let s: MoodState = this.state
    for (let depth = 1; s.from; depth++) {
      if (moodFade(seconds - s.since) >= 1) {
        s.from = null
        break
      }
      if (depth >= MAX_FADE_DEPTH) {
        const worn = this.evaluate(s.from, seconds, bones, bones - 1)
        s.from = { mood: s.from.mood, from: null, since: -Infinity, frozen: worn }
        break
      }
      s = s.from
    }
  }

  /** At `seconds`: per-bone yaw/pitch angles (root → tip) and per-joint gains. */
  sample(seconds: number, bones: number, yaw: number[], pitch: number[], gains: number[]): void {
    const out = this.evaluate(this.state, seconds, bones, gains.length)
    for (let k = 0; k < bones; k++) {
      yaw[k] = out.yaw[k]
      pitch[k] = out.pitch[k]
    }
    for (let k = 0; k < gains.length; k++) gains[k] = out.gains[k]
  }

  private evaluate(s: MoodState, seconds: number, bones: number, joints: number): { yaw: number[]; pitch: number[]; gains: number[] } {
    if (s.frozen) return s.frozen
    const { moods, wag, muscle } = this.drive
    const b = moodAngles(moods, s.mood, seconds, bones, wag)
    const bg = moodGains(moods, s.mood, muscle, joints)
    const f = s.from ? moodFade(seconds - s.since) : 1
    if (f >= 1 || !s.from) return { yaw: b.yaw, pitch: b.pitch, gains: bg }
    const a = this.evaluate(s.from, seconds, bones, joints)
    return {
      yaw: b.yaw.map((v, k) => a.yaw[k] + (v - a.yaw[k]) * f),
      pitch: b.pitch.map((v, k) => a.pitch[k] + (v - a.pitch[k]) * f),
      gains: bg.map((v, k) => a.gains[k] + (v - a.gains[k]) * f),
    }
  }
}
