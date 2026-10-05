/**
 * surfaceJiggleDeclaration — parse `springs[i].extras.poqpoq.surface` (Harry's
 * extras namespace): the bounce leaf's velocity drives a handful of modal
 * oscillators whose saturated weights are written to sparse morph targets —
 * soft-tissue jiggle (chest/belly/glutes) AND attached hair (`jiggle-Hair`),
 * through the SAME doorway: one reader covers chest, glutes and hair.
 *
 * The block's shape is Harry's surface-jiggle export (hair uses the same
 * shape, no extra fields), and the oscillator arithmetic matches Harry's
 * preview.
 *
 * It sits BESIDE the spring's own `extras.poqpoq.drive` (springDrive.ts),
 * never inside it — same `isObj(extras) && isObj(extras.poqpoq)` door, a
 * different key. Anything the file gets wrong is reported by name and the
 * MODE is skipped (never the drive) — a file fails safe to the rest shape,
 * the same convention as springBoneDeclaration.ts and springDrive.ts.
 *
 * ONE responsibility: JSON in, validated numbers out. No Babylon here — the
 * node/mesh resolution and the per-frame math live in SurfaceJiggleReader.ts.
 */

export interface SurfaceJiggleModeDeclaration {
  /** The morph target this mode drives (world-mesh scan, e.g. `surface.Hair.1`). */
  readonly target: string
  readonly freqHz: number
  readonly zeta: number
  /** Peak displacement cap, metres (tanh saturation) — must be > 0. */
  readonly max: number
  /** Per-axis kick weight, in the `owner` bind frame. */
  readonly participation: readonly [number, number, number]
}

export interface SurfaceJiggleDeclaration {
  readonly version: 1
  /** The bounce leaf's tip — a node name in the loaded scene. */
  readonly tip: string
  /** The bone whose BIND frame the participation vectors are in — a node name. */
  readonly owner: string
  /** The region's Jiggle control as authored; 0 is a valid "declared but silent" value. */
  readonly gain: number
  readonly modes: readonly SurfaceJiggleModeDeclaration[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isParticipation = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isFiniteNum)

/**
 * Parse one mode entry. Returns null (with a named reason via `onWarn`) when
 * malformed — that mode is dropped, the rest of the declaration still plays.
 */
function parseMode(m: unknown, index: number, onWarn: (reason: string) => void): SurfaceJiggleModeDeclaration | null {
  const bad = (why: string): null => {
    onWarn(`mode #${index} ignored (${why})`)
    return null
  }
  if (!isObj(m)) return bad('not an object')
  if (!isNonEmptyString(m.target)) return bad('target')
  if (!isFiniteNum(m.freqHz) || !(m.freqHz > 0)) return bad('freqHz (must be > 0)')
  // Matches modalOscillator's own refusal domain (0 < ζ < 1 — it must ring, and never invert via overdamping).
  if (!isFiniteNum(m.zeta) || !(m.zeta > 0) || !(m.zeta < 1)) return bad('zeta (must be in (0, 1))')
  if (!isFiniteNum(m.max) || !(m.max > 0)) return bad('max (must be > 0 — the render cap, metres)')
  if (!isParticipation(m.participation)) return bad('participation (needs 3 finite numbers)')
  return { target: m.target, freqHz: m.freqHz, zeta: m.zeta, max: m.max, participation: m.participation }
}

/**
 * Parse `springs[i].extras.poqpoq.surface`. Returns null (with a named reason
 * via `onWarn`) when the block is absent or too broken to run at all — the
 * spring then plays its rest shape, exactly (no reader, no `surface.*` reader
 * at all, is the same outcome by design).
 */
export function parseSurfaceJiggle(extras: unknown, onWarn: (reason: string) => void = () => {}): SurfaceJiggleDeclaration | null {
  const s = isObj(extras) && isObj(extras.poqpoq) ? extras.poqpoq.surface : undefined
  if (s === undefined) return null
  const bad = (why: string): null => {
    onWarn(`poqpoq.surface ignored (${why}) — the spring plays its bounce only`)
    return null
  }
  if (!isObj(s)) return bad('not an object')
  if (s.version !== 1) return bad(`unknown version "${String(s.version)}"`)
  if (!isNonEmptyString(s.tip)) return bad('tip')
  if (!isNonEmptyString(s.owner)) return bad('owner')
  if (!isFiniteNum(s.gain)) return bad('gain')
  if (!Array.isArray(s.modes) || s.modes.length === 0) return bad('modes (needs at least one)')
  const modes: SurfaceJiggleModeDeclaration[] = []
  s.modes.forEach((m, i) => {
    const parsed = parseMode(m, i, (why) => onWarn(`poqpoq.surface: ${why}`))
    if (parsed) modes.push(parsed)
  })
  if (modes.length === 0) return bad('every mode was malformed')
  return { version: 1, tip: s.tip, owner: s.owner, gain: s.gain, modes }
}
