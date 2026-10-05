# Notice

## This library

The code in this repository — `src/`, `scripts/`, `test/` and the demo's source in `demo/` — is
released under the [MIT License](LICENSE), Copyright (c) 2026 increasinglyHuman.

## What the MIT License does not cover

**The demo's content is not part of this repository and is not licensed under MIT.** The hosted demo
plays an avatar and animation clips that are loaded at runtime and are not distributed with the source
(`demo/assets/` is git-ignored; the hosted demo's build fetches them from the `demo-assets-v1` release):

- **The avatar** (a lemur warrior) was generated with Tripo and finished in Harry: armature, skin
  weights, hand and elbow/knee correctives, tail and hair springs, surface jiggle.
- **The animations** (walk, hop, air squat) are Mixamo motions (Adobe), retargeted onto that avatar
  by Harry, with Harry's corrective bones baked in.

Both are shown in the hosted demo only. Do not extract or redistribute them. To run the demo
locally, point it at your own Harry export (see *Demo assets* in the [README](README.md)).

**The Harry for Babylon.js logo** (`docs/images/harry-babylon-hero.jpg`, the fox with the bone-chain wand) is Harry's mark,
not covered by the MIT License. Use it to refer to Harry or this library; do not modify it or use it
for other products.

## Third-party software and standards

- **[Babylon.js](https://www.babylonjs.com/)** (`@babylonjs/core`, `@babylonjs/loaders`) — Apache
  License 2.0. A peer dependency: it is not bundled into this package, including the Playground build,
  which expects Babylon as the global `BABYLON`.
- **`VRMC_springBone` 1.0** — the spring-bone glTF extension specified by the
  [VRM Consortium](https://github.com/vrm-c/vrm-specification). This library implements the
  specification's reference arithmetic; it does not include the consortium's code.
- **VRoid fallback** — the spring settings synthesised for VRoid bodies follow the values VRoid Studio
  writes by default. VRoid and VRoid Studio are products of pixiv Inc.
- **The demo's environment lighting** is loaded at runtime from Babylon.js's public asset CDN
  (`assets.babylonjs.com`); it is not part of this repository.

## Trademarks

Harry, poqpoq and the names above belong to their respective owners. Tripo, Mixamo, Adobe, VRoid and
pixiv are trademarks of their respective owners; their mention here describes compatibility and the
origin of demo content, and implies no endorsement.
