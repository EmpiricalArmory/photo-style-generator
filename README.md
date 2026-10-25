# Empirical Armory · Tuned by part

A web tool for the shop's photographs, in the house style. It runs entirely in the browser, so photos are never uploaded. It stands alone: nothing in it depends on any other tool.

**Open it:** https://empiricalarmory.github.io/photo-style-generator/
## What it does

Prints a batch of photos in Empirical Armory's inks with the toned colour, tuned part by part, with one set of settings for the whole batch.

- **A batch, one set of settings.** Add as many photos as you like, or drop a folder. The inks, the colour by part and the background apply to every photo, so the batch comes out consistent. Each photo keeps its own parts, white balance and file name.
- **Views.** One by one, with the batch in a strip below (‹ › or the arrow keys), or the whole batch as a grid with tiles from small to large. Each view shows the result, a before-and-after line you drag (Compare), the parts in their colours, or the original.
- **Hold to compare.** Hold the `\` key, or hold "Hold \ to compare" in the toolbar, to see the original for as long as you hold, in any view.
- **Inks (D116).** Fine ink is a clean duotone for the product. Story ink is the same duotone with the gravure grain, for people and places. Each ink has its own controls: black and white points, curve or contrast, grain and grain size, highlights to the substrate. You can also change the ink, paper and substrate colours.
- **Toned colour (D121), by part.** Each part has its own colour in the tool, shown on its buttons and in the Parts view:
  - **Product** (red): the gear for sale.
  - **Generic gear** (blue): what people wear or hold that isn't for sale.
  - **Skin** (amber).
  - **Steel** (violet): parts of the product that print as ink, such as blades and guards.
  - **Background** (green): everything behind.

  Product, generic gear, skin and the background each take Ink only, Quieter, Toned, Stronger or True colour. Fine-tune gives finer control: colour kept, cool colours kept, and the roll-off of the strongest colours.
- **The background** (in its Fine-tune). Printed, removed to transparent, or filled with the paper or any colour, its shadows kept if you like. The background can also be lifted toward the paper.
- **Mixes (Q60).** As decided, Product forward, Quiet stage and Only what's for sale. Your own settings can be saved as presets.
- **Auto split.** Each photo splits itself into parts as it's added, one after another. A subject model finds the foreground, a small detector finds people, and Segment Anything completes them. Long thin pieces such as blades become the product, and skin is found by colour.
- **Parts maps.** A photo's parts can come from your own painting instead. A map is an image of the photo, any size of the same shape, with the parts painted in colours of your own: either a copy of the photo painted over, or a layer of its own with the rest transparent.
  - The tool finds each colour and guesses its part: red the product, blue generic gear, orange to yellow skin, violet steel, green the background. A mid grey is steel. Black and white alone are a subject mask, the lighter part the product.
  - Change any colour's part in Parts. Your choice holds for every map in the batch, and is kept for next time.
  - What isn't painted is background, or goes to the auto split.
  - The map's edges snap to the photo's, unless you turn that off.
  - To add maps with their photos, name each after its photo with -mask, -parts or -map (gloves-mask.png for gloves.jpg). To give a photo a map with another name, load it in Parts with that photo on screen.
  - Photos without a map split automatically, as before.
- **Editing the parts.** Brush; lasso, placed point by point (click the first point, double-click or press Enter to fill); click to select (Segment Anything). Each has snap-to-edges, and every change can be undone.
- **Saving.** Each photo is saved at its own size, printed from the original file in tiles, so story ink's grain stays crisp. JPEG, PNG or WebP. Save all puts the batch in one .zip.
- **Kept in your browser.** The batch, with every photo's parts, stays in this browser until you remove it. A project (`.tuned.zip`) holds the whole batch, its parts and the settings, to move or back up.
- **The side panel** can be made wider or narrower by dragging its edge.

The first split downloads 100 to 140 MB of models from Hugging Face, and the browser keeps them for next time. Where WebGPU is available, the split runs on the graphics card and takes a few seconds a photo. Otherwise, or if the graphics card can't run a model, it runs on the processor and is slower. The models run in a background worker, so the page stays responsive.

### Shortcuts

| Key | Action |
|---|---|
| B, L, C, H | Brush, lasso, click to select, hand |
| 1 to 5 | Product, generic gear, skin, steel, background |
| `[` and `]` | Brush size |
| X | Erase (or hold Alt) |
| Enter, Backspace, Esc | Lasso: fill, take the last point back, cancel |
| R, V, P, O | Result, compare, parts, original |
| `\` (hold) | Compare: the original for as long as you hold |
| ← and → | Previous and next photo |
| G | One by one or grid |
| F | Fit |
| Space (hold) | Move the photo |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+S | Save this photo |

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step. GitHub Pages serves the repository as it is.

- `src/engine.js`: the ink and colour maths, with a CPU renderer used as the reference, and each photo's levels kept as histograms.
- `src/gl.js`: the same maths in a WebGL 2 shader, so every slider redraws at once.
- `src/print.js`: printing at any size in tiles (the grain comes from each pixel's position, so tiles join without seams), for saving and for the batch's previews.
- `src/editor.js`: the viewport, the parts overlay, the brush, lasso and click tools, the compare line, and undo.
- `src/parts.js`: the parts and their colours.
- `src/partsmap.js`: parts maps: finding the colours painted, guessing their parts, and turning them into the parts.
- `src/app.js`: the interface, the batch, saving and projects.
- `src/store.js`: the batch kept in the browser (IndexedDB), each photo's parts compressed.
- `src/zip.js`: a small zip writer and reader for Save all and projects.
- `lib/segment.js`: the auto split and click to select.
- `lib/ml-worker.js` and `lib/models.js`: the models, run in a worker. If the graphics card fails, the worker is restarted on the processor.
- `lib/imgproc.js`: filters, morphology, colour conversions, grain.
- `index.html`: the tool's page, at the repository's address; `src/tuner.css` its styles.
- `tuner/index.html`: forwards the old address to the new one.

The engine follows the recipes in the project's decisions doc (24 Oct 2026, D116 and D121) number for number.

## Third-party code, models and photos

- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0) and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), loaded from the jsDelivr CDN at pinned versions.
- Models, downloaded at run time from Hugging Face:
  - [ormbg](https://huggingface.co/onnx-community/ormbg-ONNX) (Apache-2.0)
  - [YOLOS tiny](https://huggingface.co/Xenova/yolos-tiny) (Apache-2.0)
  - [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform) (Apache-2.0)
- Sample photos (`samples/`) are openly licensed. Their credits are in `samples/samples.json` and shown in the tool:
  - Lacrosse gloves by Yarnalgo, CC BY 3.0
  - Pair of Mail Gloves, The Cleveland Museum of Art, CC0
  - The Brescia Spadona 03 by Albion Europe ApS, CC BY 2.0
  - Fencing jacket by Pschemp, CC BY 2.5
  - Borealis 2014 by paleololigo, CC BY-SA 2.0
