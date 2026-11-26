// The still lifes a new site starts with, worked out from nothing: shapes given as distances,
// lit by one window, and followed a ray at a time. No photo is used anywhere, so there's nobody
// else's licence to keep to. See draw.mjs.

uniform vec2 uRes;
uniform int uFrame;
uniform sampler2D uPrev;
out vec4 outColor;

#define PI 3.14159265

// Random numbers

uint seed;
uint pcg() {
  seed = seed * 747796405u + 2891336453u;
  uint w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd() { return float(pcg()) / 4294967295.0; }
float hash1(vec3 p) {
  p = fract(p * vec3(.1031, .1030, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 hash3(vec3 p) {
  p = fract(p * vec3(.1031, .1030, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(
    mix(mix(hash1(i), hash1(i + vec3(1, 0, 0)), f.x),
        mix(hash1(i + vec3(0, 1, 0)), hash1(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash1(i + vec3(0, 0, 1)), hash1(i + vec3(1, 0, 1)), f.x),
        mix(hash1(i + vec3(0, 1, 1)), hash1(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int n) {
  float a = .5, s = 0.;
  for (int i = 0; i < n; i++) { s += a * noise(p); p = p * 2.03 + vec3(17.1, 3.7, 9.2); a *= .5; }
  return s;
}

// Shapes

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float smin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float ellipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r), k1 = length(p / (r * r));
  return k0 * (k0 - 1.) / max(k1, 1e-4);
}
float cylinder(vec3 p, float h, float r, float e) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h) + e;
  return min(max(d.x, d.y), 0.) + length(max(d, 0.)) - e;
}
// A bun with an egg wash.
float bun(vec3 p, float id) {
  float d = ellipsoid(p - vec3(0, .05, 0), vec3(.5, .36, .5));
  if (d > .2) return d - .04;
  d -= .03 * (fbm(p * 2.6 + id * 3., 2) - .5) + .004 * noise(p * 26. + id);
  d = smax(d, -p.y - .16, .08);
  return d * .85;
}
float cup(vec3 p) {
  float r = .36 + .1 * smoothstep(-.35, .35, p.y);
  float outer = max(length(p.xz) - r, abs(p.y) - .36);
  float inner = max(length(p.xz) - r + .035, -p.y - .31);
  float d = smax(outer, -inner, .03);
  vec3 q = p - vec3(.52, 0., 0.);
  float handle = length(vec2(length(q.xy * vec2(1., .9)) - .19, q.z)) - .042;
  return min(d, max(handle, -(length(p.xz) - r + .02)));
}
float saucer(vec3 p, float flatTo, float edge) {
  float s = length(p.xz);
  return max(abs(p.y - .075 * smoothstep(flatTo, edge, s)) - .02, s - edge) * .8;
}
// 0: a tall bottle. 1: a round pot. 2: a bowl.
float vase(vec3 p, float kind) {
  float y = p.y, r, top;
  if (kind < .5) {
    top = 1.62;
    r = .15 + .36 * exp(-pow((y - .46) / .40, 2.)) + .05 * smoothstep(1.45, 1.62, y) - .05 * smoothstep(.25, .0, y);
  } else if (kind < 1.5) {
    top = 1.0;
    r = .10 + .48 * sqrt(max(0., 1. - pow((y - .44) / .52, 2.))) * .95;
    r = max(r, .20 + .05 * smoothstep(.85, 1., y));
  } else {
    top = .46;
    r = .26 + .46 * smoothstep(-.05, .5, y);
  }
  float d = length(p.xz) - r;
  float outer = smax(d * .72, max(y - top, -y), .03);
  float inner = smax((d + .05) * .72, -(y - top + (kind < 1.5 ? .3 : .38)), .02);
  return smax(outer, -inner, .02);
}
// A stem with round leaves either side.
float stem(vec3 p, vec2 lean, float len, float id, out float leaf) {
  leaf = 0.;
  float y = clamp(p.y / len, 0., 1.);
  float best = length(vec2(length(p.xz - lean * y * y), max(0., max(-p.y, p.y - len)))) - .011;
  float n = floor(len * 6.5);
  float k = floor(y * n + .5);
  for (int i = -1; i <= 1; i++) {
    float f = clamp(k + float(i), 2., n);
    float fy = f / n;
    vec3 r = hash3(vec3(f, id, 3.));
    vec3 c = vec3(lean.x * fy * fy, fy * len, lean.y * fy * fy);
    float a = f * 2.4 + id * 3. + r.x;
    float size = mix(.17, .07, fy) * (.85 + .3 * r.y);
    vec3 q = p - c - normalize(vec3(cos(a), .45, sin(a))) * size * .95;
    q.xz = rot(-a) * q.xz;
    q.xy = rot(-.5 - .4 * (r.z - .5)) * q.xy;
    float l = ellipsoid(q, vec3(size, .012, size * .72));
    if (l < best) { best = l; leaf = 1.; }
  }
  return best * .8;
}

// What's where. Materials: 1 table, 2 wall, 3 bun, 4 cup and plates, 5 coffee, 6 vases, 7 fruit,
// 8 leaves. q is the place within the thing, and a and b say which one it is.

struct Hit { float d; int m; vec3 q; float a; float b; };
void put(inout Hit h, float d, int m, vec3 q, float a, float b) {
  if (d < h.d) { h.d = d; h.m = m; h.q = q; h.a = a; h.b = b; }
}

Hit map(vec3 p) {
  Hit h;
  h.d = 1e5; h.m = 0; h.q = p; h.a = 0.; h.b = 0.;
  put(h, p.y, 1, p, 0., 0.);
#if SCENE == 1
  put(h, p.z + 5., 2, p, 0., 0.);
  { vec3 q = p - vec3(-.7, .46, .1); q.xz = rot(-.6) * q.xz; put(h, cup(q), 4, q, 0., 0.); put(h, cylinder(q - vec3(0, .2, 0), .02, .4, .01), 5, q, 0., 0.); }
  put(h, saucer(p - vec3(-.7, .05, .1), .45, .85), 4, p - vec3(-.7, .05, .1), 0., 0.);
  put(h, saucer(p - vec3(1.05, .06, .35), .7, 1.05), 4, p - vec3(1.05, .06, .35), 1., 0.);
  { vec3 q = (p - vec3(.86, .36, .2)) / 1.02; put(h, bun(q, 5.) * 1.02, 3, q, 0., 5.); }
  { vec3 q = (p - vec3(1.38, .33, .62)) / .92; put(h, bun(q, 8.) * .92, 3, q, 0., 8.); }
#else
  put(h, p.z + 3.4, 2, p, 0., 0.);
  { vec3 q = p - vec3(.35, 0., 0.); put(h, vase(q, 0.), 6, q, 0., 0.); }
  { vec3 q = (p - vec3(1.45, 0., -.5)) / 1.12; put(h, vase(q, 1.) * 1.12, 6, q, 1., 0.); }
  { vec3 q = (p - vec3(1.42, 0., .75)) / .82; put(h, vase(q, 2.) * .82, 6, q, 2., 0.); }
  { vec3 q = p - vec3(-.62, .23, .72); float d = ellipsoid(q, vec3(.25, .235, .25)); d = smax(d, -ellipsoid(q - vec3(0., .27, 0.), vec3(.07, .06, .07)), .05); put(h, d * .9, 7, q, 0., 1.); }
  { vec3 q = p - vec3(-.2, .20, 1.08); float d = ellipsoid(q, vec3(.215, .20, .215)); d = smax(d, -ellipsoid(q - vec3(.02, .235, 0.), vec3(.06, .055, .06)), .05); put(h, d * .9, 7, q, 0., 5.); }
  for (int i = 0; i < 5; i++) {
    float f = float(i);
    vec3 q = p - vec3(.35 + .03 * sin(f * 2.), 1.35, .02 * cos(f * 3.));
    float leaf;
    float d = stem(q, vec2(-.95 + .46 * f, .28 * sin(f * 2.1 + .6)), 1.5 - .16 * abs(f - 1.6), f, leaf);
    put(h, d, 8, q, leaf, f);
  }
#endif
  return h;
}

vec3 normalAt(vec3 p, float e) {
  vec2 k = vec2(1, -1);
  return normalize(k.xyy * map(p + k.xyy * e).d + k.yyx * map(p + k.yyx * e).d +
                   k.yxy * map(p + k.yxy * e).d + k.xxx * map(p + k.xxx * e).d);
}
bool trace(vec3 ro, vec3 rd, float far, out float t, out Hit h) {
  t = .004;
  for (int i = 0; i < 190; i++) {
    h = map(ro + rd * t);
    if (h.d < .0007 * (1. + t * .25)) return true;
    t += h.d * .9;
    if (t > far) return false;
  }
  return false;
}
bool blocked(vec3 ro, vec3 rd, float far) {
  float t = .01;
  for (int i = 0; i < 90; i++) {
    float d = map(ro + rd * t).d;
    if (d < .0012) return true;
    t += d * .95;
    if (t > far) return false;
  }
  return false;
}

// What each thing is made of: its colour, how rough it is, and how strongly it shines.
void material(Hit h, vec3 p, out vec3 c, out float rough, out float shine) {
  vec3 q = h.q;
  rough = .8; shine = .03; c = vec3(.5);
  if (h.m == 1) {
    float id = floor(q.z / 1.15);
    float grain = fbm(vec3(q.x * .55 + id * 13., q.z * 7.5, id * 3. + q.y), 4);
    float lines = fbm(vec3(q.x * 1.2 + id * 5., q.z * 46., id), 3);
    c = mix(WOOD_A, WOOD_B, smoothstep(.25, .75, grain * .75 + lines * .3)) * (.85 + .3 * hash1(vec3(id, 2., 5.)));
    c *= mix(.35, 1., smoothstep(.0, .03, .575 - abs(fract(q.z / 1.15) - .5) * 1.15));
    rough = .42; shine = .04;
  } else if (h.m == 2) {
    c = WALL * (.82 + .3 * fbm(vec3(p.xy * 1.2, 1.), 4));
    rough = .95; shine = 0.;
  } else if (h.m == 3) {
    float n = fbm(q * 3. + h.b, 3);
    float t = smoothstep(-.12, .36, q.y + (n - .5) * .16);
    c = mix(vec3(.86, .62, .31), vec3(.60, .27, .075), smoothstep(.0, .55, t));
    c = mix(c, vec3(.34, .115, .03), smoothstep(.45, 1., t + (n - .5) * .5));
    vec2 g = q.xz * 8.5, cell = floor(g);
    float seeds = 0.;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
      vec2 k = cell + vec2(float(i), float(j));
      vec3 r = hash3(vec3(k, h.b));
      if (r.z < .62) continue;
      vec2 u = rot(r.x * 6.) * (g - k - .25 - .5 * r.xy);
      seeds = max(seeds, smoothstep(.34, .26, length(u * vec2(1., 1.9))));
    }
    seeds *= smoothstep(.17, .26, q.y);
    c = mix(c, vec3(.80, .70, .50), seeds);
    rough = mix(.22, .6, seeds); shine = mix(.07, .03, seeds);
  } else if (h.m == 4) {
    c = (h.a > .5 ? vec3(.20, .30, .25) : vec3(.80, .77, .71)) * (.93 + .12 * fbm(p * 7., 3));
    c = mix(c, vec3(.28, .2, .13), smoothstep(.74, .78, noise(p * 34.)) * .5 * (1. - h.a));
    rough = .24; shine = .06;
  } else if (h.m == 5) {
    float r = length(q.xz);
    float swirl = fbm(vec3(q.xz * 5. + .6 * vec2(sin(r * 14.), cos(r * 12.)), 1.), 3);
    c = mix(vec3(.10, .045, .02), vec3(.62, .42, .24), smoothstep(.36, .56, swirl + .12 * smoothstep(.2, .4, r)));
    rough = .2; shine = .05;
  } else if (h.m == 6) {
    c = h.a < .5 ? vec3(.76, .72, .65) : h.a < 1.5 ? vec3(.43, .22, .135) : vec3(.235, .30, .255);
    c *= .9 + .18 * fbm(q * vec3(4., 14., 4.), 3);
    c = mix(c, c * .55, smoothstep(.70, .76, noise(q * 30.)) * (h.a < .5 ? .55 : .25));
    if (h.a > .5 && h.a < 1.5) c = mix(c, vec3(.72, .67, .59), smoothstep(.60, .64, q.y + .05 * noise(q * 5.)) * .9);
    rough = h.a < .5 ? .6 : .42; shine = .04;
  } else if (h.m == 7) {
    float a = atan(q.x, q.z);
    c = mix(vec3(.62, .24, .06), vec3(.70, .42, .10), smoothstep(.3, .7, fbm(vec3(a * 2., q.y * 5., h.b), 3)));
    c = mix(c, vec3(.48, .10, .04), smoothstep(.45, .75, fbm(vec3(a * 3., q.y * 2., h.b + 4.), 3)) * .8);
    c *= .9 + .2 * noise(q * 60.);
    rough = .35; shine = .045;
  } else if (h.m == 8) {
    c = h.a > .5 ? mix(vec3(.16, .23, .165), vec3(.27, .33, .25), fbm(q * 5. + h.b, 2)) : vec3(.22, .17, .10);
    rough = .7;
  }
}

// The window, off to one side: a rectangle of soft light.
const vec3 WINDOW = vec3(-6.5, 4.6, 2.2);
const vec3 ACROSS = vec3(.6, 0., 2.2);
const vec3 UP = vec3(.5, 2., 0.);

vec3 anyWay(vec3 n) {
  float a = rnd() * 2. * PI, z = rnd() * 2. - 1., r = sqrt(max(0., 1. - z * z));
  return normalize(n + vec3(r * cos(a), r * sin(a), z) * .999);
}

vec3 light(vec3 ro, vec3 rd) {
  vec3 sum = vec3(0.), through = vec3(1.);
  for (int bounce = 0; bounce < 4; bounce++) {
    float t;
    Hit h;
    if (!trace(ro, rd, 30., t, h)) { sum += through * ROOM * (.65 + .35 * rd.y); break; }
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p, .0012 + .0006 * t);
    vec3 c;
    float rough, shine;
    material(h, p, c, rough, shine);
    float edge = shine + (1. - shine) * pow(1. - max(dot(n, -rd), 0.), 5.) * (1. - rough);
    vec3 from = p + n * .004;
    // Straight at the window.
    vec3 to = WINDOW + ACROSS * (rnd() * 2. - 1.) + UP * (rnd() * 2. - 1.) - from;
    float far2 = dot(to, to), far = sqrt(far2);
    to /= far;
    float facing = max(dot(n, to), 0.);
    if (facing > 0. && !blocked(from, to, far - .05)) {
      vec3 half_ = normalize(to - rd);
      float a2 = pow(rough, 4.) + .0005, nh = max(dot(n, half_), 0.);
      float D = a2 / (PI * pow(nh * nh * (a2 - 1.) + 1., 2.));
      float F = shine + (1. - shine) * pow(1. - max(dot(half_, to), 0.), 5.) * (1. - rough);
      vec3 sent = c / PI * (1. - F) + vec3(D * F * .25 / max(.15, max(dot(n, -rd), 0.)));
      vec3 face = cross(ACROSS, UP);
      sum += through * sent * LIGHT * facing * abs(dot(normalize(face), to)) * 4. * length(face) / far2;
    }
    if (rnd() < edge) {
      rd = normalize(reflect(rd, n) + rough * rough * 1.2 * anyWay(n) * .6);
      if (dot(rd, n) <= 0.) break;
      through *= .9;
    } else {
      rd = anyWay(n);
      through *= c;
    }
    ro = from;
    if (bounce > 1) {
      float left = max(through.x, max(through.y, through.z));
      if (rnd() > left) break;
      through /= max(left, .05);
    }
  }
  return min(sum, vec3(8.));
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  seed = uint(px.x) * 1973u + uint(px.y) * 9277u + uint(uFrame) * 26699u + 1u;
  pcg();
  pcg();
  vec2 uv = (gl_FragCoord.xy - .5 + vec2(rnd(), rnd()) - .5 * uRes) / uRes.y;
  vec3 ro = FROM;
  vec3 ahead = normalize(TO - ro), side = normalize(cross(ahead, vec3(0, 1, 0))), above = cross(side, ahead);
  vec3 rd = normalize(uv.x * side + uv.y * above + LENS * ahead);
  vec3 sharp = ro + rd * (FOCUS / dot(rd, ahead));
  float a = rnd() * 2. * PI, r = sqrt(rnd()) * OPENING;
  ro += side * cos(a) * r + above * sin(a) * r;
  outColor = texelFetch(uPrev, px, 0) + vec4(light(ro, normalize(sharp - ro)), 1.);
}
