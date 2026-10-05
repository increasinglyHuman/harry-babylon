/**
 * Harry's stage, in Babylon: the review "lens" Harry's three.js viewport uses to judge generated
 * PBR avatars, rebuilt so a Harry export looks here the way it looked in Harry.
 *
 *  - Khronos PBR Neutral tone mapping, exposure 1 (preserves albedo hue/saturation, unlike ACES).
 *  - An image-based fill at intensity 0.45 instead of a flat ambient: irradiance that varies with
 *    the normal is what shows form, and it is the only fill that lights metals.
 *  - One white key light, OFF the viewing azimuth (≈56° from the default 3/4 view, ≈40° up) so
 *    axial twist reads as a vertical terminator; soft PCF shadows from a 2048² map.
 *  - The stage is chrome, not specimen, so it is exempt from the tone map: a near-black void
 *    (#0a0a0a), a #202020 pool fading radially into it, a shadow catcher at 40% darkness, and a
 *    0.5 m grid (#2a2a2a axis lines, #1a1a1a the rest).
 *
 * Reusable: `createHarryStage(scene, { size, poolRadius })`, then `stage.addShadowCasters(meshes)`.
 */
import {
  BackgroundMaterial,
  Color3,
  Color4,
  CubeTexture,
  DirectionalLight,
  DynamicTexture,
  ImageProcessingConfiguration,
  MeshBuilder,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
  type ArcRotateCamera,
  type Mesh,
  type Nullable,
  type Observer,
  type Scene,
} from '@babylonjs/core'

/** Babylon's own studio environment (prefiltered .env), served from its asset CDN. */
export const STAGE_ENVIRONMENT_URL = 'https://assets.babylonjs.com/environments/studio.env'

/** Harry's lens values. */
export const ENVIRONMENT_INTENSITY = 0.45
/**
 * Harry's key, 2.6. Both engines' PBR diffuse is Lambert with 1/π and an unscaled directional
 * irradiance, so the number carries over as-is.
 */
export const KEY_INTENSITY = 2.6
/**
 * Direction from the subject to the key, for a subject facing +Z. Harry's is (−1.4, 2.8, 3) in
 * three's right-handed world; Babylon is left-handed (and a glTF loads under a mirroring root),
 * so x flips to keep the key on the same side of the face as seen from the front.
 */
export const KEY_DIRECTION = new Vector3(1.4, 2.8, 3)
/** Default 3/4 view direction (Harry's (0.6, 0.35, 1), mirrored the same way). */
export const VIEW_DIRECTION = new Vector3(-0.6, 0.35, 1)
export const CATCHER_OPACITY = 0.4
export const STAGE_BACKGROUND = '#0a0a0a'
export const POOL_COLOR = '#202020'
export const GRID_MAJOR = '#2a2a2a'
export const GRID_MINOR = '#1a1a1a'

export interface HarryStageOptions {
  /** Grid edge length in metres (0.5 m cells). Default 10, as in Harry. */
  size?: number
  /** Radius of the pool / shadow catcher. Default 2.5. */
  poolRadius?: number
  /** Load the CDN environment (default true). False = no image-based fill. */
  environment?: boolean
  /** Override the key intensity (default KEY_INTENSITY). */
  keyIntensity?: number
  /** Override the environment intensity (default ENVIRONMENT_INTENSITY). */
  environmentIntensity?: number
}

export interface HarryStage {
  readonly key: DirectionalLight
  /**
   * Seat the key relative to `camera` every frame, as Harry seats it relative to the framed view:
   * Harry's key/view geometry turned about the vertical by the camera's azimuth, so the key always
   * sits over the camera's shoulder (≈56° off the lens axis, ≈40° up) and shadows fall away from it.
   */
  lightFrom(camera: ArcRotateCamera): void
  readonly shadows: ShadowGenerator
  /** Meshes that cast onto the catcher (avatars cast, they do not receive — as in Harry). */
  addShadowCasters(meshes: readonly AbstractMesh[]): void
  /** Grow or shrink the stage (grid edge, pool radius), e.g. when a crowd arrives. */
  resize(size: number, poolRadius: number): void
  dispose(): void
}

/** A configuration with tone mapping OFF, for stage chrome (Harry exempts the stage from the lens). */
function chromeImageProcessing(): ImageProcessingConfiguration {
  const c = new ImageProcessingConfiguration()
  c.toneMappingEnabled = false
  c.exposure = 1
  c.contrast = 1
  return c
}

function radialFalloff(scene: Scene): DynamicTexture {
  const size = 128
  const tex = new DynamicTexture('stagePoolFalloff', { width: size, height: size }, scene, false)
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.55, '#a0a0a0')
  g.addColorStop(1, '#000000')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  tex.update()
  tex.getAlphaFromRGB = true
  return tex
}

function buildGrid(scene: Scene, size: number): Mesh {
  const divisions = Math.max(2, Math.round(size / 0.5))
  const half = size / 2
  const step = size / divisions
  const lines: Vector3[][] = []
  const colors: Color4[][] = []
  const major = Color4.FromHexString(`${GRID_MAJOR}ff`)
  const minor = Color4.FromHexString(`${GRID_MINOR}ff`)
  for (let i = 0; i <= divisions; i++) {
    const p = -half + i * step
    const c = Math.abs(p) < step / 2 ? major : minor
    lines.push([new Vector3(p, 0, -half), new Vector3(p, 0, half)], [new Vector3(-half, 0, p), new Vector3(half, 0, p)])
    colors.push([c, c], [c, c])
  }
  const grid = MeshBuilder.CreateLineSystem('stageGrid', { lines, colors }, scene)
  grid.isPickable = false
  grid.position.y = 0.0005
  return grid
}

export function createHarryStage(scene: Scene, options: HarryStageOptions = {}): HarryStage {
  // The void: the clear colour is written as-is (Babylon applies image processing per material,
  // never to the clear), so the token needs none of the compensation three's output pass needs.
  scene.clearColor = Color4.FromHexString(`${STAGE_BACKGROUND}ff`)

  // The lens: Khronos PBR Neutral, exposure 1, on the specimen's (PBR) materials.
  const ip = scene.imageProcessingConfiguration
  ip.toneMappingEnabled = true
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL
  ip.exposure = 1
  ip.contrast = 1

  // The fill: image-based, at Harry's intensity.
  if (options.environment !== false) {
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(STAGE_ENVIRONMENT_URL, scene)
  }
  scene.environmentIntensity = options.environmentIntensity ?? ENVIRONMENT_INTENSITY

  // The key.
  const keyDir = KEY_DIRECTION.clone().normalize()
  const key = new DirectionalLight('stageKey', keyDir.scale(-1), scene)
  key.position = keyDir.scale(12)
  key.intensity = options.keyIntensity ?? KEY_INTENSITY
  key.diffuse = Color3.White()
  key.specular = Color3.White()
  key.shadowMinZ = 0.1
  key.shadowMaxZ = 40
  key.autoUpdateExtends = true
  key.autoCalcShadowZBounds = true

  const shadows = new ShadowGenerator(2048, key)
  shadows.usePercentageCloserFiltering = true
  shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH
  shadows.bias = 0.0004
  shadows.normalBias = 0.02

  const chrome = chromeImageProcessing()

  // The pool: #202020 fading radially into the void; unlit, tone-map exempt.
  const poolMat = new StandardMaterial('stagePoolMat', scene)
  poolMat.disableLighting = true
  poolMat.emissiveColor = Color3.FromHexString(POOL_COLOR)
  poolMat.diffuseColor = Color3.Black()
  poolMat.specularColor = Color3.Black()
  poolMat.opacityTexture = radialFalloff(scene)
  poolMat.imageProcessingConfiguration = chrome
  poolMat.backFaceCulling = false
  let pool: Mesh = MeshBuilder.CreateDisc('stagePool', { radius: 1, tessellation: 64 }, scene)
  pool.rotation.x = Math.PI / 2
  pool.material = poolMat
  pool.isPickable = false

  // The catcher: shadow only, 40% dark, over the pool.
  const catcherMat = new BackgroundMaterial('stageCatcherMat', scene)
  catcherMat.shadowOnly = true
  catcherMat.primaryColor = Color3.Black()
  catcherMat.shadowLevel = 0
  // Only the catcher receives (avatars cast but do not receive, as in Harry), so the generator's
  // darkness is the catcher's opacity: 0 = black, 1 = none.
  shadows.setDarkness(1 - CATCHER_OPACITY)
  catcherMat.imageProcessingConfiguration = chrome
  let catcher: Mesh = MeshBuilder.CreateGround('stageCatcher', { width: 2, height: 2 }, scene)
  catcher.position.y = 0.001
  catcher.receiveShadows = true
  catcher.material = catcherMat
  catcher.isPickable = false

  let grid = buildGrid(scene, options.size ?? 10)

  const place = (size: number, poolRadius: number): void => {
    pool.scaling.setAll(poolRadius)
    catcher.scaling.set(poolRadius * 1.1, 1, poolRadius * 1.1)
    grid.dispose()
    grid = buildGrid(scene, size)
  }
  place(options.size ?? 10, options.poolRadius ?? 2.5)

  let follower: Nullable<Observer<Scene>> = null
  const viewAz = Math.atan2(VIEW_DIRECTION.x, VIEW_DIRECTION.z)
  const dir = new Vector3()
  const lightFrom = (camera: ArcRotateCamera): void => {
    if (follower) scene.onBeforeRenderObservable.remove(follower)
    follower = scene.onBeforeRenderObservable.add(() => {
      const d = camera.position.subtract(camera.target)
      const turn = Math.atan2(d.x, d.z) - viewAz
      const c = Math.cos(turn)
      const sn = Math.sin(turn)
      // Rotate about +Y so the azimuth atan2(x, z) grows by `turn`.
      dir.set(keyDir.x * c + keyDir.z * sn, keyDir.y, keyDir.z * c - keyDir.x * sn)
      key.direction.copyFrom(dir).scaleInPlace(-1)
      key.position.copyFrom(camera.target).addInPlace(dir.scale(12))
    })
  }

  return {
    key,
    shadows,
    lightFrom,
    addShadowCasters(meshes) {
      for (const m of meshes) {
        if (m.getTotalVertices() === 0) continue
        shadows.addShadowCaster(m, false)
        m.receiveShadows = false
      }
    },
    resize: place,
    dispose() {
      if (follower) scene.onBeforeRenderObservable.remove(follower)
      shadows.dispose()
      key.dispose()
      pool.dispose()
      catcher.dispose()
      grid.dispose()
      poolMat.dispose(true, true)
      catcherMat.dispose()
      pool = null as unknown as Mesh
      catcher = null as unknown as Mesh
    },
  }
}
