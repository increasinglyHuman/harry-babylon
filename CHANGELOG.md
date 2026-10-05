# Changelog

All notable changes to `@poqpoq/harry-babylon` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/) (while it is 0.x, a minor version may break the API).

## [0.1.0] — 2026-10-05

The first release: the runtime poqpoq World uses for avatars finished in
[Harry](https://poqpoq.com/harry/), packaged for Babylon.js 9.

### Added
- `attachHarryPhysics(root, scene, meshes, options)`: one call that wires an avatar's declared
  springs and surface jiggle, with per-avatar options (springs or jiggle on or off, distance LOD,
  pause off-screen, a shared crowd budget via `createHarryBudget`).
- **Springs** (`/springs`): a `VRMC_springBone` 1.0 parser and loader extension, `SpringBoneRuntime`
  (the specification's reference arithmetic, with a ground plane), `DeclaredSpringBones`, and the layered
  drive behind Harry's tail moods (wag, lash, tuck, still, twitch, loose).
- **Surface jiggle** (`/jiggle`): `SurfaceJiggleReader`, the `extras.poqpoq.surface` parser, and the
  modal oscillator behind breast, belly, glute and hair bounce.
- **Clips** (`/clips`): `bindClipToSkeleton` with rest-anchored clavicles, and hip-height compensation
  for clips authored on a different body.
- **VRoid** (`/vroid`): spring synthesis for VRoid bodies that carry no springs.
- **Playground build** (`/playground`): one minified ES module that reads Babylon from the global
  `BABYLON`, for the Babylon Playground and plain pages.
