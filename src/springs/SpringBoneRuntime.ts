/**
 * SpringBoneRuntime — run the springs a file DECLARES (`VRMC_springBone` 1.0)
 * with the VRM reference solver, on a fixed clock.
 *
 * ONE responsibility: given a parsed declaration and the loaded nodes, turn
 * each declared segment's bone so its child follows a Verlet spring, and
 * advance that on a fixed 60 Hz step. No scene observer, no LOD, no loading —
 * the host (DeclaredSpringBones / the app) owns when it runs; springBoneDeclaration.ts owns the file.
 *
 * THE ARITHMETIC is a line-for-line port of three-vrm-springbone 3.5.5
 * `VRMSpringBoneJoint.update` (MIT, pixiv) — the reader Harry previews with.
 * On a 16-joint tail any arithmetic difference is amplified down the chain
 * (a port that measured bone length at rest instead of against the child's
 * cached world position diverged by 193 mm at the tip of a long tail), so the details below are deliberate, not incidental:
 *   - bone length = |bone world − CHILD world as cached at step start|;
 *   - the rotation is written onto the joint's OWN bone, from the rest axis
 *     (in the bone's initial frame) to the new tail — never onto the child;
 *   - collider offsets / capsule tails go through the collider bone's WORLD
 *     matrix (they are in the bone's local frame, per the spec);
 *   - three's `transformDirection` normalises, so both axis transforms do.
 *   Babylon is row-vector: world = local × parentWorld (three: parent · local).
 *
 * THE CLOCK. The reference update is per STEP (drag removes a share of the
 * velocity per step; stiffness and gravity add `power·dt`), so a frame-driven
 * update changes the motion with the frame rate — measured 35 cm vs 21 cm of
 * tip swing at 30 vs 144 fps on a long-tailed test avatar. `advance(frameDt)` runs a fixed
 * step. Each substep needs the body pose AT ITS TIME:
 *   - `poseAt` given (harness / exact mode): the caller poses the scene at the
 *     substep's time and the runtime reads it fresh;
 *   - otherwise (the live game, where Babylon's AnimationGroups have already
 *     posed the frame): the chain's external parents and the collider bones
 *     are INTERPOLATED between last frame's and this frame's world transforms
 *     at the substep's time — decomposed, translation/scale lerped, rotation
 *     slerped (an element-wise matrix lerp shears mid-turn).
 * More substeps due than `maxSubsteps` (a hitch, a tab refocus) → the chain is
 * RESET onto the current pose and the time dropped, never burst-simulated.
 *
 * Between steps (render faster than 60 Hz) the chain keeps wearing its latest
 * solution: `advance` always writes it back, so a clip that keys a chain bone
 * cannot flash the unsprung pose on the frames with no step.
 *
 * THE LAYERED DRIVE: a spring whose `extras.poqpoq.drive`
 * parses follows the ANIMATION instead of its bind — every step its joints'
 * target is re-seated to animated ⊕ mood(t) ⊕ reflex, the body's motion is
 * partly carried, a muscle closes a half-life share of the gap and a cone
 * bounds it (the same arithmetic as Harry's own driven spring update).
 * The host sets the mood (`setMood`); the file's mood is only where it starts.
 *
 * NOT YET: `center` spaces (warned and evaluated in world space), extended colliders.
 */

import { Matrix, Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import type { SpringBoneDeclaration, SpringCollider, SpringJointSettings, Vec3Tuple } from './springBoneDeclaration.js'
import { DriveState, parseSpringDrive, type TailMood } from './springDrive.js'
import { angleTo, fromAxisAngle, rotateTowards, slerpThree } from './threeQuaternion.js'

export interface SpringBoneRuntimeOptions {
  /** Fixed simulation rate, Hz (default 60). */
  stepHz?: number
  /** Substeps allowed per advance; more than this due → reset and drop the time (default 8). */
  maxSubsteps?: number
  /** Play a declared `poqpoq.drive` (default true); false = the plain passive spring, for comparison. */
  drive?: boolean
  /**
   * Whether an animation is keying this node right now. Given (the live game),
   * a driven chain reads a keyed bone's pose as its animated pose and an
   * unkeyed bone as its bind — exact ownership. Absent (the parity harness),
   * the runtime infers it: a bone still wearing the runtime's own last
   * solution was not posed since. That inference misreads a clip HOLDING a
   * pose equal to the solution, so live callers pass this.
   */
  isKeyed?: (node: TransformNode) => boolean
  onWarn?: (message: string) => void
}

/**
 * The ground under the body, in WORLD space (without it, tails pass through the
 * floor and platforms). Applied to every joint after the declared colliders, passive and
 * driven alike: a joint is pushed to its hitRadius above the plane along `normal`.
 * It never enters the file; the caller supplies it per frame.
 */
export interface GroundPlane {
  point: Vector3
  /** Unit length, pointing up out of the ground. */
  normal: Vector3
}

export interface SpringBoneRuntimeProbe {
  steps: number
  droppedSeconds: number
  /** Advances that reset the chain instead of running an over-long burst. */
  stallResets: number
  joints: number
  colliders: number
  /** Springs playing a layered drive. */
  driven: number
  /** Driven steps that reset a chain on a body jump past the teleport thresholds. */
  teleports: number
  /** Joint-steps set back on their cone (velocity cancelled). */
  coneClamps: number
  /** Joint-steps whose muscle hit its rate cap. */
  saturated: number
  /** Joint-steps pushed back above the ground plane. */
  groundPushes: number
}

/** A node the chain simulates or reads: a joint bone, or a joint's child. */
interface BoneRec {
  node: TransformNode
  /** Parent inside the chain set, or null → `external` is its parent. */
  parent: BoneRec | null
  external: Source | null
  /** Working world matrix during a step. */
  world: Matrix
  /** World position cached at step start (the reference's stale child matrix). */
  cachedPos: Vector3
  depth: number
  /** The rotation this runtime last wrote (joint bones; a driven chain's tip). Null = never written. */
  solved: Quaternion | null
}

/** A node outside the chain whose world transform the step reads (chain parents, collider bones). */
interface Source {
  node: TransformNode
  world: Matrix
  prevT: Vector3
  prevQ: Quaternion
  prevS: Vector3
  currT: Vector3
  currQ: Quaternion
  currS: Vector3
  hasPrev: boolean
}

interface Joint {
  bone: BoneRec
  child: BoneRec
  settings: SpringJointSettings
  gravityDir: Vector3
  colliders: ColliderRec[]
  initialLocalMatrix: Matrix
  initialLocalRotation: Quaternion
  initialLocalChildPosition: Vector3
  boneAxis: Vector3
  currentTail: Vector3
  prevTail: Vector3
  /** Non-joint chain descendants refreshed after this joint moves (the reference's _relevantChildrenUpdated). */
  followers: BoneRec[]
  /** The bind targets (a drive re-seats initialLocal* every step; reset returns here). */
  restLocalMatrix: Matrix
  restLocalRotation: Quaternion
  /** `_worldSpaceBoneLength` of the last update (the drive's second collision pass reuses it). */
  lastLength: number
}

/** One declared spring: its bones root → tip and its segments, solved in order. */
interface Chain {
  name: string
  bones: BoneRec[]
  joints: Joint[]
  /** Each bone's local rotation at bind, root → tip. */
  rest: Quaternion[]
  drive: ChainDrive | null
}

/** A chain's layered-drive state (Harry's driven spring update). */
interface ChainDrive {
  state: DriveState
  yawAxes: Vector3[]
  pitchAxes: Vector3[]
  driveQ: Quaternion[]
  yaw: number[]
  pitch: number[]
  gains: number[]
  bodyPrev: { p: Vector3; q: Quaternion } | null
  omega: Vector3
  /** The animated pose sampled at the start of this frame (per bone). */
  frameAnim: Quaternion[]
  /** Last frame's `frameAnim` — live substeps slerp between the two. */
  prevFrameAnim: Quaternion[]
  /** A keyed bone's position and scale, this frame and last (the whole local TRS
   *  is interpolated across live substeps, not only the rotation). */
  framePos: Vector3[]
  prevFramePos: Vector3[]
  frameScl: Vector3[]
  prevFrameScl: Vector3[]
  hasPrevAnim: boolean
  anim: Quaternion[]
}

interface ColliderRec {
  decl: SpringCollider
  /** The collider's bone: a chain bone (its step-start world) or a Source. */
  bone: BoneRec | null
  source: Source | null
  offset: Vector3
  tail: Vector3
  /** World positions for this step. */
  head: Vector3
  tailWorld: Vector3
  /** The collider bone's uniform world scale this step (radii are declared in its local units). */
  worldScale: number
}

// Scratch (single-threaded; never held across calls)
const _local = new Matrix()
const _mat = new Matrix()
const _inv = new Matrix()
const _v1 = new Vector3()
const _v2 = new Vector3()
const _v3 = new Vector3()
const _next = new Vector3()
const _bonePos = new Vector3()
const _gd = new Vector3()
const _gt = new Vector3()
const _X = new Vector3(1, 0, 0)
const _Z = new Vector3(0, 0, 1)
const _pushFrom = new Vector3()
const _q = new Quaternion()
const _t = new Vector3()
const _s = new Vector3()
const _qi = new Quaternion()
const _qa = new Quaternion()
const _qb = new Quaternion()
const _dq = new Quaternion()
const _carryQ = new Quaternion()
const _bodyP = new Vector3()
const _bodyQ = new Quaternion()
const _bodyS = new Vector3()
const _moved = new Vector3()
const _tail = new Vector3()
const _before = new Vector3()
const _m1 = new Matrix()
const _m2 = new Matrix()
const _m3 = new Matrix()
const _prefix = new Matrix()
const _axis = new Vector3()
const IDENTITY_Q = Quaternion.Identity()
/** A parentless chain bone's parent world (the reference's IDENTITY_MATRIX4). Never written. */
const IDENTITY = Matrix.Identity()

function nodeQuaternion(node: TransformNode): Quaternion {
  if (!node.rotationQuaternion) node.rotationQuaternion = Quaternion.FromEulerVector(node.rotation)
  return node.rotationQuaternion
}

function composeLocal(node: TransformNode, rotation: Quaternion, out: Matrix): Matrix {
  return Matrix.ComposeToRef(node.scaling, rotation, node.position, out)
}

/**
 * A driven joint's rest axis follows its child's CURRENT local offset, as its target follows the
 * animation: a clip that keys a non-root chain bone's position changes the direction the parent
 * must aim along, or every step pulls it back toward the bind axis. Unkeyed,
 * it's the constructor's axis exactly — parity untouched. A co-located child keeps the old axis.
 */
function reseatBoneAxis(j: Joint): void {
  const p = j.child.node.position
  const l = Math.hypot(p.x, p.y, p.z)
  if (l > 1e-9) j.boneAxis.set(p.x / l, p.y / l, p.z / l)
}

/** A glTF-world vector in Babylon's world: the loader's handedness conversion is x → −x. */
function toBabylonWorld(v: Vec3Tuple, handedFlip: boolean): Vector3 {
  return new Vector3(handedFlip ? -v[0] : v[0], v[1], v[2])
}

/** A world matrix's uniform scale (|det|^⅓ — a mirror's sign drops out). */
function uniformScale(m: Matrix): number {
  return Math.cbrt(Math.abs(m.determinant()))
}

function depthOf(node: TransformNode): number {
  let d = 0
  for (let p = node.parent; p; p = p.parent) d++
  return d
}

export class SpringBoneRuntime {
  readonly stepHz: number
  private readonly dt: number
  private readonly maxSubsteps: number
  private readonly isKeyed: ((node: TransformNode) => boolean) | null
  private readonly recs: BoneRec[] = []
  private readonly joints: Joint[] = []
  private readonly chains: Chain[] = []
  private readonly sources: Source[] = []
  private readonly colliders: ColliderRec[] = []
  /** Every ancestor of a Source, top-down, refreshed before a Source is read fresh. */
  private readonly refreshList: TransformNode[] = []
  private steps = 0
  private accumulator = 0
  private droppedSeconds = 0
  private stallResets = 0
  private teleports = 0
  private coneClamps = 0
  private saturated = 0
  private groundPushes = 0
  private readonly groundPoint = new Vector3()
  private readonly groundNormal = new Vector3(0, 1, 0)
  private groundActive = false

  constructor(declaration: SpringBoneDeclaration, nodes: ReadonlyArray<TransformNode | null | undefined>, options: SpringBoneRuntimeOptions = {}) {
    this.stepHz = options.stepHz ?? 60
    this.dt = 1 / this.stepHz
    this.maxSubsteps = options.maxSubsteps ?? 8
    this.isKeyed = options.isKeyed ?? null
    const warn = options.onWarn ?? (() => {})

    const missing = new Set<number>()
    const node = (i: number): TransformNode => {
      const n = nodes[i]
      if (!n) missing.add(i)
      return n as TransformNode
    }
    for (const s of declaration.springs) {
      for (const seg of s.segments) {
        node(seg.node)
        node(seg.child)
      }
    }
    for (const c of declaration.colliders) node(c.node)
    if (missing.size > 0) {
      throw new Error(`SpringBoneRuntime: the declaration names glTF nodes this model did not load: ${[...missing].join(', ')}`)
    }

    // The chain set: every joint bone and every joint's child.
    const recByNode = new Map<TransformNode, BoneRec>()
    const rec = (n: TransformNode): BoneRec => {
      let r = recByNode.get(n)
      if (!r) {
        r = { node: n, parent: null, external: null, world: new Matrix(), cachedPos: new Vector3(), depth: depthOf(n), solved: null }
        recByNode.set(n, r)
      }
      return r
    }
    for (const s of declaration.springs) {
      if (s.center !== null) warn(`spring "${s.name}" declares a center space — not supported yet, evaluated in world space`)
      for (const seg of s.segments) {
        rec(nodes[seg.node]!)
        rec(nodes[seg.child]!)
      }
    }
    const sourceByNode = new Map<TransformNode, Source>()
    const source = (n: TransformNode): Source => {
      let src = sourceByNode.get(n)
      if (!src) {
        src = {
          node: n,
          world: new Matrix(),
          prevT: new Vector3(), prevQ: new Quaternion(), prevS: new Vector3(),
          currT: new Vector3(), currQ: new Quaternion(), currS: new Vector3(),
          hasPrev: false,
        }
        sourceByNode.set(n, src)
        this.sources.push(src)
      }
      return src
    }
    // gravityDir is declared in the glTF scene's (right-handed) world. Babylon's glTF loader
    // converts the whole model under a `__root__` (rotation Y 180° · scale z −1 = x → −x), and
    // bone frames and collider offsets ride that conversion; a world VECTOR must be converted
    // explicitly. Straight down [0,−1,0] is invariant, which hid this.
    let top: TransformNode = [...recByNode.values()][0]?.node ?? (nodes.find((n) => n) as TransformNode)
    while (top?.parent) top = top.parent as TransformNode
    const handedFlip = !!top && top.computeWorldMatrix(true).determinant() < 0
    for (const r of recByNode.values()) {
      const p = r.node.parent as TransformNode | null
      const pr = p ? recByNode.get(p) : undefined
      if (pr) r.parent = pr
      else if (p) r.external = source(p)
      // A parentless chain bone has an identity parent world (the reference's IDENTITY_MATRIX4).
    }
    this.recs.push(...[...recByNode.values()].sort((a, b) => a.depth - b.depth))

    // Colliders: one record per declared collider, shared by every spring that names it.
    const colliderRecs = declaration.colliders.map((c) => {
      const n = nodes[c.node]!
      const inChain = recByNode.get(n) ?? null
      const shape = c.shape
      const cr: ColliderRec = {
        decl: c,
        bone: inChain,
        source: inChain ? null : source(n),
        offset: Vector3.FromArray(shape.offset),
        tail: shape.kind === 'capsule' ? Vector3.FromArray(shape.tail) : new Vector3(),
        head: new Vector3(),
        tailWorld: new Vector3(),
        worldScale: 1,
      }
      return cr
    })
    this.colliders.push(...colliderRecs)

    // Ancestors of every Source, top-down, so a fresh read sees this frame's pose.
    const refresh = new Set<TransformNode>()
    for (const src of this.sources) for (let p: TransformNode | null = src.node; p; p = p.parent as TransformNode | null) refresh.add(p)
    this.refreshList.push(...[...refresh].sort((a, b) => depthOf(a) - depthOf(b)))

    // Chains, parent-first (the reference sorts joints by dependency); root → tip within each.
    const pending: Chain[] = []
    for (const s of declaration.springs) {
      const springColliders = s.colliders.map((i) => colliderRecs[i]).filter((c): c is ColliderRec => c !== undefined)
      const chainJoints: Joint[] = []
      for (const seg of s.segments) {
        const bone = recByNode.get(nodes[seg.node]!)!
        const child = recByNode.get(nodes[seg.child]!)!
        if (child.parent !== bone) {
          warn(`spring "${s.name}": node ${seg.child} is not a child of node ${seg.node} — the reference measures it anyway`)
        }
        chainJoints.push({
          bone,
          child,
          settings: seg.settings,
          gravityDir: toBabylonWorld(seg.settings.gravityDir, handedFlip),
          colliders: springColliders,
          initialLocalMatrix: new Matrix(),
          initialLocalRotation: new Quaternion(),
          initialLocalChildPosition: new Vector3(),
          boneAxis: new Vector3(),
          currentTail: new Vector3(),
          prevTail: new Vector3(),
          followers: [],
          restLocalMatrix: new Matrix(),
          restLocalRotation: new Quaternion(),
          lastLength: 0,
        })
      }
      const bones = s.jointNodes.slice(0, chainJoints.length + 1).map((i) => recByNode.get(nodes[i]!)!)
      const driveDecl = options.drive === false ? null : parseSpringDrive(s.extras, bones.length, (m) => warn(`spring "${s.name}": ${m}`))
      if (driveDecl && driveDecl.dynamics.stepHz !== this.stepHz) {
        warn(`spring "${s.name}": the drive declares ${driveDecl.dynamics.stepHz} Hz, this runtime steps at ${this.stepHz} Hz — playing passive`)
      }
      const useDrive = driveDecl !== null && driveDecl.dynamics.stepHz === this.stepHz
      if (useDrive && s.center !== null) warn(`spring "${s.name}": a drive with a center space — the drive carries its own body frame; center ignored`)
      pending.push({
        name: s.name,
        bones,
        joints: chainJoints,
        rest: bones.map((b) => nodeQuaternion(b.node).clone()),
        drive: useDrive
          ? {
              state: new DriveState(driveDecl),
              yawAxes: driveDecl.axes.map((a) => Vector3.FromArray(a.yaw)),
              pitchAxes: driveDecl.axes.map((a) => Vector3.FromArray(a.pitch)),
              driveQ: bones.map(() => new Quaternion()),
              yaw: bones.map(() => 0),
              pitch: bones.map(() => 0),
              gains: chainJoints.map(() => 0),
              bodyPrev: null,
              omega: new Vector3(),
              frameAnim: bones.map(() => new Quaternion()),
              prevFrameAnim: bones.map(() => new Quaternion()),
              framePos: bones.map((b) => b.node.position.clone()),
              prevFramePos: bones.map((b) => b.node.position.clone()),
              frameScl: bones.map((b) => b.node.scaling.clone()),
              prevFrameScl: bones.map((b) => b.node.scaling.clone()),
              hasPrevAnim: false,
              anim: bones.map(() => new Quaternion()),
            }
          : null,
      })
    }
    this.chains.push(...pending.map((c, i) => ({ c, i })).sort((a, b) => a.c.bones[0].depth - b.c.bones[0].depth || a.i - b.i).map((x) => x.c))
    for (const c of this.chains) this.joints.push(...c.joints)
    const jointBones = new Set(this.joints.map((j) => j.bone))
    for (const j of this.joints) {
      // Chain descendants of this bone reachable without crossing another joint bone.
      const walk = (r: BoneRec): void => {
        for (const c of this.recs) {
          if (c.parent !== r || jointBones.has(c)) continue
          j.followers.push(c)
          walk(c)
        }
      }
      walk(j.bone)
    }

    // The initial state: the scene must be AT REST now (the reference's setInitState).
    this.readSourcesFresh()
    this.useCurrentSources()
    this.refreshChainWorlds()
    for (const j of this.joints) {
      const q = nodeQuaternion(j.bone.node)
      j.initialLocalRotation.copyFrom(q)
      composeLocal(j.bone.node, q, j.initialLocalMatrix)
      j.initialLocalChildPosition.copyFrom(j.child.node.position)
      j.boneAxis.copyFrom(j.initialLocalChildPosition).normalize()
      j.restLocalRotation.copyFrom(j.initialLocalRotation)
      j.restLocalMatrix.copyFrom(j.initialLocalMatrix)
      Vector3.TransformCoordinatesToRef(j.initialLocalChildPosition, j.bone.world, j.currentTail)
      j.prevTail.copyFrom(j.currentTail)
      j.bone.solved = q.clone()
    }
    for (const c of this.chains) {
      if (!c.drive) continue
      const tip = c.bones[c.bones.length - 1]
      tip.solved = nodeQuaternion(tip.node).clone()
      const declared = c.drive.state.drive.gains
      const derived = new Array<number>(c.joints.length)
      c.drive.state.sample(0, c.bones.length, c.drive.yaw, c.drive.pitch, derived)
      if (derived.some((g, k) => Math.abs(g - declared[k]) > 1e-9)) {
        warn(`spring "${c.name}": the drive's recorded gains differ from its mood table — using the table`)
      }
    }
  }

  // --- The ground ---

  /** Set (or clear, with null) the ground plane for the next steps. World space; `normal` is normalised here. */
  setGroundPlane(ground: GroundPlane | null): void {
    if (!ground) {
      this.groundActive = false
      return
    }
    this.groundPoint.copyFrom(ground.point)
    this.groundNormal.copyFrom(ground.normal)
    const l = this.groundNormal.length()
    if (l < 1e-9) {
      this.groundActive = false
      return
    }
    this.groundNormal.scaleInPlace(1 / l)
    this.groundActive = true
  }

  // --- The mood input ---

  /** Set the mood of every driven spring (or the one named); cross-fades over 0.25 s. */
  setMood(mood: TailMood, spring?: string): void {
    for (const c of this.chains) {
      if (c.drive && (spring === undefined || c.name === spring)) c.drive.state.setMood(mood, this.time)
    }
  }

  /** The current mood of the first driven spring (or the one named); null if none is driven. */
  getMood(spring?: string): TailMood | null {
    const c = this.chains.find((x) => x.drive && (spring === undefined || x.name === spring))
    return c?.drive?.state.mood ?? null
  }

  // --- Public API ---

  /** The simulation clock, seconds (steps / stepHz). */
  get time(): number {
    return this.steps * this.dt
  }

  probe(): SpringBoneRuntimeProbe {
    return {
      steps: this.steps,
      droppedSeconds: this.droppedSeconds,
      stallResets: this.stallResets,
      joints: this.joints.length,
      colliders: this.colliders.length,
      driven: this.chains.filter((c) => c.drive).length,
      teleports: this.teleports,
      coneClamps: this.coneClamps,
      saturated: this.saturated,
      groundPushes: this.groundPushes,
    }
  }

  /**
   * Advance by one render frame through the fixed-step accumulator. `poseAt`
   * (exact mode) poses the scene at each substep's absolute simulation time.
   * Returns the substeps run. Always leaves the chain wearing its latest solution.
   */
  advance(frameDt: number, poseAt?: (seconds: number) => void): number {
    if (!(frameDt > 0)) {
      this.showSolved()
      return 0
    }
    const dt = this.dt
    this.accumulator += frameDt
    const due = Math.floor((this.accumulator + 1e-9) / dt)

    if (!poseAt) {
      // This frame's pose, read once; last frame's is kept for the in-between substeps.
      this.readSourcesFresh()
    }
    // A driven step samples the ANIMATED pose: what each chain bone held when this
    // frame began — unless it still wears this runtime's own solution (nothing posed
    // it: no clip keys it), which means its bind rest.
    for (const c of this.chains) {
      if (!c.drive) continue
      this.animatedNow(c, c.rest, c.drive.frameAnim)
      const d = c.drive
      c.bones.forEach((b, k) => {
        d.framePos[k].copyFrom(b.node.position)
        d.frameScl[k].copyFrom(b.node.scaling)
      })
      if (!d.hasPrevAnim) {
        d.frameAnim.forEach((q, k) => d.prevFrameAnim[k].copyFrom(q))
        d.framePos.forEach((v, k) => d.prevFramePos[k].copyFrom(v))
        d.frameScl.forEach((v, k) => d.prevFrameScl[k].copyFrom(v))
      }
    }
    if (due > this.maxSubsteps) {
      // A hitch: never integrate a stale burst. Put the chain on the pose it has now.
      this.droppedSeconds += this.accumulator
      this.accumulator = 0
      this.stallResets++
      if (poseAt) this.readSourcesFresh()
      this.useCurrentSources()
      this.resetJoints()
      this.endFrame()
      return 0
    }

    for (let i = 1; i <= due; i++) {
      this.accumulator -= dt
      if (poseAt) {
        poseAt((this.steps + 1) * dt)
        this.readSourcesFresh()
        this.useCurrentSources()
        for (const c of this.chains) if (c.drive) this.animatedNow(c, c.drive.frameAnim, c.drive.anim)
      } else {
        // The substep's time within this frame: 0 = last frame's pose, 1 = this frame's.
        // The body AND a keyed tail pose are both interpolated, so a keyed driven tail
        // sees the same targets at any render rate.
        const alpha = Math.min(1, Math.max(0, 1 - Math.max(0, this.accumulator) / frameDt))
        this.useInterpolatedSources(alpha)
        for (const c of this.chains) {
          if (!c.drive) continue
          const d = c.drive
          d.anim.forEach((q, k) => slerpThree(q.copyFrom(d.prevFrameAnim[k]), d.frameAnim[k], alpha))
          c.bones.forEach((b, k) => {
            Vector3.LerpToRef(d.prevFramePos[k], d.framePos[k], alpha, b.node.position)
            Vector3.LerpToRef(d.prevFrameScl[k], d.frameScl[k], alpha, b.node.scaling)
          })
        }
      }
      this.step(dt)
    }
    if (!poseAt) {
      this.useCurrentSources()
      // Leave each driven bone's keyed position/scale at THIS frame's value, as the clip wrote it.
      for (const c of this.chains) {
        if (!c.drive) continue
        const d = c.drive
        c.bones.forEach((b, k) => {
          b.node.position.copyFrom(d.framePos[k])
          b.node.scaling.copyFrom(d.frameScl[k])
        })
      }
    }
    this.endFrame()
    return due
  }

  /** One raw solver step of `dt`, on the pose as it stands — the frame-driven mode, for measurement only. */
  stepRaw(dt: number): void {
    if (!(dt > 0)) return
    this.readSourcesFresh()
    this.useCurrentSources()
    for (const c of this.chains) {
      if (!c.drive) continue
      this.animatedNow(c, c.rest, c.drive.frameAnim)
      c.drive.frameAnim.forEach((q, k) => c.drive!.anim[k].copyFrom(q))
    }
    this.step(dt)
    this.endFrame()
  }

  /** Put every tail back on its rest in the current pose and forget the velocity (teleport, LOD re-entry, clip cut). */
  reset(): void {
    this.readSourcesFresh()
    this.useCurrentSources()
    for (const c of this.chains) {
      if (!c.drive) continue
      this.animatedNow(c, c.rest, c.drive.frameAnim)
      // The whole keyed TRS: endFrame promotes these to "last frame", so the first substeps
      // after a reset interpolate from the pose the chain was reset ON.
      const d = c.drive
      c.bones.forEach((b, k) => {
        d.framePos[k].copyFrom(b.node.position)
        d.frameScl[k].copyFrom(b.node.scaling)
      })
    }
    this.resetJoints()
    this.accumulator = 0
    this.endFrame()
  }

  // --- Sources (the pose the chain reads from outside itself) ---

  private readSourcesFresh(): void {
    for (const n of this.refreshList) n.computeWorldMatrix(true)
    for (const src of this.sources) {
      if (src.hasPrev) {
        src.prevT.copyFrom(src.currT)
        src.prevQ.copyFrom(src.currQ)
        src.prevS.copyFrom(src.currS)
      }
      src.node.getWorldMatrix().decompose(src.currS, src.currQ, src.currT)
      if (!src.hasPrev) {
        src.prevT.copyFrom(src.currT)
        src.prevQ.copyFrom(src.currQ)
        src.prevS.copyFrom(src.currS)
      }
    }
  }

  /** Mark this frame's pose as the "previous" for the next frame's interpolation. */
  private endFrame(): void {
    for (const src of this.sources) {
      src.prevT.copyFrom(src.currT)
      src.prevQ.copyFrom(src.currQ)
      src.prevS.copyFrom(src.currS)
      src.hasPrev = true
    }
    for (const c of this.chains) {
      if (!c.drive) continue
      c.drive.frameAnim.forEach((q, k) => c.drive!.prevFrameAnim[k].copyFrom(q))
      c.drive.framePos.forEach((v, k) => c.drive!.prevFramePos[k].copyFrom(v))
      c.drive.frameScl.forEach((v, k) => c.drive!.prevFrameScl[k].copyFrom(v))
      c.drive.hasPrevAnim = true
    }
    this.showSolved()
  }

  private useCurrentSources(): void {
    for (const src of this.sources) src.world.copyFrom(src.node.getWorldMatrix())
  }

  private useInterpolatedSources(alpha: number): void {
    for (const src of this.sources) {
      if (alpha >= 1) {
        src.world.copyFrom(src.node.getWorldMatrix())
        continue
      }
      Vector3.LerpToRef(src.prevT, src.currT, alpha, _t)
      Vector3.LerpToRef(src.prevS, src.currS, alpha, _s)
      Quaternion.SlerpToRef(src.prevQ, src.currQ, alpha, _q)
      Matrix.ComposeToRef(_s, _q, _t, src.world)
    }
  }

  // --- The step ---

  /** Each chain node's world from its current local and its parent — the step-start cache. */
  private refreshChainWorlds(): void {
    for (const r of this.recs) {
      composeLocal(r.node, nodeQuaternion(r.node), _local)
      const parentWorld = r.parent ? r.parent.world : r.external ? r.external.world : null
      if (parentWorld) _local.multiplyToRef(parentWorld, r.world)
      else r.world.copyFrom(_local)
      r.world.getTranslationToRef(r.cachedPos)
    }
  }

  private parentWorldOf(r: BoneRec): Matrix {
    return r.parent ? r.parent.world : r.external ? r.external.world : IDENTITY
  }

  private updateColliders(): void {
    for (const c of this.colliders) {
      const w = c.bone ? c.bone.world : c.source!.world
      c.worldScale = uniformScale(w)
      Vector3.TransformCoordinatesToRef(c.offset, w, c.head)
      if (c.decl.shape.kind === 'capsule') Vector3.TransformCoordinatesToRef(c.tail, w, c.tailWorld)
    }
  }

  private step(dt: number): void {
    this.refreshChainWorlds()
    this.updateColliders()
    const time = (this.steps + 1) * this.dt
    for (const c of this.chains) {
      if (c.drive) this.drivenUpdate(c, c.drive, dt, time)
      else for (const j of c.joints) this.updateJoint(j, dt)
    }
    this.steps++
  }

  /** Each bone's pose as posed now, unless it still wears this runtime's solution — then `fallback[k]`. */
  private animatedNow(c: Chain, fallback: Quaternion[], out: Quaternion[]): void {
    c.bones.forEach((b, k) => {
      const q = nodeQuaternion(b.node)
      const keyed = this.isKeyed ? this.isKeyed(b.node) : !(b.solved !== null && q.equals(b.solved))
      out[k].copyFrom(keyed ? q : fallback[k])
    })
  }

  /** three-vrm-springbone 3.5.5 VRMSpringBoneJoint.update, in Babylon. */
  private updateJoint(j: Joint, dt: number): void {
    const bone = j.bone
    const node = bone.node
    const parentWorld = this.parentWorldOf(bone)
    const q = nodeQuaternion(node)

    // The manager's bone.updateMatrix(); bone.updateWorldMatrix(false, false) before update.
    composeLocal(node, q, _local)
    _local.multiplyToRef(parentWorld, bone.world)
    bone.world.getTranslationToRef(_bonePos)

    // _calcWorldSpaceBoneLength: against the child's world AS CACHED at step start.
    const length = Vector3.Distance(_bonePos, j.child.cachedPos)
    j.lastLength = length

    // worldSpaceBoneAxis = boneAxis.transformDirection(initialLocal).transformDirection(parentWorld)
    Vector3.TransformNormalToRef(j.boneAxis, j.initialLocalMatrix, _v1)
    _v1.normalize()
    Vector3.TransformNormalToRef(_v1, parentWorld, _v2)
    _v2.normalize()

    // Verlet: inertia with drag, stiffness along the rest axis, gravity.
    j.currentTail.subtractToRef(j.prevTail, _v1)
    _next.copyFrom(j.currentTail).addInPlace(_v1.scaleInPlace(1 - j.settings.dragForce))
    _next.addInPlace(_v2.scaleInPlace(j.settings.stiffness * dt))
    _next.addInPlace(_v3.copyFrom(j.gravityDir).scaleInPlace(j.settings.gravityPower * dt))

    // Length constraint about the bone's world position.
    _next.subtractInPlace(_bonePos).normalize().scaleInPlace(length).addInPlace(_bonePos)

    this.collide(j, _next, length)

    j.prevTail.copyFrom(j.currentTail)
    j.currentTail.copyFrom(_next)

    // Rotation: rest axis → new tail, in the bone's INITIAL frame, onto the bone itself.
    j.initialLocalMatrix.multiplyToRef(parentWorld, _mat)
    _mat.invertToRef(_inv)
    Vector3.TransformCoordinatesToRef(_next, _inv, _v1)
    _v1.normalize()
    Quaternion.FromUnitVectorsToRef(j.boneAxis, _v1, _qi)
    j.initialLocalRotation.multiplyToRef(_qi, q) // three: q.setFromUnitVectors(...).premultiply(initialLocalRotation)
    j.bone.solved!.copyFrom(q)

    composeLocal(node, q, _local)
    _local.multiplyToRef(parentWorld, bone.world)
    for (const f of j.followers) {
      composeLocal(f.node, nodeQuaternion(f.node), _local)
      _local.multiplyToRef(this.parentWorldOf(f), f.world)
    }
  }

  /** VRMSpringBoneJoint._collision with the sphere and capsule shapes (outside colliders only). */
  private collide(j: Joint, tail: Vector3, length: number): void {
    // The joint's world position, fresh: the driven path reaches here without updateJoint
    // setting _bonePos (the passive path set it from this same matrix, so it's unchanged there).
    j.bone.world.getTranslationToRef(_bonePos)
    // Radii are declared in each bone's LOCAL units; a height-normalised avatar (e.g. a
    // unit-scale upload raised ×1.9) scales its bones, so the radii scale with them.
    // At scale 1 (every Harry export) this is the reference arithmetic unchanged.
    const hitRadius = j.settings.hitRadius * uniformScale(j.bone.world)
    for (const c of j.colliders) {
      const radius = c.decl.shape.radius * c.worldScale
      const dir = _v3
      if (c.decl.shape.kind === 'sphere') {
        tail.subtractToRef(c.head, dir)
      } else {
        // Closest point on the capsule's segment.
        c.tailWorld.subtractToRef(c.head, _v2)
        const lengthSq = _v2.lengthSquared()
        tail.subtractToRef(c.head, dir)
        const dot = Vector3.Dot(_v2, dir)
        if (dot <= 0) {
          // head end
        } else if (lengthSq <= dot) {
          dir.subtractInPlace(_v2)
        } else {
          dir.subtractInPlace(_v2.scaleInPlace(dot / lengthSq))
        }
      }
      const len = dir.length()
      const distance = len - hitRadius - radius
      // A tail exactly on the collider's centre (or its capsule segment) has no push
      // direction: the reference divides by zero here and the NaN corrupts the chain
      // for good. Skip the undefined push; the next step moves it off.
      if (distance < 0 && len > 1e-12) {
        _pushFrom.copyFrom(tail)
        dir.scaleInPlace(1 / len)
        tail.addInPlace(dir.scaleInPlace(-distance))
        tail.subtractInPlace(_bonePos)
        const l = tail.length()
        // A collider surface through the joint can push the tail exactly onto it: no
        // direction to renormalise along. Undo this push instead.
        if (l > 1e-12) tail.scaleInPlace(length / l).addInPlace(_bonePos)
        else tail.copyFrom(_pushFrom)
      }
    }
    // THE GROUND (after the colliders, so it wins). The tail must stay on the bone's sphere
    // (|tail - bone| = length) AND hitRadius above the plane. A push-then-renormalise, as the
    // sphere collider does, can drop a joint that sits less than one length above the floor
    // straight back under it (e.g. bone y 0.05, length 0.15 → tail y -0.10), so solve
    // both at once: keep the tail's direction from the bone but clamp its component along the
    // normal to the least that clears the plane, renormalising the tangential part.
    if (this.groundActive) {
      const hit = j.settings.hitRadius * uniformScale(j.bone.world)
      _gd.copyFrom(tail).subtractInPlace(this.groundPoint)
      if (hit - Vector3.Dot(_gd, this.groundNormal) > 0 && length > 1e-12) {
        const n = this.groundNormal
        // Least normal component of the unit direction that keeps the tail clear.
        const boneHeight = Vector3.Dot(_gd.copyFrom(_bonePos).subtractInPlace(this.groundPoint), n) - hit
        const minN = Math.min(1, -boneHeight / length)
        _gd.copyFrom(tail).subtractInPlace(_bonePos)
        const l = _gd.length()
        if (l > 1e-12) _gd.scaleInPlace(1 / l)
        else _gd.copyFrom(n).scaleInPlace(-1)
        const dn = Vector3.Dot(_gd, n)
        if (dn < minN) {
          // Tangential part, rescaled so the direction stays unit length with its normal part at minN.
          _gt.copyFrom(_gd).subtractInPlace(_pushFrom.copyFrom(n).scaleInPlace(dn))
          let tl = _gt.length()
          if (tl < 1e-9) {
            // Pointing straight into the plane: pick any tangent.
            Vector3.CrossToRef(n, Math.abs(n.x) < 0.9 ? _X : _Z, _gt)
            tl = _gt.length()
          }
          _gt.scaleInPlace(Math.sqrt(Math.max(0, 1 - minN * minN)) / tl)
          _gd.copyFrom(_gt).addInPlace(_pushFrom.copyFrom(n).scaleInPlace(minN))
        }
        tail.copyFrom(_bonePos).addInPlace(_gd.scaleInPlace(length))
        this.groundPushes++
      }
    }
  }

  /** Every chain's tails onto its target (a driven chain's: `frameAnim` ⊕ mood, which the caller has sampled). */
  // Seeding a tail after a reset / a teleport / the muscle uses the child's CURRENT local offset
  // (j.child.node.position), not the constructor's: a clip that keys a non-root chain bone's
  // position would otherwise start the particle at the bind offset and kick.
  // Unkeyed, the two are the same number — Harry parity is untouched.
  private resetJoints(): void {
    // A drive re-seats the targets every step: back to the bind targets first.
    for (const c of this.chains) {
      for (const j of c.joints) {
        j.initialLocalRotation.copyFrom(j.restLocalRotation)
        j.initialLocalMatrix.copyFrom(j.restLocalMatrix)
      }
      if (c.drive) {
        // A driven chain resets onto its CURRENT target (this frame's animated pose ⊕ the
        // mood now; no reflex — its history is what a reset forgets), not its bind: a
        // bind reset would flash the unsprung tail for a frame.
        const d = c.drive
        const n = c.bones.length
        d.state.sample(this.time, n, d.yaw, d.pitch, d.gains)
        for (let k = 0; k < n; k++) {
          fromAxisAngle(d.yawAxes[k], d.yaw[k], _qa)
          fromAxisAngle(d.pitchAxes[k], d.pitch[k], _qb)
          _qa.multiplyInPlace(_qb)
          d.frameAnim[k].multiplyToRef(_qa, d.driveQ[k])
        }
        c.joints.forEach((j, k) => {
          j.initialLocalRotation.copyFrom(d.driveQ[k])
          reseatBoneAxis(j)
          composeLocal(j.bone.node, d.driveQ[k], j.initialLocalMatrix)
        })
        const tip = c.bones[n - 1]
        nodeQuaternion(tip.node).copyFrom(d.driveQ[n - 1])
        tip.solved!.copyFrom(d.driveQ[n - 1])
        d.bodyPrev = null
        d.omega.setAll(0)
      }
    }
    // The reference reset, parent-first: each bone back on its initial rotation, tail on its rest.
    this.refreshChainWorlds()
    for (const j of this.joints) {
      const q = nodeQuaternion(j.bone.node)
      q.copyFrom(j.initialLocalRotation)
      j.bone.solved!.copyFrom(q)
      composeLocal(j.bone.node, q, _local)
      _local.multiplyToRef(this.parentWorldOf(j.bone), j.bone.world)
      for (const f of j.followers) {
        composeLocal(f.node, nodeQuaternion(f.node), _local)
        _local.multiplyToRef(this.parentWorldOf(f), f.world)
      }
      Vector3.TransformCoordinatesToRef(j.child.node.position, j.bone.world, j.currentTail)
      j.prevTail.copyFrom(j.currentTail)
    }
  }

  /**
   * Re-apply the latest solution without stepping: for a frame the scheduler
   * skips (the far LOD) after a clip has already written keyed rotations, so
   * the tail keeps its reduced-rate solution instead of flashing the raw clip.
   */
  hold(): void {
    this.showSolved()
  }

  /**
   * Put every bone this runtime writes back on its BIND local rotation, once, and forget the
   * velocity — for turning the springs off. A bone a clip keys is rewritten by the clip anyway.
   */
  restoreBind(): void {
    for (const c of this.chains) {
      c.bones.forEach((b, k) => {
        if (b.solved) nodeQuaternion(b.node).copyFrom(c.rest[k])
      })
    }
    this.accumulator = 0
  }

  /** Write the latest solution onto the bones (also on frames with no step). */
  private showSolved(): void {
    for (const r of this.recs) if (r.solved) nodeQuaternion(r.node).copyFrom(r.solved)
  }

  // --- The layered drive ---

  /** This bone's world from its current local rotation and its parent's world. */
  private worldFromLocal(r: BoneRec): void {
    composeLocal(r.node, nodeQuaternion(r.node), _local)
    _local.multiplyToRef(this.parentWorldOf(r), r.world)
  }

  private refreshFollowers(j: Joint): void {
    for (const f of j.followers) this.worldFromLocal(f)
  }

  /** The reference joint's own rotation rule, aimed at a world tail (after a collision moved it). */
  private aimAt(j: Joint, world: Vector3): void {
    j.initialLocalMatrix.multiplyToRef(this.parentWorldOf(j.bone), _mat)
    _mat.invertToRef(_inv)
    Vector3.TransformCoordinatesToRef(world, _inv, _v1)
    _v1.normalize()
    Quaternion.FromUnitVectorsToRef(j.boneAxis, _v1, _qi)
    j.initialLocalRotation.multiplyToRef(_qi, nodeQuaternion(j.bone.node))
    this.worldFromLocal(j.bone)
  }

  /** Carry a Verlet point with the body by the share of its motion the tail does not inherit. */
  private carry(pt: Vector3, from: Vector3, moved: Vector3, share: number, rot: Quaternion): void {
    pt.subtractInPlace(from).applyRotationQuaternionInPlace(rot).addInPlace(from)
    pt.addInPlace(_v3.copyFrom(moved).scaleInPlace(share))
  }

  /**
   * One driven step (Harry's driven spring update, same arithmetic),
   * joint by joint root → tip: the body's motion carried, the target built
   * (animated ⊕ mood ⊕ reflex), the reference update against that target, the
   * muscle, the cone, the colliders again. `d.anim` holds the animated pose.
   */
  private drivenUpdate(c: Chain, d: ChainDrive, h: number, time: number): void {
    const dyn = d.state.drive.dynamics
    const n = c.bones.length

    // THE BODY: how far the chain's parent moved and turned since the last driven step.
    const parentWorld = this.parentWorldOf(c.bones[0])
    parentWorld.decompose(_bodyS, _bodyQ, _bodyP)
    let teleport = false
    if (d.bodyPrev !== null) {
      Quaternion.InverseToRef(d.bodyPrev.q, _qa)
      _bodyQ.multiplyToRef(_qa, _dq)
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w)
      const angle = 2 * Math.acos(Math.min(1, _dq.w))
      _bodyP.subtractToRef(d.bodyPrev.p, _moved)
      const dist = _moved.length()
      teleport = dist > dyn.teleportMeters || angle > (dyn.teleportDeg * Math.PI) / 180
      if (!teleport) {
        // The reflex's angular velocity (world), smoothed per step.
        const sinHalf = Math.sqrt(Math.max(0, 1 - _dq.w * _dq.w))
        if (sinHalf < 1e-9) _v1.setAll(0)
        else _v1.set(_dq.x, _dq.y, _dq.z).scaleInPlace(angle / sinHalf / h)
        const a = 1 - Math.pow(2, -h / dyn.reflex.smoothHalfLifeS)
        d.omega.addInPlace(_v1.subtractInPlace(d.omega).scaleInPlace(a))
        // INERTIA: the tail inherits `inertia` of the body's motion up to the caps; the rest is carried.
        const inheritAngle = Math.min(dyn.inertia * angle, (dyn.maxInheritDegPerS * Math.PI * h) / 180)
        const inheritDist = Math.min(dyn.inertia * dist, dyn.maxInheritSpeed * h)
        const carriedTurn = angle < 1e-12 ? 0 : 1 - inheritAngle / angle
        const carriedMove = dist < 1e-12 ? 0 : 1 - inheritDist / dist
        if (carriedTurn > 0 || carriedMove > 0) {
          slerpThree(_carryQ.copyFrom(IDENTITY_Q), _dq, carriedTurn)
          const from = d.bodyPrev.p
          for (const j of c.joints) {
            this.carry(j.currentTail, from, _moved, carriedMove, _carryQ)
            this.carry(j.prevTail, from, _moved, carriedMove, _carryQ)
          }
        }
      }
    }
    if (teleport) d.omega.setAll(0)
    if (d.bodyPrev === null) d.bodyPrev = { p: _bodyP.clone(), q: _bodyQ.clone() }
    else {
      d.bodyPrev.p.copyFrom(_bodyP)
      d.bodyPrev.q.copyFrom(_bodyQ)
    }

    // THE TARGET: animated ⊕ the mood's offsets (yaw then pitch, in each bone's bind frame) ⊕ the reflex.
    d.state.sample(time, n, d.yaw, d.pitch, d.gains)
    for (let k = 0; k < n; k++) {
      fromAxisAngle(d.yawAxes[k], d.yaw[k], _qa)
      fromAxisAngle(d.pitchAxes[k], d.pitch[k], _qb)
      _qa.multiplyInPlace(_qb)
      d.anim[k].multiplyToRef(_qa, d.driveQ[k])
    }
    if (d.state.drive.reflex && dyn.reflex.gainS > 0 && d.omega.lengthSquared() > 0) this.applyReflex(d, parentWorld, n)
    const tip = c.bones[n - 1]
    nodeQuaternion(tip.node).copyFrom(d.driveQ[n - 1])
    tip.solved!.copyFrom(d.driveQ[n - 1])

    if (teleport) {
      // RESET: the chain onto its target, velocity forgotten.
      this.teleports++
      c.joints.forEach((j, k) => {
        j.initialLocalRotation.copyFrom(d.driveQ[k])
        reseatBoneAxis(j)
        composeLocal(j.bone.node, d.driveQ[k], j.initialLocalMatrix)
        nodeQuaternion(j.bone.node).copyFrom(d.driveQ[k])
        j.bone.solved!.copyFrom(d.driveQ[k])
        this.worldFromLocal(j.bone)
        Vector3.TransformCoordinatesToRef(j.child.node.position, j.bone.world, j.currentTail)
        j.prevTail.copyFrom(j.currentTail)
        this.refreshFollowers(j)
      })
      return
    }

    const maxStep = (dyn.maxDegPerS * Math.PI * h) / 180
    const cone = (dyn.coneDeg * Math.PI) / 180
    const vCap = dyn.maxParticleSpeed * h
    c.joints.forEach((j, k) => {
      const target = d.driveQ[k]
      // THE HOOK: the reference update's target is its initial local frame; the target IS that frame now.
      j.initialLocalRotation.copyFrom(target)
      reseatBoneAxis(j)
      composeLocal(j.bone.node, target, j.initialLocalMatrix)
      // The particle's speed, capped before it integrates.
      j.currentTail.subtractToRef(j.prevTail, _v1)
      const v = _v1.length()
      if (v > vCap) j.prevTail.copyFrom(j.currentTail).subtractInPlace(_v1.scaleInPlace(vCap / v))
      this.updateJoint(j, h)

      const q = nodeQuaternion(j.bone.node)
      let changed = false
      let clamped = false
      // THE MUSCLE: close a half-life share of the angle to the target, at most the budget.
      const g = d.gains[k]
      const theta = angleTo(q, target)
      if (g > 0 && theta > 1e-9) {
        const want = theta * (1 - Math.pow(2, (-h * g) / dyn.tightHalfLifeS))
        if (want > maxStep) this.saturated++
        rotateTowards(q, target, Math.min(want, maxStep))
        changed = true
      }
      // THE CONE: past it, set on it and cancel the velocity (absorbed, not bounced).
      const off = angleTo(q, target)
      if (off > cone) {
        rotateTowards(q, target, off - cone)
        this.coneClamps++
        changed = true
        clamped = true
      }
      if (changed) {
        this.worldFromLocal(j.bone)
        Vector3.TransformCoordinatesToRef(j.child.node.position, j.bone.world, _tail)
        _before.copyFrom(_tail)
        this.collide(j, _tail, j.lastLength)
        if (!_tail.equals(_before)) this.aimAt(j, _tail)
        // `muscleMomentum` of the muscle's correction becomes velocity; a cone clamp cancels it.
        if (clamped) j.prevTail.copyFrom(_tail)
        else j.prevTail.addInPlace(_v1.copyFrom(_tail).subtractInPlace(j.currentTail).scaleInPlace(1 - dyn.muscleMomentum))
        j.currentTail.copyFrom(_tail)
      }
      j.bone.solved!.copyFrom(q)
      this.refreshFollowers(j)
    })
  }

  /**
   * The reflex (balance) layer: counter-rotate the first `joints` bones'
   * targets against the body's smoothed world angular velocity, shared 3:2:1.
   * Harry composes world orientations as quaternions (bodyQ · q0 · … · qk);
   * under Babylon's handedness `__root__` the body's world frame is MIRRORED,
   * so the same "world rotation R seen in bone k's frame" is taken as a
   * matrix conjugation Mk·R·Mk⁻¹ (row-vector), which is a proper rotation
   * whether or not Mk carries the mirror.
   */
  private applyReflex(d: ChainDrive, parentWorld: Matrix, n: number): void {
    const dyn = d.state.drive.dynamics
    _v2.copyFrom(d.omega).scaleInPlace(-dyn.reflex.gainS)
    const maxRad = (dyn.reflex.maxDeg * Math.PI) / 180
    const len = _v2.length()
    if (len > maxRad) _v2.scaleInPlace(maxRad / len)
    const total = _v2.length()
    if (total <= 0) return
    _axis.copyFrom(_v2).scaleInPlace(1 / total)
    const J = Math.min(dyn.reflex.joints, n)
    const shareSum = (J * (J + 1)) / 2
    _prefix.copyFrom(parentWorld)
    _prefix.setTranslationFromFloats(0, 0, 0)
    for (let k = 0; k < n; k++) {
      Matrix.FromQuaternionToRef(d.driveQ[k], _m1)
      if (k < J) {
        _m1.multiplyToRef(_prefix, _m2) // Mk: bone k's world linear part
        fromAxisAngle(_axis, (total * (J - k)) / shareSum, _qa)
        Matrix.FromQuaternionToRef(_qa, _m3)
        _m2.multiplyToRef(_m3, _mat) // Mk · R
        _m2.invertToRef(_inv)
        _mat.multiplyToRef(_inv, _m3) // Mk · R · Mk⁻¹
        Quaternion.FromRotationMatrixToRef(_m3, _qb)
        d.driveQ[k].multiplyInPlace(_qb)
        Matrix.FromQuaternionToRef(d.driveQ[k], _m1)
      }
      _m1.multiplyToRef(_prefix, _m2)
      _prefix.copyFrom(_m2)
    }
  }

}

