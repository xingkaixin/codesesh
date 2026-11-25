const VERTEX_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const COMMON_GLSL = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;
uniform float u_scale;
uniform vec4 u_uvRect;
uniform float u_dark;
uniform vec4 u_amb;
uniform vec4 u_off;
uniform vec2 u_mix;
uniform sampler2D u_art;
uniform sampler2D u_mask;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.1 + 3.3);
}

// Dual phase-shifted FBM layers prevent coordinate overflow during infinite drift
float drifting(vec2 p, float a, float b, float w, float size) {
  float na = fbm(vec2(p.x - a, p.y) / size);
  float nb = fbm(vec2(p.x - b, p.y) / size + vec2(17.3, 9.1));
  return (mix(na, nb, w) - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w)) + 0.5;
}

float bandMask(float y01, float at) {
  float d = (y01 - at) / 0.115;
  return exp(-d * d);
}

vec3 applyAmbient(vec3 color, vec3 orig, float mtn, float contour, float ember, vec2 wp, float artY) {
  float strength = u_amb.x;
  if (strength <= 0.001) return color;

  float c = drifting(vec2(wp.x, wp.y * 1.55), u_off.x, u_off.y, u_mix.x, 190.0);
  float cloudShadow = smoothstep(0.47, 0.64, c);
  float sunGap = 1.0 - smoothstep(0.32, 0.45, c);

  // Continuous gentle cloud shadow across the full stage (no boundary seam at the skyline)
  vec3 cloudTint = mix(vec3(0.955, 0.96, 0.975), vec3(0.92, 0.935, 0.96), u_dark);
  vec3 outCol = mix(color, color * cloudTint, cloudShadow * u_amb.y * 0.58 * strength);
  outCol = mix(outCol, outCol * vec3(1.015, 1.01, 0.995), sunGap * u_amb.w * 0.42 * strength);

  // Deeper shadow contrast & luminous ridge/dot sun-catch inside the mountain body
  float mtnBody = smoothstep(0.12, 0.68, mtn);
  outCol = mix(outCol, outCol * vec3(0.84, 0.88, 0.96), cloudShadow * u_amb.y * 0.55 * strength * mtnBody);
  outCol += orig * (0.14 + 0.24 * contour + 0.16 * ember) * sunGap * u_amb.w * strength * mtnBody;

  // Slow valley mist anchored to mountain foothill elevation bands
  float band = min(1.0, bandMask(artY, 0.13) + bandMask(artY, 0.27));
  float mistField = smoothstep(0.43, 0.68, drifting(vec2(wp.x, wp.y * 5.0), u_off.z, u_off.w, u_mix.y, 150.0));
  float m = band * mistField * u_amb.z * strength * mtnBody * (1.0 - ember * 0.72);
  vec3 mistCol = mix(vec3(0.86, 0.85, 0.81), vec3(0.14, 0.20, 0.27), u_dark);
  outCol = mix(outCol, mistCol, m * mix(0.18, 0.26, u_dark));

  return clamp(outCol, 0.0, 1.0);
}
`;

const INTRO_FRAG_SRC = `${COMMON_GLSL}
uniform float u_t;

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  vec2 auv = u_uvRect.xy + uv * u_uvRect.zw;
  vec2 wp = vec2(frag.x - 0.5 * u_res.x, u_res.y - frag.y) / u_scale;
  vec2 sp = wp + vec2(311.0, 57.0);

  vec3 orig = texture2D(u_art, auv).rgb;
  vec3 m = texture2D(u_mask, auv).rgb;
  float mtn = m.r;
  float contour = m.g;
  float ember = m.b;

  // Rows 0.62..0.94 in flipped-Y texture space are guaranteed pure linen sky above the peak
  float skyY = 0.62 + (1.0 - abs(fract(auv.y * 1.15) * 2.0 - 1.0)) * 0.32;
  vec3 skyFill = texture2D(u_art, vec2(auv.x, skyY)).rgb;
  vec3 paper = mix(orig, skyFill, mtn);

  // Stage 1: organic left-to-right contour & ridge ink sweep
  float ml = smoothstep(0.0, 0.12, u_t * 2.45 - uv.x - 0.24 * vnoise(sp / 56.0));
  float tooth = 0.55 * vnoise(sp * 1.9) + 0.45 * vnoise(sp * 0.71 + 31.0);
  float grain = vnoise(sp * 2.5 + 11.0);
  float stroke = clamp(contour * ml * (0.72 + 0.56 * smoothstep(0.18, 0.80, 0.55 * grain + 0.45 * tooth)), 0.0, 1.0);

  vec3 baseInk = mix(vec3(0.14, 0.15, 0.20), vec3(0.12, 0.14, 0.20), u_dark);
  vec3 ridgeInk = mix(vec3(0.76, 0.31, 0.11), vec3(0.88, 0.36, 0.12), u_dark);
  vec3 inkCol = mix(baseInk, ridgeInk, ember * mix(0.64, 0.78, u_dark));
  float penTip = ml * (1.0 - ml) * 4.0;
  vec3 sketched = mix(paper, inkCol, stroke * 0.88) + vec3(0.96, 0.44, 0.16) * ember * penTip * 0.26;

  // Stage 2: delayed organic FBM bloom revealing the obsidian terrain & glowing topography
  float mw = smoothstep(0.0, 0.30, (u_t - 0.18) * 2.15 - 0.52 * uv.x - 0.78 * fbm(sp / 108.0 + 5.0));
  float frontier = mw * (1.0 - mw) * 4.0;
  vec3 color = mix(sketched, orig, mw);
  color += vec3(0.98, 0.45, 0.14) * ember * frontier * 0.22 * mtn;

  gl_FragColor = vec4(applyAmbient(clamp(color, 0.0, 1.0), orig, mtn, contour, ember, wp, auv.y), 1.0);
}
`;

const AMBIENT_FRAG_SRC = `${COMMON_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / u_res;
  vec2 auv = u_uvRect.xy + uv * u_uvRect.zw;
  vec2 wp = vec2(frag.x - 0.5 * u_res.x, u_res.y - frag.y) / u_scale;

  vec3 orig = texture2D(u_art, auv).rgb;
  vec3 m = texture2D(u_mask, auv).rgb;

  gl_FragColor = vec4(applyAmbient(orig, orig, m.r, m.g, m.b, wp, auv.y), 1.0);
}
`;

const WORLD_H = 380;
const INTRO_DURATION = 2.6;
const AMBIENT_FADE_IN = 2.2;
const WIND_SPEED = 10.5;
const AIR_RATES = [12, 15, 20, 24, 30] as const;
const AIR_STEP = 0.8;
const PERIODS = [90, 90, 140, 140] as const;
const SHIFTS = [0, 0.5, 0, 0.5] as const;
const LOAD_TIMEOUT_MS = 2500;
const MOBILE_BREAKPOINT = 760;

interface CommonUniforms {
  res: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  uvRect: WebGLUniformLocation | null;
  dark: WebGLUniformLocation | null;
  amb: WebGLUniformLocation | null;
  off: WebGLUniformLocation | null;
  mix: WebGLUniformLocation | null;
  art: WebGLUniformLocation | null;
  mask: WebGLUniformLocation | null;
}

interface IntroUniforms extends CommonUniforms {
  t: WebGLUniformLocation | null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function smoothstep(lo: number, hi: number, x: number): number {
  const u = clamp((x - lo) / (hi - lo), 0, 1);
  return u * u * (3 - 2 * u);
}

function compileProgram(
  gl: WebGLRenderingContext,
  vSrc: string,
  fSrc: string,
): WebGLProgram | null {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;

  gl.shaderSource(vs, vSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return null;

  gl.shaderSource(fs, fSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return null;

  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }

  return prog;
}

function readCommonUniforms(gl: WebGLRenderingContext, prog: WebGLProgram): CommonUniforms {
  return {
    res: gl.getUniformLocation(prog, "u_res"),
    scale: gl.getUniformLocation(prog, "u_scale"),
    uvRect: gl.getUniformLocation(prog, "u_uvRect"),
    dark: gl.getUniformLocation(prog, "u_dark"),
    amb: gl.getUniformLocation(prog, "u_amb"),
    off: gl.getUniformLocation(prog, "u_off"),
    mix: gl.getUniformLocation(prog, "u_mix"),
    art: gl.getUniformLocation(prog, "u_art"),
    mask: gl.getUniformLocation(prog, "u_mask"),
  };
}

function uploadImageTexture(gl: WebGLRenderingContext, img: HTMLImageElement): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function waitForImage(img: HTMLImageElement): Promise<HTMLImageElement> {
  if (img.complete && img.naturalWidth > 0) {
    return typeof img.decode === "function"
      ? img.decode().then(
          () => img,
          () => img,
        )
      : Promise.resolve(img);
  }
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve(img);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Hero artwork failed to load"));
    };
    const cleanup = () => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
  });
}

function loadImageUrl(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return waitForImage(img);
}

export function initHeroStage(): void {
  const stage = document.querySelector<HTMLElement>("[data-hero-stage]");
  const canvas = stage?.querySelector<HTMLCanvasElement>("[data-hero-canvas]");
  const img = stage?.querySelector<HTMLImageElement>(".hero-art img");
  if (!stage || !canvas || !img) return;

  const clearAnimState = () => {
    delete stage.dataset.heroAnim;
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isStill = new URLSearchParams(window.location.search).has("still");
  if (reducedMotion.matches || isStill) {
    clearAnimState();
    return;
  }

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) {
    clearAnimState();
    return;
  }

  const introProg = compileProgram(gl, VERTEX_SRC, INTRO_FRAG_SRC);
  const ambientProg = compileProgram(gl, VERTEX_SRC, AMBIENT_FRAG_SRC);
  if (!introProg || !ambientProg) {
    clearAnimState();
    return;
  }

  const quad = gl.createBuffer();
  if (!quad) {
    clearAnimState();
    return;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  for (const prog of [introProg, ambientProg]) {
    const loc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  const uIntro: IntroUniforms = {
    ...readCommonUniforms(gl, introProg),
    t: gl.getUniformLocation(introProg, "u_t"),
  };
  const uAmbient = readCommonUniforms(gl, ambientProg);

  const maskSrc = canvas.dataset.maskSrc ?? "/hero-topography-mask.webp";

  let disposed = false;
  let ready = false;
  let visible = true;
  let dark = document.documentElement.classList.contains("dark");
  let artTex: WebGLTexture | null = null;
  let maskTex: WebGLTexture | null = null;
  let imgAspect = 1536 / 1024;

  let startTime: number | null = null;
  let airSince: number | null = null;
  let progress = 0;
  let rafId = 0;
  let timerId = 0;

  const drift = {
    at: null as number | null,
    phase: [0, 0, 0, 0],
    off: [0, 0, 0, 0],
  };

  function stepDrift(now: number): [number, number] {
    const dt = drift.at === null ? 0 : clamp(now - drift.at, 0, 0.5);
    drift.at = now;
    const wCloud = WIND_SPEED;
    const wMist = WIND_SPEED * 0.62;
    const speeds = [wCloud, wCloud, wMist, wMist] as const;
    for (let i = 0; i < 4; i++) {
      const phase = (now / PERIODS[i]! + SHIFTS[i]!) % 1;
      if (phase < drift.phase[i]!) {
        drift.off[i] = speeds[i]! * phase * PERIODS[i]!;
      } else {
        drift.off[i]! += speeds[i]! * dt;
      }
      drift.phase[i] = phase;
    }
    return [Math.abs(2 * drift.phase[0]! - 1), Math.abs(2 * drift.phase[2]! - 1)];
  }

  function computeUvRect(): [number, number, number, number] {
    const cw = Math.max(1, canvas!.width);
    const ch = Math.max(1, canvas!.height);
    const rw = Math.max(cw, ch * imgAspect);
    const rh = rw / imgAspect;
    const visW = cw / rw;
    const visH = ch / rh;
    // Match Hero.astro responsive object-position (center bottom -> 72% bottom on <= 760px)
    const posX = window.innerWidth <= MOBILE_BREAKPOINT ? 0.72 : 0.5;
    const offsetX = posX * (1 - visW);
    return [offsetX, 0, visW, visH];
  }

  function airRate(): number {
    const cssSpeed = WIND_SPEED * (canvas!.clientHeight / WORLD_H);
    if (cssSpeed < 0.01) return AIR_RATES[0];
    for (const fps of AIR_RATES) {
      if (cssSpeed / fps <= AIR_STEP) return fps;
    }
    return AIR_RATES[AIR_RATES.length - 1] ?? 30;
  }

  function bindCommon(u: CommonUniforms, strength: number, mixVals: [number, number]) {
    const uvRect = computeUvRect();
    gl!.viewport(0, 0, canvas!.width, canvas!.height);
    gl!.uniform2f(u.res, canvas!.width, canvas!.height);
    gl!.uniform1f(u.scale, canvas!.height / WORLD_H);
    gl!.uniform4f(u.uvRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    gl!.uniform1f(u.dark, dark ? 1 : 0);
    gl!.uniform4f(u.amb, strength, 0.9, 1.0, 0.85);
    gl!.uniform4f(u.off, drift.off[0]!, drift.off[1]!, drift.off[2]!, drift.off[3]!);
    gl!.uniform2f(u.mix, mixVals[0], mixVals[1]);

    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, artTex);
    gl!.uniform1i(u.art, 0);

    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, maskTex);
    gl!.uniform1i(u.mask, 1);
  }

  function renderFrame(now: number) {
    if (!ready || !artTex || !maskTex) return;
    const mixVals = stepDrift(now);
    const airStrength =
      progress >= 1 && airSince !== null ? smoothstep(0, AMBIENT_FADE_IN, now - airSince) : 0;

    if (progress >= 1) {
      gl!.useProgram(ambientProg);
      bindCommon(uAmbient, airStrength, mixVals);
    } else {
      gl!.useProgram(introProg);
      bindCommon(uIntro, 0, mixVals);
      gl!.uniform1f(uIntro.t, progress);
    }
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = 0;
    }
  }

  function wake() {
    if (disposed || !ready || !visible || document.hidden) return;
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = 0;
    }
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function tick(ms: number) {
    rafId = 0;
    if (disposed || !ready || !visible || document.hidden) return;
    const now = ms / 1000;

    if (progress < 1) {
      if (startTime === null) startTime = now;
      progress = clamp((now - startTime) / INTRO_DURATION, 0, 1);
      if (progress >= 1) airSince = now;
    } else if (airSince === null) {
      airSince = now;
    }

    renderFrame(now);

    if (progress < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      const interval = 1000 / airRate();
      timerId = window.setTimeout(
        () => {
          timerId = 0;
          if (!disposed && !rafId && visible && !document.hidden) {
            rafId = requestAnimationFrame(tick);
          }
        },
        Math.max(0, interval - 8),
      );
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(stage!.clientWidth * dpr));
    const h = Math.max(2, Math.round(stage!.clientHeight * dpr));
    if (canvas!.width !== w || canvas!.height !== h) {
      canvas!.width = w;
      canvas!.height = h;
      wake();
    }
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible) wake();
      else stopLoop();
    },
    { threshold: 0 },
  );
  intersectionObserver.observe(stage);

  const themeObserver = new MutationObserver(() => {
    const nextDark = document.documentElement.classList.contains("dark");
    if (nextDark !== dark) {
      dark = nextDark;
      wake();
    }
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  const onVisibilityChange = () => {
    if (document.hidden) stopLoop();
    else wake();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopLoop();
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.removeEventListener("change", onReducedMotionChange);
    canvas.removeEventListener("webglcontextlost", onContextLost);
  };

  const onReducedMotionChange = () => {
    if (reducedMotion.matches) {
      clearAnimState();
      dispose();
    }
  };
  reducedMotion.addEventListener("change", onReducedMotionChange);

  const onContextLost = (event: Event) => {
    event.preventDefault();
    clearAnimState();
    dispose();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  document.addEventListener("astro:before-swap", dispose, { once: true });

  const loadTimeout = window.setTimeout(() => {
    if (!ready && !disposed) clearAnimState();
  }, LOAD_TIMEOUT_MS);

  Promise.all([waitForImage(img), loadImageUrl(maskSrc)])
    .then(([artImg, maskImg]) => {
      window.clearTimeout(loadTimeout);
      if (disposed) return;
      if (artImg.naturalWidth > 0 && artImg.naturalHeight > 0) {
        imgAspect = artImg.naturalWidth / artImg.naturalHeight;
      }
      artTex = uploadImageTexture(gl, artImg);
      maskTex = uploadImageTexture(gl, maskImg);
      if (!artTex || !maskTex) {
        clearAnimState();
        dispose();
        return;
      }
      resize();
      ready = true;
      renderFrame(performance.now() / 1000);
      stage.dataset.heroAnim = "active";
      wake();
    })
    .catch(() => {
      window.clearTimeout(loadTimeout);
      clearAnimState();
      dispose();
    });
}
