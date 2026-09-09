import { loadTexture } from "./texture";

const maps = [
  { uniform: "uEarthDay", placeholder: [20, 60, 140, 255] },
  { uniform: "uEarthNight", placeholder: [0, 0, 0, 255] },
  { uniform: "uEarthCloud", placeholder: [0, 0, 0, 255] },
  { uniform: "uEarthNormal", placeholder: [128, 128, 255, 255] },
  { uniform: "uEarthMaterial", placeholder: [0, 0, 0, 255] },
  { uniform: "uEarthRoughness", placeholder: [180, 180, 180, 255] },
];

export function loadEarthTextures(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  urls: string[],
  redraw: () => void,
) {
  const textures = maps.map(({ uniform, placeholder }, unit) => ({
    location: gl.getUniformLocation(program, uniform),
    texture: loadTexture(gl, urls[unit] ?? "", unit, placeholder, redraw),
  }));

  return {
    bind() {
      textures.forEach(({ texture, location }, unit) => {
        texture.bind();
        gl.uniform1i(location, unit);
      });
    },
    dispose() {
      textures.forEach(({ texture }) => texture.dispose());
    },
  };
}
