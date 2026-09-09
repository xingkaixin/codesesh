import { loadTexture } from "./texture";

const bodies = [
  { kind: 1, placeholder: [220, 85, 12, 255] },
  { kind: 3, placeholder: [160, 160, 160, 255] },
  { kind: 4, placeholder: [170, 95, 60, 255] },
  { kind: 5, placeholder: [190, 165, 135, 255] },
  { kind: 6, placeholder: [200, 182, 145, 255] },
  { kind: 7, placeholder: [170, 160, 135, 80] },
];

export function loadBodyTextures(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  urls: string[],
  redraw: () => void,
) {
  // The six Earth maps occupy units 0–5; every other body shares unit 6.
  const unit = 6;
  const location = gl.getUniformLocation(program, "uBodyTexture");
  const textures = new Map(
    bodies.map(({ kind, placeholder }, index) => [
      kind,
      loadTexture(gl, urls[index] ?? "", unit, placeholder, redraw, kind !== 1 && kind !== 7),
    ]),
  );

  return {
    bind(kind: number) {
      const texture = textures.get(kind);
      if (!texture) return;
      texture.bind();
      gl.uniform1i(location, unit);
    },
    dispose() {
      textures.forEach((texture) => texture.dispose());
    },
  };
}
