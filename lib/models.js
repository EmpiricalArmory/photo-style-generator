// The models the split uses, and where Transformers.js comes from. Shared by the page (segment.js) and the model
// worker (ml-worker.js). Weights download once from Hugging Face and the browser keeps them.
//   subject: onnx-community/ormbg-ONNX (Apache-2.0), finds the foreground
//   people:  Xenova/yolos-tiny (Apache-2.0), a small object detector, used for its "person" boxes
//   sam:     Xenova/slimsam-77-uniform (Apache-2.0), Segment Anything distilled, for click to select
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

export const MODELS = {
  subject: { id: 'onnx-community/ormbg-ONNX', name: 'Subject (ormbg)', dtype: { webgpu: 'fp16', wasm: 'q8' } },
  people: { id: 'Xenova/yolos-tiny', name: 'People (YOLOS tiny)', dtype: { webgpu: 'fp32', wasm: 'q8' } },
  sam: { id: 'Xenova/slimsam-77-uniform', name: 'Click to select (SlimSAM)', dtype: { webgpu: 'fp16', wasm: 'fp32' } },
};
