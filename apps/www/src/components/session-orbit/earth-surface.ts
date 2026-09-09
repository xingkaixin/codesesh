// Surface BRDF adapted from Solaris (MIT); see /earth-credits.txt.
export const earthSurfaceShader = `
uniform sampler2D uEarthDay;
uniform sampler2D uEarthNight;
uniform sampler2D uEarthCloud;
uniform sampler2D uEarthNormal;
uniform sampler2D uEarthMaterial;
uniform sampler2D uEarthRoughness;
uniform mat3 uNormalMatrix;

float distributionGgx(vec3 normal, vec3 halfDirection, float roughness) {
  float roughnessSquared = roughness * roughness;
  float alphaSquared = roughnessSquared * roughnessSquared;
  float normalHalf = max(dot(normal, halfDirection), 0.0);
  float denominator = normalHalf * normalHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(3.14159265 * denominator * denominator, 0.0001);
}

float geometrySchlickGgx(float normalDirection, float roughness) {
  float radius = roughness + 1.0;
  float factor = radius * radius / 8.0;
  return normalDirection / max(normalDirection * (1.0 - factor) + factor, 0.0001);
}

float geometrySmith(vec3 normal, vec3 viewDirection, vec3 lightDirection, float roughness) {
  float normalView = max(dot(normal, viewDirection), 0.0);
  float normalLight = max(dot(normal, lightDirection), 0.0);
  return geometrySchlickGgx(normalView, roughness) * geometrySchlickGgx(normalLight, roughness);
}

vec3 fresnelSchlick(float cosineAngle, vec3 reflectance) {
  return reflectance + (1.0 - reflectance) * pow(clamp(1.0 - cosineAngle, 0.0, 1.0), 5.0);
}

vec3 pbrDirectLight(
  vec3 albedo,
  vec3 normal,
  vec3 viewDirection,
  vec3 lightDirection,
  float roughness,
  vec3 reflectance
) {
  vec3 halfDirection = normalize(viewDirection + lightDirection);
  float normalView = max(dot(normal, viewDirection), 0.0);
  float normalLight = max(dot(normal, lightDirection), 0.0);
  float viewHalf = max(dot(viewDirection, halfDirection), 0.0);
  float distribution = distributionGgx(normal, halfDirection, roughness);
  float geometry = geometrySmith(normal, viewDirection, lightDirection, roughness);
  vec3 fresnel = fresnelSchlick(viewHalf, reflectance);
  vec3 specular = distribution * geometry * fresnel /
    max(4.0 * normalView * normalLight, 0.0001);
  vec3 diffuse = (1.0 - fresnel) * albedo / 3.14159265;
  return (diffuse + specular) * vec3(1.0, 0.96, 0.9) * 2.55 * normalLight;
}


vec3 earthSurface(vec2 uv, vec3 objectPosition, vec3 normal, vec3 viewDirection, vec3 lightDirection, float time) {
  vec3 albedo = pow(texture2D(uEarthDay, uv).rgb, vec3(2.2));
  float water = texture2D(uEarthMaterial, uv).r;
  float roughness = mix(max(texture2D(uEarthRoughness, uv).r, 0.38), 0.18, water);
  vec3 mapped = texture2D(uEarthNormal, uv).xyz * 2.0 - 1.0;
  vec3 objectNormal = normalize(objectPosition);
  vec3 tangent = normalize(vec3(objectNormal.z, 0.0, -objectNormal.x) + vec3(0.00001, 0.0, 0.0));
  vec3 bitangent = normalize(cross(objectNormal, tangent));
  vec3 surfaceNormal = normalize(uNormalMatrix * (tangent * mapped.x + bitangent * mapped.y + objectNormal * mapped.z));
  surfaceNormal = normalize(mix(surfaceNormal, normal, water));
  vec2 cloudUv = vec2(uv.x - time * 0.0008, uv.y);
  float clouds = texture2D(uEarthCloud, cloudUv).r;
  float shadow = texture2D(uEarthCloud, cloudUv + vec2(0.002, 0.001)).r;
  float daylight = max(dot(normal, lightDirection), 0.0);
  vec3 direct = pbrDirectLight(albedo, surfaceNormal, viewDirection, lightDirection, roughness, vec3(0.021));
  vec3 surface = albedo * 0.10 + direct * (1.0 - shadow * 0.48);
  float night = 1.0 - smoothstep(-0.12, 0.18, dot(normal, lightDirection));
  surface += pow(texture2D(uEarthNight, uv).rgb, vec3(2.2)) * night * (1.0 - clouds) * 1.5;
  surface = mix(surface, vec3(0.8, 0.86, 0.94) * (0.10 + daylight * 0.9), clouds * 0.92);
  float limb = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.5);
  surface += vec3(0.06, 0.24, 0.55) * limb * (0.15 + daylight * 0.85);
  surface = clamp((surface * (2.51 * surface + 0.03)) / (surface * (2.43 * surface + 0.59) + 0.14), 0.0, 1.0);
  return pow(surface, vec3(1.0 / 2.2));
}
`;
