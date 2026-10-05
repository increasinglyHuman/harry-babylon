/**
 * vrmcSpringBoneLoaderExtension — hand the `VRMC_springBone` JSON and the
 * glTF node → TransformNode map to whoever imported the file.
 *
 * Babylon's glTF loader does not keep root-level extensions it does not
 * implement, and node indices are gone once the scene is built. A registered
 * loader extension sees both, per load: on `onReady` it files them under the
 * load's `__root__` node, where the avatar setup (see `attachHarryPhysics`) picks them up with
 * `takeSpringBoneSource(root)`. Keyed per root (a WeakMap), so two avatars
 * loading at once cannot swap springs — no global "last parsed" slot.
 *
 * Importing this module registers the extension (idempotent).
 */

import type { TransformNode } from '@babylonjs/core'
import { registerGLTFExtension, unregisterGLTFExtension, type GLTFLoader, type IGLTFLoaderExtension } from '@babylonjs/loaders/glTF/2.0/index.js'
import { VRMC_SPRING_BONE } from './springBoneDeclaration.js'

export interface SpringBoneSource {
  /** `json.extensions.VRMC_springBone`, verbatim. */
  extension: unknown
  /** glTF node index → the TransformNode Babylon built for it (null if none). */
  nodes: (TransformNode | null)[]
}

const sources = new WeakMap<TransformNode, SpringBoneSource>()

/**
 * File a source for a root yourself — for a model built without the glTF
 * loader, and for tests that drive DeclaredSpringBones on a synthetic rig.
 */
export function registerSpringBoneSource(root: TransformNode, source: SpringBoneSource): void {
  sources.set(root, source)
}

/** The springs a load declared, for the root it produced; removed once taken. */
export function takeSpringBoneSource(root: TransformNode): SpringBoneSource | null {
  const s = sources.get(root) ?? null
  sources.delete(root)
  return s
}

class VRMCSpringBoneLoaderExtension implements IGLTFLoaderExtension {
  readonly name = VRMC_SPRING_BONE
  enabled: boolean
  private loader: GLTFLoader | null

  constructor(loader: GLTFLoader) {
    this.loader = loader
    this.enabled = loader.isExtensionUsed(VRMC_SPRING_BONE)
  }

  onReady(): void {
    const loader = this.loader
    if (!loader) return
    const root = loader.rootBabylonMesh
    const extension = (loader.gltf.extensions as Record<string, unknown> | undefined)?.[VRMC_SPRING_BONE]
    if (root && extension !== undefined) {
      const nodes = (loader.gltf.nodes ?? []).map((n) => n._babylonTransformNode ?? null)
      sources.set(root, { extension, nodes })
    }
  }

  dispose(): void {
    this.loader = null
  }
}

/** (Re-)register the loader extension with Babylon's glTF loader. Idempotent; runs once on import. */
export function registerVRMCSpringBoneExtension(): void {
  unregisterGLTFExtension(VRMC_SPRING_BONE)
  registerGLTFExtension(VRMC_SPRING_BONE, true, (loader) => new VRMCSpringBoneLoaderExtension(loader))
}

registerVRMCSpringBoneExtension()
