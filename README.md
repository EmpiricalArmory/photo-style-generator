# Empirical Armory · photo tools

Web tools for the shop's photographs, in the house style. Each runs entirely in the browser, so photos are never uploaded.

**Open them:** https://empiricalarmory.github.io/photo-style-generator/

## Tuned by part

https://empiricalarmory.github.io/photo-style-generator/tuner/

Prints a photo in Empirical Armory's inks with the toned colour, and tunes the colour part by part.

- **Inks (D116).** Fine ink is a clean duotone for the gear. Story ink is the same duotone with the gravure grain, for people and places. Each ink has its own controls: black and white points, curve or contrast, grain and grain size, highlights to the substrate. You can also change the ink, paper and substrate colours.
- **Toned colour (D121).** The photo's own colour, white-balanced and laid back into the ink's tones. You set it per part:
  - **Gear for sale**, **Kit worn**, **Skin** and **The place behind** each take Ink only, Quieter, Toned, Stronger or True colour.
  - Fine-tune gives finer control: colour kept, cool colours kept, and the roll-off of the strongest colours.
  - The place can also be lifted toward the paper.
  - **Steel** prints as ink.
- **Mixes (Q60).** As decided, Gear forward, Quiet stage and Only what's for sale. Your own settings can be saved as presets.
- **Auto split.** The photo splits itself into parts. A subject model finds the foreground, a small detector finds people, and Segment Anything completes them. Long thin pieces such as blades become gear, and skin is found by colour.
- **Editing the parts.** Brush, lasso, and click to select (Segment Anything). Each has snap-to-edges, and every change can be undone.
- **Background.** Keep it printed, remove it to transparent, or fill it with the paper or any colour, keeping its shadows if you like.
- **Saving.** Choose any long side, a square of the whole photo, or a square framed on the subject (D117: the subject at 70% of the height). Formats are JPEG, PNG or WebP. The ink is drawn at the size you save.
- **Projects** (`.tuned.json`) keep the photo, the parts and the settings, so you can carry on later.

The first split downloads about 55 MB of models from Hugging Face, and the browser keeps them for next time. Where WebGPU is available, the split runs on the graphics card. Otherwise it runs on the processor and is slower.

### Shortcuts

| Key | Action |
|---|---|
| B, L, C, H | Brush, lasso, click to select, hand |
| 1 to 5 | Gear, kit, skin, steel, place |
| `[` and `]` | Brush size |
| X | Erase (or hold Alt) |
| R, P, O | Views: result, parts, original |
| `\` (hold) | Compare with the original |
| F | Fit |
| Space (hold) | Move the photo |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+S | Save image |

## Scene generator

Next: your real product photo, with the place, the hands and the light generated around it, handed to Tuned by part.

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step. GitHub Pages serves the repository as it is.

- `tuner/engine.js`: the ink and colour maths, with a CPU renderer used as the reference.
- `tuner/gl.js`: the same maths in a WebGL 2 shader, so every slider redraws at once.
- `tuner/editor.js`: the viewport, the parts overlay, the brush, lasso and click tools, and undo.
- `tuner/app.js`: the interface, export and projects.
- `shared/segment.js`: the auto split and click to select.
- `shared/imgproc.js`: filters, morphology, colour conversions.

The engine follows the recipes in the project's decisions doc (24 Oct 2026, D116 and D121) number for number.

## Third-party code, models and photos

- [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 (Apache-2.0) and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT), loaded from the jsDelivr CDN at pinned versions.
- Models, downloaded at run time from Hugging Face:
  - [ormbg](https://huggingface.co/onnx-community/ormbg-ONNX) (Apache-2.0)
  - [BiRefNet lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) (MIT)
  - [YOLOS tiny](https://huggingface.co/Xenova/yolos-tiny) (Apache-2.0)
  - [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform) (Apache-2.0)
- Sample photos (`samples/`) are openly licensed. Their credits are in `samples/samples.json` and shown in the tool:
  - Lacrosse gloves by Yarnalgo, CC BY 3.0
  - Pair of Mail Gloves, The Cleveland Museum of Art, CC0
  - The Brescia Spadona 03 by Albion Europe ApS, CC BY 2.0
  - Fencing jacket by Pschemp, CC BY 2.5
  - Borealis 2014 by paleololigo, CC BY-SA 2.0
