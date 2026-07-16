/**
 * Procedural hearth fire for the boot splash.
 *
 * One Skia runtime shader draws the whole effect: a turbulent flame body,
 * pooled light at the base, and a deliberately sparse set of sparks. Keeping
 * this in one canvas avoids the per-particle SVG/Reanimated node cost of the
 * original splash while letting the flame read as one connected source.
 */
import { useMemo } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { Canvas, Fill, Shader, Skia, useClock } from '@shopify/react-native-skia'
import { useDerivedValue } from 'react-native-reanimated'

const FIRE_SHADER = Skia.RuntimeEffect.Make(`
uniform float2 resolution;
uniform float time;
uniform float seed;
uniform float sparkIntensity;

float hash11(float value) {
  return fract(sin(value * 127.1 + seed * 17.7) * 43758.5453123);
}

float hash21(float2 value) {
  return fract(sin(dot(value, float2(127.1, 311.7)) + seed * 13.1) * 43758.5453123);
}

float noise(float2 point) {
  float2 cell = floor(point);
  float2 local = fract(point);
  float2 eased = local * local * (3.0 - 2.0 * local);

  float a = hash21(cell);
  float b = hash21(cell + float2(1.0, 0.0));
  float c = hash21(cell + float2(0.0, 1.0));
  float d = hash21(cell + float2(1.0, 1.0));

  return mix(mix(a, b, eased.x), mix(c, d, eased.x), eased.y);
}

float fbm(float2 point) {
  float value = 0.0;
  float amplitude = 0.52;
  value += amplitude * noise(point);
  point = point * 2.03 + float2(7.1, 3.7);
  amplitude *= 0.5;
  value += amplitude * noise(point);
  point = point * 2.01 + float2(5.4, 8.3);
  amplitude *= 0.5;
  value += amplitude * noise(point);
  point = point * 2.04 + float2(9.2, 4.6);
  amplitude *= 0.5;
  value += amplitude * noise(point);
  return value;
}

half4 main(float2 position) {
  float2 uv = position / resolution;
  float rise = 1.0 - uv.y;
  float t = time;

  // Two differently-paced flow fields keep the silhouette from looking like a
  // scrolling noise texture. The slower field bends the whole flame; the faster
  // field breaks its crown into separate, short-lived tongues.
  float broad = fbm(float2(uv.x * 2.7 + seed, rise * 4.2 - t * 0.34));
  float bend = (broad - 0.5) * 1.35;
  float detail = fbm(float2(uv.x * 6.2 + bend + seed * 1.9, rise * 7.6 - t * 1.08));
  float lick = fbm(float2(uv.x * 11.0 - bend * 0.7, rise * 12.5 - t * 1.72));

  float tongue = pow(clamp(detail * 0.82 + lick * 0.28, 0.0, 1.0), 2.15);
  float crown = 0.105 + tongue * 0.285;
  float edge = smoothstep(0.0, 0.075, uv.x) * (1.0 - smoothstep(0.925, 1.0, uv.x));
  float body = smoothstep(crown + 0.026, crown - 0.022, rise) * edge;

  // Cut channels into the upper flame while keeping the coal-line dense. This
  // is what creates overlapping tongues instead of one solid orange curtain.
  float channels = fbm(float2(uv.x * 13.5 + seed * 2.3, rise * 10.0 - t * 1.31));
  float breakup = mix(1.0, smoothstep(0.31, 0.68, channels + tongue * 0.18), smoothstep(0.055, 0.245, rise));
  body *= breakup;

  float depth = clamp(rise / max(crown, 0.001), 0.0, 1.0);
  float heat = clamp(1.08 - depth + lick * 0.22, 0.0, 1.0);

  float3 deep = float3(0.46, 0.075, 0.025);
  float3 ember = float3(0.92, 0.24, 0.075);
  float3 gold = float3(1.0, 0.59, 0.16);
  float3 cream = float3(1.0, 0.91, 0.61);
  float3 flameColor = mix(deep, ember, smoothstep(0.05, 0.48, heat));
  flameColor = mix(flameColor, gold, smoothstep(0.43, 0.79, heat));
  flameColor = mix(flameColor, cream, smoothstep(0.82, 1.0, heat));

  // A low pooled radiance visually anchors the flames below the phone edge.
  float glowNoise = 0.82 + broad * 0.18;
  float glow = exp(-rise * 6.4) * edge * glowNoise;
  float glowAlpha = glow * 0.23;
  float bodyAlpha = body * (0.74 + heat * 0.24);
  float alpha = max(glowAlpha, bodyAlpha);
  float3 color = mix(float3(0.72, 0.12, 0.035), flameColor, clamp(bodyAlpha * 1.45, 0.0, 1.0));

  // Sparks are consequences of the fire, not the main event. Only some cycles
  // emit, so the screen spends time with two or three visible rather than a
  // constant particle curtain.
  float sparkLight = 0.0;
  float sparkWarm = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float speed = 0.105 + hash11(fi * 9.3) * 0.105;
    float phaseTime = t * speed + hash11(fi * 5.7) * 8.0;
    float cycle = floor(phaseTime);
    float life = fract(phaseTime);
    float emitChance = mix(0.025, 0.78, sparkIntensity);
    float emits = step(1.0 - emitChance, hash11(fi * 17.3 + cycle * 3.1));

    float startX = (0.075 + hash11(fi * 13.7 + cycle) * 0.85) * resolution.x;
    float side = hash11(fi * 7.1 + cycle * 2.0) < 0.5 ? -1.0 : 1.0;
    float launchDrift = side * (0.075 + hash11(fi * 2.7 + cycle * 5.3) * 0.18);
    float crosswind = (hash11(fi * 19.1 + cycle * 4.7) - 0.5) * 0.24;
    float flutterRate = 5.0 + hash11(fi * 3.3 + cycle) * 7.0;
    float flutterSize = 0.007 + hash11(fi * 15.9 + cycle * 1.7) * 0.019;
    float flutterPhase = hash11(fi * 23.7 + cycle * 2.9) * 6.28318;
    float flutter = sin(life * flutterRate + flutterPhase) * flutterSize * life;
    float drift = resolution.x * (launchDrift * life + crosswind * life * life + flutter);
    float travel = (0.34 + hash11(fi * 11.9 + cycle) * 0.48) * resolution.y;
    float riseProgress = life * (1.0 + life * 0.22);
    float2 sparkPosition = float2(startX + drift, resolution.y - resolution.y * 0.045 - riseProgress * travel);

    float radius = 1.05 + hash11(fi * 4.1) * 1.35;
    float stretch = 2.8 + life * 5.4;
    float2 delta = position - sparkPosition;
    float flutterVelocity = cos(life * flutterRate + flutterPhase) * flutterSize * flutterRate;
    float velocityX = resolution.x * (launchDrift + 2.0 * crosswind * life + flutterVelocity);
    float velocityY = -travel * (1.0 + life * 0.44);
    float2 direction = normalize(float2(velocityX, velocityY));
    float along = dot(delta, direction);
    float across = dot(delta, float2(-direction.y, direction.x));
    float spark = exp(-((across * across) / (radius * radius) + (along * along) / (stretch * stretch)) * 1.7);
    float fade = smoothstep(0.0, 0.075, life) * (1.0 - smoothstep(0.56, 1.0, life));
    spark *= fade * emits;
    sparkWarm += spark * 0.72;
    sparkLight += spark;
  }

  float sparkAlpha = clamp(sparkLight, 0.0, 1.0);
  float3 sparkColor = mix(float3(1.0, 0.43, 0.10), float3(1.0, 0.94, 0.72), clamp(sparkLight - sparkWarm + 0.46, 0.0, 1.0));
  color = mix(color, sparkColor, sparkAlpha);
  alpha = max(alpha, sparkAlpha);

  return half4(color * alpha, alpha);
}
`)

type HearthFireProps = {
  /** 0 disables sparks; 1 produces a busy shower. Flame density is unchanged. */
  sparkIntensity?: number
}

export function HearthFire({ sparkIntensity = 0.28 }: HearthFireProps) {
  const { width, height } = useWindowDimensions()
  // The canvas is intentionally limited to the lower half of the display. That
  // cuts fragment work substantially while leaving enough air for sparks to rise.
  const canvasHeight = Math.min(Math.max(height * 0.48, 320), 540)
  const clock = useClock()
  const seed = useMemo(() => Math.random() * 41 + 3, [])
  const normalizedSparkIntensity = Math.min(Math.max(sparkIntensity, 0), 1)
  const uniforms = useDerivedValue(() => ({
    resolution: [width, canvasHeight],
    time: clock.value / 1000,
    seed,
    sparkIntensity: normalizedSparkIntensity,
  }))

  if (!FIRE_SHADER) return null

  return (
    <View pointerEvents="none" style={[styles.wrap, { height: canvasHeight }]}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill>
          <Shader source={FIRE_SHADER} uniforms={uniforms} />
        </Fill>
      </Canvas>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -40,
  },
})
