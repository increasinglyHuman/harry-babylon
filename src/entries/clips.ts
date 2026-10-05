/** `harry-babylon/clips`: the same-family clip binder and its hip-height compensation. */
export { bindClipToSkeleton, REST_ANCHORED_BONES, type ClipBindResult } from '../clipBinder.js'
export {
  HIP_BONE_NAMES,
  HIP_SCALE_EPSILON,
  isGroundedPoseKey,
  isHipPositionTrack,
  MIN_HIP_REST_LENGTH,
  resolveHipScale,
  scaleHipKeysOnce,
  type HipKeyLike,
  type HipScaleDecision,
} from '../hipHeightCompensation.js'
