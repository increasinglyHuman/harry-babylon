/// <reference types="vite/client" />
/**
 * harry-babylon demo: load a Harry-exported avatar, play its own walk clip, walk it around a
 * circle (the root motion is what the tail, ears and soft tissue react to), and attach the runtime
 * physics on top. Separate animation-only clip files (hop, squat) are bound to the avatar with
 * `bindClipToSkeleton` and crossfaded in. "Spawn crowd" adds 20 more walkers under a crowd budget
 * plus a distance LOD.
 *
 * The assets are NOT distributed with this repository. The avatar loads from `?avatar=<url>`, else
 * `VITE_HARRY_DEMO_AVATAR`, else `./assets/lemur.glb`; the clips from `?hop=` / `?squat=`, else
 * `./assets/clips/hop.glb` and `./assets/clips/squat.glb` (see the README's "Demo assets").
 */
import {
  ArcRotateCamera,
  Engine,
  Matrix,
  Quaternion,
  SceneInstrumentation,
  Scene,
  SceneLoader,
  Space,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type AnimationGroup,
  type AssetContainer,
  type Node,
  type Skeleton,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF/2.0/index.js'
import {
  attachHarryPhysics,
  createHarryBudget,
  registerSpringBoneSource,
  takeSpringBoneSource,
  TAIL_MOODS,
  type HarryPhysics,
  type SpringBoneSource,
  type TailMood,
} from '../src/index.js'
import { createHarryStage, VIEW_DIRECTION } from './stage.js'
import { bindClip, ease, loadClip, Moves, type ClipPhases } from './moves.js'
import pkg from '../package.json'

const AVATAR_URL =
  new URLSearchParams(location.search).get('avatar') ||
  (import.meta.env.VITE_HARRY_DEMO_AVATAR as string | undefined) ||
  new URL('./assets/lemur.glb', import.meta.url).href
const HOP_URL = new URLSearchParams(location.search).get('hop') || new URL('./assets/clips/hop.glb', import.meta.url).href
const SQUAT_URL = new URLSearchParams(location.search).get('squat') || new URL('./assets/clips/squat.glb', import.meta.url).href

const canvas = document.getElementById('view') as HTMLCanvasElement
const status = document.getElementById('status') as HTMLDivElement
;(document.getElementById('version') as HTMLElement).textContent = `harry-babylon v${pkg.version}`
;(document.getElementById('aboutVersion') as HTMLElement).textContent = `harry-babylon v${pkg.version}`
{
  const about = document.getElementById('about') as HTMLDialogElement
  ;(document.getElementById('aboutOpen') as HTMLButtonElement).onclick = () => about.showModal()
}
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
const scene = new Scene(engine)

// Harry's stage: Neutral tone mapping, IBL fill, an off-axis key with soft shadows, the dark pool.
const q = new URLSearchParams(location.search)
const num = (k: string): number | undefined => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined)
const stage = createHarryStage(scene, { size: 10, poolRadius: 4.2, keyIntensity: num('key'), environmentIntensity: num('env') })

// The default 3/4 view, as Harry frames a subject (its view direction, 50° vertical FOV).
const camera = new ArcRotateCamera(
  'camera',
  Math.atan2(VIEW_DIRECTION.z, VIEW_DIRECTION.x),
  Math.acos(VIEW_DIRECTION.y / VIEW_DIRECTION.length()),
  4,
  new Vector3(0, 0.6, 0),
  scene,
)
camera.fov = (50 * Math.PI) / 180
camera.minZ = 0.02
camera.attachControl(canvas, true)
camera.wheelPrecision = 40
camera.lowerRadiusLimit = 0.5
// The key rides with the camera, as Harry seats it on a framed subject: over the camera's shoulder.
stage.lightFrom(camera)

const instrumentation = new SceneInstrumentation(scene)
instrumentation.captureFrameTime = true

/** The demo floor is y = 0 in world space; tails rest on it instead of passing through. */
const FLOOR = () => ({ point: Vector3.Zero(), normal: Vector3.Up() })

// --- Loading once, instancing many ------------------------------------------------------------

interface Template {
  container: AssetContainer
  root: TransformNode
  source: SpringBoneSource | null
  height: number
  hasClip: boolean
}

interface Instance {
  root: TransformNode
  meshes: AbstractMesh[]
  skeleton: Skeleton | null
  clip: AnimationGroup | null
  dispose(): void
}

async function loadTemplate(url: string): Promise<Template> {
  const container = await SceneLoader.LoadAssetContainerAsync('', url, scene, undefined, '.glb')
  for (const g of container.animationGroups) g.stop()
  const root = container.meshes[0] as unknown as TransformNode
  // The loader extension filed the file's VRMC_springBone under this root. Take it once; each
  // instance gets it re-filed against its own cloned nodes in spawn().
  const source = takeSpringBoneSource(root)
  const hasClip = container.animationGroups.length > 0
  // A file with a clip lets the clip own the arms; only a clip-less file gets its T-pose relaxed.
  if (!hasClip) relaxArms(root)
  const { min, max } = root.getHierarchyBoundingVectors(true)
  root.position.y -= min.y
  return { container, root, source, height: max.y - min.y, hasClip }
}

const kids = (n: Node): Node[] => n.getChildren(undefined, true)

/** Instantiate the template (meshes, skeleton and animation group cloned) and re-file its springs. */
function spawn(t: Template): Instance {
  const inst = t.container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true })
  const root = inst.rootNodes[0] as TransformNode
  for (const g of inst.animationGroups) g.stop()
  if (t.source) {
    const map = new Map<Node, Node>()
    const walk = (a: Node, b: Node): void => {
      map.set(a, b)
      const ka = kids(a)
      const kb = kids(b)
      ka.forEach((c, i) => kb[i] && walk(c, kb[i]!))
    }
    walk(t.root, root)
    const nodes = t.source.nodes.map((n) => (n ? ((map.get(n) as TransformNode | undefined) ?? null) : null))
    if (nodes.some((n, i) => n?.name !== t.source!.nodes[i]?.name)) console.warn('[demo] clone node table does not line up with the template')
    registerSpringBoneSource(root, { extension: t.source.extension, nodes })
  }
  const meshes = root.getChildMeshes(false)
  return {
    root,
    meshes,
    skeleton: meshes.find((m) => m.skeleton)?.skeleton ?? inst.skeletons[0] ?? null,
    clip: inst.animationGroups[0] ?? null,
    dispose: () => inst.dispose(),
  }
}

function findNode(root: TransformNode, pattern: RegExp): TransformNode | null {
  return (root.getDescendants(false, (d) => pattern.test(d.name))[0] as TransformNode | undefined) ?? null
}

/** Fractions of a loop where a sampled series crosses zero (interpolated). */
function zeroCrossings(xs: number[]): number[] {
  const out: number[] = []
  const n = xs.length - 1 // the last sample repeats the first (a loop)
  for (let i = 0; i < n; i++) {
    const a = xs[i]!
    const b = xs[i + 1]!
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) out.push((i + a / (a - b)) / n)
  }
  return out
}

/** Fractions of a loop at the local extrema of a looping series (maxima and/or minima). */
function extrema(xs: number[], kind: 'max' | 'min' | 'both'): number[] {
  const out: number[] = []
  const n = xs.length - 1
  for (let i = 0; i < n; i++) {
    const prev = xs[(i - 1 + n) % n]!
    const cur = xs[i]!
    const next = xs[(i + 1) % n]!
    const isMax = cur >= prev && cur > next
    const isMin = cur <= prev && cur < next
    if ((kind !== 'min' && isMax) || (kind !== 'max' && isMin)) out.push(i / n)
  }
  return out
}

interface Measured {
  speed: number
  phases: ClipPhases
}

/**
 * Measure the clips on a throwaway instance (the real ones never wear a sampled pose before their
 * physics attach):
 *  - travel speed: over one loop a planted foot slides back by one step, and a loop is two steps,
 *    so speed ≈ 2 × (the foot's fore-aft range) / (loop duration);
 *  - walk phases: feet together where the fore-aft gap between the feet crosses zero, foot plants
 *    where it peaks either way;
 *  - squat tops: where the hip is highest.
 */
function measureClipPhases(t: Template, squatSource: AnimationGroup | null): Measured {
  const fallback: Measured = { speed: 0.8 * t.height, phases: { walkTogether: [], walkPlants: [], squatTops: [] } }
  const probe = spawn(t)
  try {
    const clip = probe.clip
    const lf = findNode(probe.root, /^(L_Foot|LeftFoot|mixamorig:LeftFoot|J_Bip_L_Foot)$/)
    const rf = findNode(probe.root, /^(R_Foot|RightFoot|mixamorig:RightFoot|J_Bip_R_Foot)$/)
    const hip = findNode(probe.root, /^(Hip|Hips|mixamorig:Hips|J_Bip_C_Hips)$/)
    if (!clip || !lf || !rf) return fallback
    const inv = new Matrix()
    const sample = (group: AnimationGroup, read: () => number): number[] => {
      const out: number[] = []
      group.start(false)
      group.pause()
      for (let i = 0; i <= 60; i++) {
        group.goToFrame(group.from + ((group.to - group.from) * i) / 60)
        for (const n of [probe.root, ...probe.root.getDescendants(false)]) if (n instanceof TransformNode) n.computeWorldMatrix(true)
        probe.root.getWorldMatrix().invertToRef(inv)
        out.push(read())
      }
      group.stop()
      return out
    }
    const local = (n: TransformNode): Vector3 => Vector3.TransformCoordinates(n.getAbsolutePosition(), inv)
    const lz = sample(clip, () => local(lf).z)
    const gap = sample(clip, () => local(lf).z - local(rf).z)
    const fps = clip.targetedAnimations[0]?.animation.framePerSecond ?? 60
    const seconds = (clip.to - clip.from) / fps
    const scale = Math.cbrt(Math.abs(probe.root.getWorldMatrix().determinant()))
    const speed = seconds > 0 ? (2 * (Math.max(...lz) - Math.min(...lz)) * scale) / seconds : NaN
    let squatTops: number[] = []
    if (squatSource && hip && probe.skeleton) {
      const squat = bindClip(squatSource, probe.skeleton, 'squat-probe')
      squatTops = extrema(sample(squat, () => hip.getAbsolutePosition().y), 'max')
      squat.dispose()
    }
    return {
      speed: Number.isFinite(speed) && speed > 0 ? speed : fallback.speed,
      phases: { walkTogether: zeroCrossings(gap), walkPlants: extrema(gap, 'both'), squatTops },
    }
  } finally {
    probe.dispose()
  }
}

// --- T-pose fallback (clip-less files only) --------------------------------------------------

function refresh(n: TransformNode): void {
  const chain: TransformNode[] = []
  for (let p: Node | null = n; p; p = p.parent) if (p instanceof TransformNode) chain.unshift(p)
  for (const p of chain) p.computeWorldMatrix(true)
}

/** Rotate `bone` about the world axis ⟂ its limb and up, whichever way LOWERS `end`. */
function lower(root: TransformNode, bone: TransformNode, end: TransformNode, degrees: number): void {
  refresh(end)
  const before = end.getAbsolutePosition().clone()
  const axis = Vector3.Cross(before.subtract(bone.getAbsolutePosition()), Vector3.Up())
  if (axis.lengthSquared() < 1e-12) return
  axis.normalize()
  const rad = (degrees * Math.PI) / 180
  if (!bone.rotationQuaternion) bone.rotationQuaternion = Quaternion.FromEulerVector(bone.rotation)
  bone.rotate(axis, rad, Space.WORLD)
  refresh(end)
  if (end.getAbsolutePosition().y > before.y) bone.rotate(axis, -2 * rad, Space.WORLD)
  refresh(root)
}

/** Upper arms down ~65°, forearms ~12°, before any physics is attached (the runtime captures rest at attach). */
function relaxArms(root: TransformNode): void {
  for (const side of ['L', 'R']) {
    const upper = findNode(root, new RegExp(`^${side}_Upperarm$`))
    const fore = findNode(root, new RegExp(`^${side}_Forearm$`))
    const hand = findNode(root, new RegExp(`^${side}_Hand$`))
    if (!upper || !fore || !hand) continue
    lower(root, upper, hand, 65)
    lower(root, fore, hand, 12)
  }
}

// --- Walking in circles ------------------------------------------------------------------------

interface Walker {
  node: TransformNode
  radius: number
  theta: number
  dir: 1 | -1
  hopStart: number
  /** The avatar's clip blender: its speed factor ramps the travel through transitions. */
  moves?: Moves
}

const walkers: Walker[] = []
let walkSpeed = 0.8
let walking = true

function addWalker(root: TransformNode, radius: number, theta: number, dir: 1 | -1): Walker {
  const node = new TransformNode('walker', scene)
  node.rotationQuaternion = Quaternion.Identity()
  root.parent = node
  const w = { node, radius, theta, dir, hopStart: -Infinity }
  place(w, 0)
  walkers.push(w)
  return w
}

/** On the circle at theta, heading along the tangent (the avatar's local +Z is its forward). */
function place(w: Walker, hopY: number): void {
  const s = Math.sin(w.theta)
  const c = Math.cos(w.theta)
  w.node.position.set(w.radius * s, hopY, w.radius * c)
  const yaw = Math.atan2(w.dir * c, -w.dir * s)
  Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, w.node.rotationQuaternion!)
}

scene.onBeforeAnimationsObservable.add(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1)
  const t = performance.now() / 1000
  for (const w of walkers) {
    if (walking) w.theta += (w.dir * walkSpeed * (w.moves?.speedFactor ?? 1) * dt) / w.radius
    const hopT = t - w.hopStart
    const hopDur = 0.55
    const y = hopT >= 0 && hopT < hopDur ? 0.25 * 4 * (hopT / hopDur) * (1 - hopT / hopDur) : 0
    place(w, y)
  }
})

// --- Wiring --------------------------------------------------------------------------------------

const everyone: HarryPhysics[] = []
const clips: AnimationGroup[] = []
const allMoves: Moves[] = []
let hopSource: AnimationGroup | null = null
let squatSource: AnimationGroup | null = null

/** Bind the loaded clips to one avatar and give it a crossfader. The crowd gets the hop only. */
let phases: ClipPhases = { walkTogether: [], walkPlants: [], squatTops: [] }

function movesFor(inst: Instance, withSquat: boolean, walker: Walker): Moves {
  const sk = inst.skeleton
  const hop = sk && hopSource ? bindClip(hopSource, sk, 'hop') : null
  const squat = sk && squatSource && withSquat ? bindClip(squatSource, sk, 'squat') : null
  const m = new Moves(scene, inst.clip, hop, squat, phases)
  walker.moves = m
  allMoves.push(m)
  return m
}

function startClip(clip: AnimationGroup | null, randomOffset: boolean): void {
  if (!clip) return
  clip.start(true, 1)
  if (randomOffset) clip.goToFrame(clip.from + Math.random() * (clip.to - clip.from))
  clips.push(clip)
}

async function main(): Promise<void> {
  status.textContent = 'Loading avatar…'
  const template = await loadTemplate(AVATAR_URL)
  // Separate, animation-only clip files: bound per avatar with bindClipToSkeleton.
  ;[hopSource, squatSource] = await Promise.all([loadClip(HOP_URL, scene), loadClip(SQUAT_URL, scene)])
  if (template.hasClip) {
    const measured = measureClipPhases(template, squatSource)
    walkSpeed = measured.speed
    phases = measured.phases
    console.info('[demo] measured walk', walkSpeed.toFixed(2), 'm/s; phases', JSON.stringify(phases))
  }

  const hero = spawn(template)
  stage.addShadowCasters(hero.meshes)
  const heroWalker = addWalker(hero.root, 3, 0, 1)
  // Physics attaches at the bind pose, BEFORE the clip starts: the runtime captures rest now.
  const heroPhysics = attachHarryPhysics(hero.root, scene, hero.meshes, { label: 'demo' })
  heroPhysics.springs?.setGround(FLOOR)
  everyone.push(heroPhysics)
  startClip(hero.clip, false)
  if (!template.hasClip) walking = false // a statue does not glide around the circle
  const heroMoves = movesFor(hero, true, heroWalker)

  wireControls(template, heroWalker, heroPhysics, heroMoves)
}

let follow = true
let followTarget: TransformNode | null = null
scene.onBeforeRenderObservable.add(() => {
  if (!follow || !followTarget) return
  const p = followTarget.getAbsolutePosition()
  Vector3.LerpToRef(camera.target, new Vector3(p.x, camera.target.y, p.z), 0.08, camera.target)
})

function wireControls(template: Template, heroWalker: Walker, hero: HarryPhysics, heroMoves: Moves): void {
  followTarget = heroWalker.node
  const h = template.height
  interface CamPose {
    alpha: number
    beta: number
    radius: number
    target: Vector3
  }
  /** A view of the hero: `around` = azimuth offset from its facing (0 = Harry's 3/4 front view). */
  const heroPose = (around: number, height: number, radius: number, beta?: number): CamPose => {
    const f = heroWalker.node.forward // the avatar's facing in world space
    const v = VIEW_DIRECTION
    const az = Math.atan2(v.x, v.z) + Math.atan2(f.x, f.z) + around // Harry's view, turned with the avatar
    const p = heroWalker.node.getAbsolutePosition()
    return {
      alpha: Math.atan2(Math.cos(az), Math.sin(az)),
      beta: beta ?? Math.acos(v.y / v.length()),
      radius,
      target: new Vector3(p.x, height, p.z),
    }
  }
  const frontPose = (): CamPose => heroPose(0, h * 0.36, Math.max(1.5, h * 2.6))
  const creasePose = (): CamPose =>
    heroPose(Math.PI / 2 - Math.atan2(VIEW_DIRECTION.x, VIEW_DIRECTION.z), h * 0.42, h * 1.95, Math.PI / 2 - 0.12)
  // Note: assigning `camera.target` re-derives alpha/beta/radius from the current position, so
  // the target is updated IN PLACE (copyFrom) and the angles are set after it.
  const apply = (c: CamPose): void => {
    camera.target.copyFrom(c.target)
    camera.alpha = c.alpha
    camera.beta = c.beta
    camera.radius = c.radius
  }
  /**
   * Glide from wherever the camera is to `pose()` over `seconds` (smootherstep). The goal is
   * re-evaluated every frame, so it tracks an avatar that is still moving.
   */
  let glide: ((dt: number) => boolean) | null = null
  const glideTo = (pose: () => CamPose, seconds: number, then?: () => void): void => {
    const from: CamPose = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }
    let t = 0
    glide = (dt) => {
      t = Math.min(seconds, t + dt)
      const u = ease(t / seconds)
      const to = pose()
      let da = (to.alpha - from.alpha) % (2 * Math.PI)
      if (da > Math.PI) da -= 2 * Math.PI
      if (da < -Math.PI) da += 2 * Math.PI // the short way round
      Vector3.LerpToRef(from.target, to.target, u, camera.target)
      camera.alpha = from.alpha + da * u
      camera.beta = from.beta + (to.beta - from.beta) * u
      camera.radius = from.radius + (to.radius - from.radius) * u
      if (t >= seconds) {
        then?.()
        return false
      }
      return true
    }
  }
  scene.onBeforeRenderObservable.add(() => {
    if (glide && !glide(Math.min(engine.getDeltaTime() / 1000, 0.1))) glide = null
  })
  apply(frontPose())
  const followBtn = document.getElementById('follow') as HTMLButtonElement
  const setFollow = (on: boolean): void => {
    follow = on
    followBtn.setAttribute('aria-pressed', String(on))
  }
  followBtn.onclick = () => setFollow(!follow)

  const walkBtn = document.getElementById('walk') as HTMLButtonElement
  walkBtn.disabled = !template.hasClip
  walkBtn.onclick = () => {
    walking = !walking
    for (const m of allMoves) m.setPaused(!walking)
    for (const c of clips) if (!allMoves.length) (walking ? c.play(true) : c.pause())
    walkBtn.setAttribute('aria-pressed', String(walking))
  }
  ;(document.getElementById('hop') as HTMLButtonElement).onclick = () => {
    // The hop clip, crossfaded in over the walk (the circling carries on); the crowd joins with
    // a little scatter. Without a hop clip, a procedural hop of the root is the fallback.
    const now = performance.now() / 1000
    allMoves.forEach((m, i) => {
      const w = walkers[i]
      if (!w) return
      const delay = i === 0 ? 0 : Math.random() * 0.4
      if (m.canHop) setTimeout(() => m.hop(), delay * 1000)
      else w.hopStart = now + delay
    })
  }
  const squatBtn = document.getElementById('squat') as HTMLButtonElement
  squatBtn.disabled = !heroMoves.canSquat
  squatBtn.onclick = () => {
    const on = heroMoves.toggleSquat()
    squatBtn.setAttribute('aria-pressed', String(on))
    setFollow(false)
    if (on) {
      // Glide to side-on, at elbow/knee height: where the crease and swell correctives show.
      glideTo(creasePose, 0.9)
    } else {
      // Glide back to the 3/4 follow view, then hand over to the follow.
      glideTo(frontPose, 0.9, () => setFollow(true))
    }
  }
  ;(document.getElementById('front') as HTMLButtonElement).onclick = () => {
    setFollow(false)
    glideTo(frontPose, 0.8, () => setFollow(true))
  }

  const springsBtn = document.getElementById('springs') as HTMLButtonElement
  let springsOn = true
  springsBtn.onclick = () => {
    springsOn = !springsOn
    for (const p of everyone) p.setSpringsEnabled(springsOn)
    springsBtn.setAttribute('aria-pressed', String(springsOn))
  }

  const select = document.getElementById('mood') as HTMLSelectElement
  for (const m of TAIL_MOODS) select.add(new Option(m, m))
  // setMood is false when no spring on this avatar plays a layered drive.
  if (hero.springs?.setMood('wag')) {
    select.value = 'wag'
    ;(document.getElementById('moodWrap') as HTMLLabelElement).hidden = false
    select.onchange = () => {
      for (const p of everyone) p.springs?.setMood(select.value as TailMood)
    }
  }

  // The crowd: 20 walkers on four staggered rings, under a budget and a distance LOD.
  const budget = createHarryBudget(scene, { maxActive: 12, everyNFrames: 30 })
  const crowd: HarryPhysics[] = []
  const budgetWrap = document.getElementById('budgetWrap') as HTMLLabelElement
  const budgetSel = document.getElementById('budget') as HTMLSelectElement
  budgetSel.onchange = () => {
    budget.maxActive = Number(budgetSel.value)
    budget.rank()
  }
  const crowdBtn = document.getElementById('crowd') as HTMLButtonElement
  crowdBtn.onclick = () => {
    crowdBtn.disabled = true
    budgetWrap.hidden = false
    const rings = [4.5, 6, 7.5, 9]
    for (let i = 0; i < 20; i++) {
      const ring = i % 4
      const k = Math.floor(i / 4)
      const inst = spawn(template)
      stage.addShadowCasters(inst.meshes)
      const walker = addWalker(inst.root, rings[ring]!, (k / 5) * Math.PI * 2 + ring * 0.6, ring % 2 === 0 ? -1 : 1)
      const p = attachHarryPhysics(inst.root, scene, inst.meshes, {
        label: `crowd-${i}`,
        budget,
        lod: { near: 12, far: 40, farHz: 15 },
      })
      p.springs?.setGround(FLOOR)
      if (select.value) p.springs?.setMood(select.value as TailMood)
      if (!springsOn) p.setSpringsEnabled(false)
      crowd.push(p)
      everyone.push(p)
      startClip(inst.clip, true)
      const m = movesFor(inst, false, walker)
      if (!walking) m.setPaused(true)
    }
    budget.rank()
    setFollow(false)
    camera.target = new Vector3(0, template.height * 0.5, 0)
    camera.radius = 13
    camera.beta = 1.12
    stage.resize(24, 10.5)
  }

  // The stats card (updated 4× a second; fps smoothed over frames).
  const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
  const clipNames = [clips[0]?.name ?? 'none', hopSource ? 'hop' : null, squatSource ? 'squat' : null].filter(Boolean)
  const clipLabel = (): string => heroMoves.current
  const surface = hero.jiggle?.probe().regions.map((r) => `${r.springName} (${r.modes} modes)`).join(', ')
  let frameMs = 16.7
  let last = performance.now()
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now()
    frameMs += (now - last - frameMs) * 0.05
    last = now
  })
  setInterval(() => {
    const n = { full: 0, reduced: 0, held: 0, off: 0 }
    for (const p of everyone) if (p.springs) n[p.springs.simulationState]++
    el('fps').textContent = (1000 / frameMs).toFixed(0)
    el('ms').textContent = frameMs.toFixed(1)
    el('avatars').textContent = String(everyone.length)
    el('full').textContent = String(n.full)
    el('reduced').textContent = String(n.reduced)
    el('held').textContent = String(n.held)
    el('off').textContent = String(n.off)
    el('draws').textContent = String(instrumentation.drawCallsCounter.current)
    el('verts').textContent = scene.totalVerticesPerfCounter.current.toLocaleString()
    el('clip').textContent = clipLabel()
    status.textContent =
      crowd.length === 0
        ? `Springs: ${hero.springs ? hero.springs.springNames.join(', ') : 'none'} · surface: ${surface ?? 'none'} · clips: ${clipNames.join(', ')} · walk ${walkSpeed.toFixed(2)} m/s`
        : `Budget ${budget.maxActive} of ${crowd.length}: the rest are held (tail frozen to save CPU) until they come nearer. Reduced = 15 Hz between 12 and 40 m.`
  }, 250)
}

main().catch((e) => {
  status.textContent = `Failed to load the avatar (${AVATAR_URL}): ${String(e)}. See "Demo assets" in the README.`
  console.error(e)
})

engine.runRenderLoop(() => scene.render())
window.addEventListener('resize', () => engine.resize())
