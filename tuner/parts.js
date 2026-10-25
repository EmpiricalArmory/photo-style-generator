// The parts a photo is split into, with the colour each one shows in the Parts view and wherever it is named.
// The ids are the engine's (masks G = product, P = person: generic gear and skin, S = skin share, ST = steel share);
// the background is whatever is left.
export const PARTS = [
  { id: 'gear', label: 'Product', key: '1', hex: '#D9472B', hint: 'The product for sale' },
  { id: 'kit', label: 'Generic gear', key: '2', hex: '#2F6BD8', hint: 'Gear that people wear or hold that isn’t for sale' },
  { id: 'skin', label: 'Skin', key: '3', hex: '#EFB02E', hint: 'Bare hands, wrists and faces' },
  { id: 'steel', label: 'Steel', key: '4', hex: '#8B55D9', hint: 'Parts of the product that print as ink: blades, guards' },
  { id: 'place', label: 'Background', key: '5', hex: '#2E9E55', hint: 'Everything behind; painting it takes the other parts away' },
];
export const PART = Object.fromEntries(PARTS.map((p) => [p.id, p]));
export const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
for (const p of PARTS) p.rgb = rgbOf(p.hex);
