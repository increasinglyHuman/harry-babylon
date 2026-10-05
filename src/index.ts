/**
 * harry-babylon — the Babylon.js runtime for avatars exported by Harry.
 *
 * Importing this entry registers the `VRMC_springBone` glTF loader extension, so every GLB
 * loaded afterwards keeps its declared springs for `attachHarryPhysics`. Import it BEFORE
 * loading the avatar. It also enables the VRoid fallback for `attachHarryPhysics` (module
 * state only). It installs nothing on `globalThis`: the console probes are opt-in
 * (`options.debug` or `installHarryDebugGlobals()`).
 */

import { registerVRMCSpringBoneExtension } from './springs/vrmcSpringBoneLoaderExtension.js'
import { registerVRoidSynthesis } from './springs/vroidSprings.js'

registerVRoidSynthesis()

export * from './entries/springs.js'
export * from './entries/jiggle.js'
export * from './entries/clips.js'
export * from './entries/vroid.js'
export {
  attachHarryPhysics,
  DEFAULT_LOD_FAR,
  DEFAULT_LOD_FAR_HZ,
  DEFAULT_LOD_NEAR,
  installHarryDebugGlobals,
  isOffscreen,
  type HarryLodOptions,
  type HarryPhysics,
  type HarryPhysicsOptions,
} from './attach.js'
export { createHarryBudget, type HarryBudget, type HarryBudgetEntry, type HarryBudgetOptions } from './budget.js'

/**
 * Explicitly (re-)register the `VRMC_springBone` loader extension. Importing the package already
 * does this; call it if a bundler dropped the side-effect import, or after something else
 * unregistered the extension. Idempotent.
 */
export function registerHarryLoaderExtension(): void {
  registerVRMCSpringBoneExtension()
}
