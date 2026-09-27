# Rotating corner logo

The rotating model was retired on September 26, 2026 after owner review. The desktop now displays the original 2D `public/assets/mpo-logo-3d.webp` image directly. The notes below describe the retained model and renderer for historical reference; the dashboard no longer loads the renderer.

The desktop renders `public/assets/mpo-logo-model.glb` in the upper-right corner.
It is a real extruded letter mesh traced from `public/assets/mpo-logo-3d.webp`.
The front outlines come from the supplied artwork; the bevel, sides, and back are
constructed locally. No paid image-to-3D service or external runtime is used.

## Runtime

`public/js/mpo-logo-3d.js` renders the embedded GLB with WebGL. Its small loader
accepts the committed model's baked triangle geometry, normals, vertex colors,
and base material colors. It is deliberately not a general-purpose glTF viewer.
The format reference is the [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).

- One Y-axis revolution takes 40 seconds, with a slight fixed tilt.
- Draws are limited to 30 per second and pixel density to 2x.
- The canvas occupies the existing 240px logo area, or 180px in narrow windows.
- Reduced-motion preferences and the app's low-motion option show a still front view.
- Hidden documents suspend animation; closing the page releases buffers and observers.
- The original WebP remains visible until a valid first draw. Unsupported WebGL,
  failed loading, invalid geometry, or a lost graphics context restores that image.
- The model loads from the same origin, with an 8-second deadline and 2 MiB budget.
- The logo cannot capture pointer input or text selection. Its accessible name
  remains "Money Printer OS" on the containing image role.

These bounds and cleanup follow the relevant [WebGL resource and resolution guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).

## Model source and verification

`scripts/build-logo-model.py` builds the GLB. Its dependency versions, source hash,
model hash, dimensions, and geometry counts are recorded alongside the asset in
`public/assets/mpo-logo-model.manifest.json`. Python and those build dependencies
are not needed by the shipped app. Use an isolated Python environment to rebuild:

```text
python scripts/build-logo-model.py
npm run test:visual
```

The visual suite checks the actual model's bounds across a complete rotation,
invalid model rejection, download limits, first-draw fallback, graphics failure,
visibility, reduced motion, and cleanup. Native Electron screenshots and interaction
checks supplement these tests; see the latest section of
`reports/UPGRADE-IMPLEMENTATION-2026-09-26.md` for the tested build and artifact path.
