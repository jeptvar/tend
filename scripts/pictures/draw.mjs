// Draws the pictures a new site starts with (themes/meadow/starters/pictures), in a browser on
// the graphics card: scene.glsl is followed a few hundred times for every pixel. Only needed to
// change one. It takes about a minute and a half each, so it isn't part of the build.
//
//   node scripts/pictures/draw.mjs [name] [share of full size] [times for every pixel]
//
// It uses Playwright's Chromium and the server's own sharp. On a computer without a graphics
// card it works too, but takes hours.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const root = join(import.meta.dirname, "..", "..");
const sharp = createRequire(join(root, "packages", "tendcms", "package.json"))("sharp");
const out = join(root, "themes", "meadow", "starters", "pictures");
/** Small ones for choosing a starting point in Setup. */
const small = join(root, "packages", "admin", "src", "routes", "setup");
const SMALL = { table: [560, 315], coffee: [560, 300], bowl: [400, 300], leaves: [400, 300] };
const scene = readFileSync(join(import.meta.dirname, "scene.glsl"), "utf8");

const vec = (x, y, z) => `vec3(${[x, y, z].map((value) => value.toFixed(3)).join(", ")})`;
const still = {
  SCENE: 2,
  WOOD_A: vec(0.66, 0.56, 0.44),
  WOOD_B: vec(0.5, 0.4, 0.29),
  WALL: vec(0.7, 0.67, 0.61),
  LIGHT: vec(12.6, 11.8, 10.6),
  ROOM: vec(0.34, 0.33, 0.31),
};

/** Where each is seen from, and how sharply: the rest of it is the scene's. */
const PICTURES = {
  table: {
    ...still,
    size: [2400, 1350],
    FROM: vec(-1, 1.75, 5.6),
    TO: vec(-0.75, 1.18, 0),
    LENS: "1.85",
    FOCUS: "5.75",
    OPENING: ".05",
  },
  bowl: {
    ...still,
    size: [1600, 1200],
    FROM: vec(-0.55, 1.5, 4.5),
    TO: vec(0.95, 0.5, 0.15),
    LENS: "2.05",
    FOCUS: "4.75",
    OPENING: ".055",
  },
  leaves: {
    ...still,
    size: [1600, 1200],
    WALL: vec(0.62, 0.66, 0.6),
    FROM: vec(1.6, 2.1, 4.4),
    TO: vec(0.15, 1.25, 0),
    LENS: "1.75",
    FOCUS: "4.6",
    OPENING: ".06",
  },
  coffee: {
    size: [1600, 1200],
    SCENE: 1,
    WOOD_A: vec(0.62, 0.46, 0.3),
    WOOD_B: vec(0.42, 0.28, 0.16),
    WALL: vec(0.6, 0.62, 0.56),
    LIGHT: vec(14, 13.2, 12),
    ROOM: vec(0.3, 0.27, 0.24),
    FROM: vec(0.4, 2.35, 4.4),
    TO: vec(0.2, 0.28, 0.2),
    LENS: "1.7",
    FOCUS: "4.5",
    OPENING: ".06",
  },
};

const [only, share = "1", times = "360"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage();
  for (const [name, { size, ...constants }] of Object.entries(PICTURES)) {
    if (only && only !== name) continue;
    const [width, height] = size.map((value) => Math.round(value * Number(share)));
    const source = [
      "#version 300 es",
      "precision highp float;",
      "precision highp int;",
      "precision highp sampler2D;",
      ...Object.entries(constants).map(([key, value]) => `#define ${key} ${value}`),
      scene,
    ].join("\n");
    const started = performance.now();
    await page.setContent("<canvas></canvas>");
    const png = await page.evaluate(drawing, { source, width, height, times: Number(times) });
    const path = join(out, `${name}.jpg`);
    await sharp(Buffer.from(png, "base64")).jpeg({ quality: 82, mozjpeg: true }).toFile(path);
    if (SMALL[name]) {
      await sharp(path)
        .resize(...SMALL[name])
        .webp({ quality: 72 })
        .toFile(join(small, `${name}.webp`));
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    console.log(`${path}: ${width} × ${height}, ${seconds} s`);
  }
} finally {
  await browser.close();
}

/** In the page: adds each time to the last in a texture of floats, then gives them as a PNG. */
async function drawing({ source, width, height, times }) {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  gl.getExtension("EXT_color_buffer_float");
  const program = gl.createProgram();
  const everywhere =
    "#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}";
  for (const [type, code] of [
    [gl.VERTEX_SHADER, everywhere],
    [gl.FRAGMENT_SHADER, source],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  const targets = [0, 1].map(() => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const buffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, buffer };
  });
  gl.bindVertexArray(gl.createVertexArray());
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, "uRes"), width, height);
  gl.viewport(0, 0, width, height);
  gl.enable(gl.SCISSOR_TEST);
  // In pieces, because a graphics card gives up on one thing that takes too long.
  const pieces = 6;
  for (let time = 0; time < times; time++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[(time + 1) % 2].buffer);
    gl.bindTexture(gl.TEXTURE_2D, targets[time % 2].texture);
    gl.uniform1i(gl.getUniformLocation(program, "uFrame"), time);
    for (let piece = 0; piece < pieces * pieces; piece++) {
      gl.scissor(
        Math.floor(((piece % pieces) * width) / pieces),
        Math.floor((Math.floor(piece / pieces) * height) / pieces),
        Math.ceil(width / pieces) + 1,
        Math.ceil(height / pieces) + 1,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
    }
    gl.finish();
    if (time % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets[times % 2].buffer);
  const sums = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, sums);
  // The way film gives up gently on what's too bright.
  const film = (x) =>
    Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const pixels = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((height - 1 - y) * width + x) * 4;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[to + channel] =
          255 * film((sums[from + channel] / sums[from + 3]) * 0.95) ** (1 / 2.2);
      }
      pixels.data[to + 3] = 255;
    }
  }
  const picture = new OffscreenCanvas(width, height);
  picture.getContext("2d").putImageData(pixels, 0, 0);
  const bytes = new Uint8Array(
    await (await picture.convertToBlob({ type: "image/png" })).arrayBuffer(),
  );
  let text = "";
  for (let at = 0; at < bytes.length; at += 32768) {
    text += String.fromCharCode(...bytes.subarray(at, at + 32768));
  }
  return btoa(text);
}
