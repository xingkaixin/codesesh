// Adapted from Solaris's surface models (MIT); see /celestial-credits.txt.
export const bodySurfaceShader = `
uniform sampler2D uBodyTexture;

vec3 litBody(vec2 uv, vec3 normal, vec3 viewDirection, vec3 lightDirection, float roughness) {
  vec3 albedo = pow(texture2D(uBodyTexture, uv).rgb, vec3(2.2));
  vec3 radiance = albedo * 0.12 + pbrDirectLight(albedo, normal, viewDirection, lightDirection, roughness, vec3(0.025));
  return pow(clamp(radiance, 0.0, 1.0), vec3(1.0 / 2.2));
}

vec3 solarObservation(vec3 normal, float time) {
  float angle = time * 0.025;
  mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  vec2 disk = rotation * normal.xy;
  vec2 uv = vec2(514.75, 513.35) / 1024.0 + vec2(disk.x, -disk.y) * (403.75 / 1024.0);
  return texture2D(uBodyTexture, uv).rgb;
}

vec4 saturnRing(vec3 position, vec3 normal, vec3 viewDirection, vec3 lightDirection) {
  float radius = clamp((length(position.xz) - 1.35) / (2.45 - 1.35), 0.0, 1.0);
  vec4 data = texture2D(uBodyTexture, vec2(radius, 0.5));
  float opticalDepth = data.a * data.a * 4.0;
  float opening = max(abs(dot(normal, viewDirection)), 0.12);
  float opacity = 1.0 - exp(-opticalDepth / opening);
  vec3 tint = pow(max(data.rgb, vec3(0.0)), vec3(1.0 / 2.2));
  return vec4(tint * (0.45 + 0.55 * abs(dot(normal, lightDirection))), opacity);
}

vec3 neptuneAtmosphere(vec3 position, vec3 normal, vec3 viewDirection, vec3 lightDirection, float time) {
  float latitude = position.y;
  float bands = sin(latitude * 18.0 + sin(position.x * 4.0 + time * 0.025) * 0.25) * 0.018;
  float opticalDepth = 0.52 + bands;
  float incident = max(dot(normal, lightDirection), 0.0);
  float viewCosine = max(dot(normal, viewDirection), 0.12);
  vec3 absorption = vec3(1.16, 0.26, 0.06) * 0.78 * 0.72;
  vec3 viewTransmission = exp(-absorption * opticalDepth / viewCosine);
  vec3 sunTransmission = exp(-absorption * opticalDepth / max(incident, 0.12));
  vec3 neutralDeck = vec3(0.36, 0.44, 0.49);
  vec3 scatter = mix(neutralDeck, vec3(0.18, 0.45, 0.58), 0.78 * 0.72 * 0.7);
  float multiple = pow(incident, 0.48);
  float reflected = mix(multiple, min(2.0 * incident / max(incident + viewCosine, 0.0001), 1.28), 0.28);
  vec3 color = neutralDeck * sunTransmission * reflected * viewTransmission;
  color += scatter * multiple * 0.62 * mix(vec3(0.72), viewTransmission, 0.28);
  color *= 1.0 + bands;
  color += scatter * 0.06;
  return pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
}
`;
