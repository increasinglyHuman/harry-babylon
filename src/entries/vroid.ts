/**
 * `harry-babylon/vroid`: springs for VRoid bodies whose file lost its VRMC_springBone. Call
 * `registerVRoidSynthesis()` to let `attachHarryPhysics` use it (the main entry already does).
 */
export {
  categoryOf,
  REFERENCE_TORSO,
  synthesizeVRoidSprings,
  VROID_SETTINGS,
  type RestSpace,
  type SynthNode,
  type VRoidSpringCategory,
  type VRoidSynthesis,
} from '../springs/vroidSpringSynthesis.js'
export {
  registerVRoidSynthesis,
  restSpace,
  springsForBody,
  springsFromVRoidNames,
  toSynthNode,
  type BabylonSynthNode,
  type VRoidSprings,
} from '../springs/vroidSprings.js'
