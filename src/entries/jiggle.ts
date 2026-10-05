/** `harry-babylon/jiggle`: surface jiggle (modal oscillators driving sparse morph targets). */
export {
  installSurfaceJiggleProbe,
  SurfaceJiggleReader,
  type SpringLockstep,
  type SurfaceJiggleSpringSource,
} from '../springs/SurfaceJiggleReader.js'
export { parseSurfaceJiggle, type SurfaceJiggleDeclaration, type SurfaceJiggleModeDeclaration } from '../springs/surfaceJiggleDeclaration.js'
export { createModalOscillator, type ModalOscillator, type ModeSpring } from '../springs/modalOscillator.js'
