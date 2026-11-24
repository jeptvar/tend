// A small npm registry for the release's last check before publishing (PLAN.md §14). It has the
// packages about to be published, as if they came out an hour ago, and gets everything else
// from npm. Zero dependencies.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

function textAt(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString("utf8", start, end === -1 ? start + length : Math.min(end, start + length));
}

/** The files in a package's tarball, by their path inside it. */
export function readTarball(tarball) {
  const tar = gunzipSync(tarball);
  const files = new Map();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header[0] === 0) break;
    const size = Number.parseInt(textAt(header, 124, 12).trim() || "0", 8);
    const kind = String.fromCharCode(header[156] || 48);
    const prefix = textAt(header, 345, 155);
    const name = textAt(header, 0, 100);
    if (kind === "0") {
      files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** What a registry says about a package with only this one version. */
function aboutPackage(tarballPath, publishedAt, base) {
  const tarball = readFileSync(tarballPath);
  const files = readTarball(tarball);
  const manifest = JSON.parse(files.get("package/package.json").toString("utf8"));
  const { name, version } = manifest;
  const file = basename(tarballPath);
  const time = new Date(publishedAt).toISOString();
  return {
    name,
    file,
    tarball,
    about: {
      name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          ...manifest,
          _id: `${name}@${version}`,
          // npm adds this as a package is published, and without it ignores the shrinkwrap.
          _hasShrinkwrap: files.has("package/npm-shrinkwrap.json"),
          dist: {
            tarball: `${base}/${name}/-/${file}`,
            shasum: createHash("sha1").update(tarball).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
          },
        },
      },
      time: { created: time, modified: time, [version]: time },
    },
  };
}

/**
 * Starts one with these tarballs in it, all published at that moment. `upstream` is where it
 * gets everything else.
 */
export function startRegistry({ tarballs, publishedAt, upstream = "https://registry.npmjs.org" }) {
  return new Promise((resolve, reject) => {
    let packages = [];
    const server = createServer(async (request, response) => {
      try {
        const path = decodeURIComponent(new URL(request.url, "http://registry").pathname);
        const own = packages.find(
          ({ name, file }) => path === `/${name}` || path === `/${name}/-/${file}`,
        );
        if (own && path.endsWith(".tgz")) {
          response.writeHead(200, { "Content-Type": "application/octet-stream" });
          response.end(own.tarball);
          return;
        }
        if (own) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(own.about));
          return;
        }
        if (request.method !== "GET") {
          response.writeHead(404).end();
          return;
        }
        const reply = await fetch(`${upstream}${request.url}`, {
          headers: request.headers.accept ? { Accept: request.headers.accept } : {},
        });
        response.writeHead(reply.status, {
          "Content-Type": reply.headers.get("content-type") ?? "application/octet-stream",
        });
        response.end(Buffer.from(await reply.arrayBuffer()));
      } catch (error) {
        response.writeHead(502, { "Content-Type": "text/plain" });
        response.end(String(error));
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      packages = tarballs.map((tarball) => aboutPackage(tarball, publishedAt, url));
      resolve({
        url,
        close: () =>
          new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          }),
      });
    });
  });
}
