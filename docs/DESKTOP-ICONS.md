# Desktop icon set

Every desktop shortcut uses a 96 × 96 transparent PNG in `public/assets/icons/`.
The eleven additions were generated with the built-in image generation tool, then
downsampled to 96 × 96 with high-quality interpolation. Existing icons were preserved.
`artifacts/icon-review-20260926.png` shows the complete desktop set at native size.

The generated prompts used this shared frame, with the subject from the table below:

> Use case: logo-brand. Asset type: square transparent desktop PNG icon for a retro
> Windows-style trading workstation. Create one icon for **[app]**: **[subject]**.
> Object only, centered, fills 82% of a square, crisp readable silhouette at 56px,
> polished beveled glossy clip-art with highlights and deep outlines, cohesive with
> late-1990s desktop icons. True transparent background with clean alpha. No text,
> no letters, no border tile, no watermark.

| App | Subject |
| --- | --- |
| Command Center | A compact dark charcoal command console/monitor with a vivid electric cyan radar screen and one small green status light. |
| Kalshi | A cobalt blue prediction-market ballot card with a white checkmark and a tiny gold coin. |
| Arbitrage | Two interlocking gold and cyan circular market arrows around a small silver coin. |
| Wire | A silver newswire antenna tower emitting two bright amber signal arcs. |
| Stocks | A glossy emerald rising candlestick chart with a compact dark navy graph backing. |
| Market Lab | A violet glass laboratory flask with a rising turquoise mini chart inside. |
| Macro | A small dark blue globe with a bright gold economic pulse line and upward bar chart. |
| EDGAR | A cream-colored official financial filing folder with a wax-red seal and tiny green chart, no readable text. |
| Weather | A silver storm cloud with bright sun peeking behind it and a short electric-blue lightning bolt. |
| Sports | A gold trophy cup with a small white baseball at its base. |
| Journal | A leather-bound navy trading journal open to pale pages with a gold fountain pen across it. |

The Command Center prompt used the same constraints with `85%` fill and a slightly
more explicit console description. All eleven final PNGs live in the project icon
directory; generated high-resolution originals remain in Codex's generated-images
directory and are not required by the app.
