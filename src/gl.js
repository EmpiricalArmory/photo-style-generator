// WebGL 2 renderer for the tuner: the same maths as shadePixel() in engine.js, per pixel on the GPU, so every slider
// redraws at once. Inputs are four half-float textures packed from the engine's arrays.

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uT0; // Ly, a*, b*, grain noise
uniform highp sampler2D uT1; // gear, person, skin (of person), steel (of gear)
uniform highp sampler2D uT2; // place a/b mean, gear a/b mean (edge colours)
uniform highp sampler2D uT3; // kit a/b mean, foreground luminance mean
uniform ivec2 uSize;
uniform int uInkType;
uniform float uB, uW, uCurve, uGamma, uGrain, uRoll, uLCream, uFade, uShadows, uPlaceRef;
uniform vec3 uInkC, uPaperC, uSubC, uFillC, uS0, uS1, uS2, uS3;
uniform int uBgMode, uDither;
out vec4 fragColor;

float sm(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float s2l(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float l2s(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float f3(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
float i3(float t) { float c = t * t * t; return c > 0.008856 ? c : (t - 16.0 / 116.0) / 7.787; }
vec3 linToLab(vec3 c) {
  float X = (0.4124564 * c.r + 0.3575761 * c.g + 0.1804375 * c.b) / 0.95047;
  float Y = 0.2126729 * c.r + 0.7151522 * c.g + 0.072175 * c.b;
  float Z = (0.0193339 * c.r + 0.119192 * c.g + 0.9503041 * c.b) / 1.08883;
  float fx = f3(X), fy = f3(Y), fz = f3(Z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
vec3 labToSrgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0, fx = fy + lab.y / 500.0, fz = fy - lab.z / 200.0;
  float X = i3(fx) * 0.95047, Y = i3(fy), Z = i3(fz) * 1.08883;
  return vec3(l2s(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z), l2s(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z), l2s(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z));
}
float shapeF(vec2 ab, vec3 s) {
  if (s.x <= 0.0) return 0.0;
  float C = length(ab); if (C < 1e-6) return 0.0;
  float hd = degrees(atan(ab.y, ab.x)); if (hd < 0.0) hd += 360.0;
  float wc = sm(165.0, 200.0, hd) * (1.0 - sm(300.0, 335.0, hd));
  float Ck = C * s.x * (1.0 - wc * (1.0 - s.z));
  float Cs = s.y > 0.0 ? s.y * tanh(Ck / s.y) : Ck;
  return Cs / C;
}
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  vec4 t0 = texelFetch(uT0, p, 0), t1 = texelFetch(uT1, p, 0), t2 = texelFetch(uT2, p, 0), t3 = texelFetch(uT3, p, 0);
  float wp = t1.x, wpers = t1.y * (1.0 - wp), ws = wpers * t1.z, wk = wpers - ws, wb = max(0.0, 1.0 - wp - wpers), fg = 1.0 - wb;
  float Ly = t0.x, Lu = Ly;
  if (uBgMode != 0) { float q = sm(0.6, 0.95, fg); Lu = t3.z * (1.0 - q) + Ly * q; }
  float tp, top;
  if (uInkType == 0) {
    float raw = (Lu - uB) / (uW - uB), t = clamp(raw, 0.0, 1.0);
    tp = uCurve * t * t * (3.0 - 2.0 * t) + (1.0 - uCurve) * t; top = clamp((raw - 1.0) / uRoll, 0.0, 1.0);
  } else {
    float tt = clamp((Lu - uB) / (uW - uB), 0.0, 1.12);
    float c = 1.0 - pow(min(tt, 1.0), uGamma); c = clamp(c + uGrain * t0.w * c * (1.0 - c), 0.0, 1.0);
    tp = 1.0 - c; top = clamp((tt - 1.0) / uRoll, 0.0, 1.0);
  }
  if (uBgMode == 0 && uFade > 0.0) tp = tp + (1.0 - tp) * uFade * wb;
  vec3 baseS = uInkC + (uPaperC - uInkC) * tp;
  vec3 lab = linToLab(vec3(s2l(baseS.r), s2l(baseS.g), s2l(baseS.b)));
  vec2 AB = t0.yz;
  float qb = sm(0.6, 0.95, wb), qp = sm(0.6, 0.95, wp), qk = sm(0.6, 0.95, wk);
  vec2 bAB = mix(t2.xy, AB, qb), pAB = mix(t2.zw, AB, qp), kAB = mix(t3.xy, AB, qk);
  float fb = (uBgMode == 0 && wb > 1e-3) ? wb * shapeF(bAB, uS0) : 0.0;
  float fp = wp > 1e-3 ? wp * (1.0 - t1.w) * shapeF(pAB, uS1) : 0.0;
  float fk = wk > 1e-3 ? wk * shapeF(kAB, uS2) : 0.0;
  float fs = ws > 1e-3 ? ws * shapeF(AB, uS3) : 0.0;
  float gt = sm(0.0, 0.14, tp) * (1.0 - sm(0.9, 1.0, tp)) * (1.0 - top);
  float norm = uBgMode != 0 ? 1.0 / max(fg, 1e-3) : 1.0;
  if (gt > 0.0) {
    vec2 dab = (fb * bAB + fp * pAB + fk * kAB + fs * AB) * gt * norm;
    lab.yz += dab; lab.x = max(lab.x, min(lab.x + 0.25 * length(dab), uLCream));
  }
  vec3 rgb = labToSrgb(lab);
  float tps = uBgMode == 0 ? top * (1.0 - uFade * wb) : top;
  rgb = mix(rgb, uSubC, tps);
  if (uDither == 1) { float dv = fract(sin(float(p.x) * 12.9898 + float(p.y) * 78.233) * 43758.5453) - 0.5; rgb += dv / 255.0; }
  float alpha = 1.0;
  if (uBgMode == 1) alpha = fg;
  else if (uBgMode == 2) { float shade = uShadows > 0.0 ? 1.0 - uShadows * (1.0 - clamp(Ly / uPlaceRef, 0.0, 1.0)) : 1.0; rgb = uFillC * shade * (1.0 - fg) + rgb * fg; }
  fragColor = vec4(clamp(rgb, 0.0, 1.0), alpha);
}`;

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    this.gl = gl; this.ok = !!gl;
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.prog = prog;
    } catch (e) { console.error('Shader failed', e); this.ok = false; return; }
    gl.useProgram(this.prog);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const name of ['uT0', 'uT1', 'uT2', 'uT3', 'uSize', 'uInkType', 'uB', 'uW', 'uCurve', 'uGamma', 'uGrain', 'uRoll', 'uLCream', 'uFade', 'uShadows', 'uPlaceRef', 'uInkC', 'uPaperC', 'uSubC', 'uFillC', 'uS0', 'uS1', 'uS2', 'uS3', 'uBgMode', 'uDither']) this.u[name] = gl.getUniformLocation(this.prog, name);
    this.tex = [0, 1, 2, 3].map((k) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.uniform1i(this.u['uT' + k], k); return t; });
    this.size = [0, 0]; this.allocated = [false, false, false, false];
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  fits(w, h) { return this.ok && w <= this.maxSize && h <= this.maxSize; }

  // pack and upload the textures named in `which` (0..3) from the engine state
  upload(E, which = [0, 1, 2, 3]) {
    const gl = this.gl, { w, h, n } = E;
    if (this.size[0] !== w || this.size[1] !== h) { this.canvas.width = w; this.canvas.height = h; this.size = [w, h]; this.allocated = [false, false, false, false]; which = [0, 1, 2, 3]; }
    if (!this.buf || this.buf.length !== n * 4) this.buf = new Float32Array(n * 4);
    const b = this.buf, m = E.masks, d = E.dec;
    for (const k of which) {
      if (k === 0) for (let i = 0; i < n; i++) { const j = i * 4; b[j] = E.Ly[i]; b[j + 1] = E.lab[i * 3 + 1]; b[j + 2] = E.lab[i * 3 + 2]; b[j + 3] = E.noise ? E.noise[i] : 0; }
      if (k === 1) for (let i = 0; i < n; i++) { const j = i * 4; b[j] = m.G[i] / 255; b[j + 1] = m.P[i] / 255; b[j + 2] = m.S[i] / 255; b[j + 3] = m.ST[i] / 255; }
      if (k === 2) for (let i = 0; i < n; i++) { const j = i * 4; b[j] = d.Mba[i]; b[j + 1] = d.Mbb[i]; b[j + 2] = d.Mpa[i]; b[j + 3] = d.Mpb[i]; }
      if (k === 3) for (let i = 0; i < n; i++) { const j = i * 4; b[j] = d.Mka[i]; b[j + 1] = d.Mkb[i]; b[j + 2] = d.MLyF[i]; b[j + 3] = 0; }
      gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
      if (!this.allocated[k]) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, b); this.allocated[k] = true; }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, b);
    }
  }

  render(U) {
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.useProgram(this.prog);
    gl.uniform2i(u.uSize, this.size[0], this.size[1]);
    gl.uniform1i(u.uInkType, U.inkType);
    gl.uniform1f(u.uB, U.B); gl.uniform1f(u.uW, U.W); gl.uniform1f(u.uCurve, U.curve); gl.uniform1f(u.uGamma, U.gamma);
    gl.uniform1f(u.uGrain, U.grain); gl.uniform1f(u.uRoll, U.roll); gl.uniform1f(u.uLCream, U.LCream); gl.uniform1f(u.uFade, U.fade);
    gl.uniform1f(u.uShadows, U.shadows); gl.uniform1f(u.uPlaceRef, U.placeRef);
    gl.uniform3fv(u.uInkC, U.inkC); gl.uniform3fv(u.uPaperC, U.paperC); gl.uniform3fv(u.uSubC, U.subC); gl.uniform3fv(u.uFillC, U.fillC);
    gl.uniform3fv(u.uS0, U.S[0]); gl.uniform3fv(u.uS1, U.S[1]); gl.uniform3fv(u.uS2, U.S[2]); gl.uniform3fv(u.uS3, U.S[3]);
    gl.uniform1i(u.uBgMode, U.bgMode); gl.uniform1i(u.uDither, U.dither);
    for (let k = 0; k < 4; k++) { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, this.tex[k]); }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // the rendered pixels as ImageData (top row first), straight alpha
  read() {
    const gl = this.gl, [w, h] = this.size, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const img = new ImageData(w, h), d = img.data, row = w * 4;
    for (let y = 0; y < h; y++) d.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }

  dispose() { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
}
