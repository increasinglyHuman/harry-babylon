/** `harry-babylon/springs`: the declared-spring runtime, its declaration and drive, and the glTF loader extension (registered on import). */
export {
  DeclaredSpringBones,
  installTailMoodProbe,
  MIN_LOD_FAR_HZ,
  rotationKeyed,
  type SpringFrameSignal,
  type SpringLodConfig,
  type SpringSimulationState,
} from '../springs/DeclaredSpringBones.js'
export { SpringBoneRuntime, type GroundPlane, type SpringBoneRuntimeOptions, type SpringBoneRuntimeProbe } from '../springs/SpringBoneRuntime.js'
export {
  parseVRMCSpringBone,
  VRMC_SPRING_BONE,
  type SpringBoneDeclaration,
  type SpringCollider,
  type SpringColliderCapsule,
  type SpringColliderSphere,
  type SpringDeclarationEntry,
  type SpringJointSettings,
  type SpringSegment,
  type Vec3Tuple,
} from '../springs/springBoneDeclaration.js'
export {
  DriveState,
  moodAngles,
  moodFade,
  moodGains,
  parseSpringDrive,
  TAIL_MOOD_FADE_SECONDS,
  TAIL_MOOD_SET,
  TAIL_MOODS,
  type MoodDefinition,
  type SpringDrive,
  type SpringDynamics,
  type TailMood,
  type WagKnobs,
} from '../springs/springDrive.js'
export {
  registerSpringBoneSource,
  registerVRMCSpringBoneExtension,
  takeSpringBoneSource,
  type SpringBoneSource,
} from '../springs/vrmcSpringBoneLoaderExtension.js'
