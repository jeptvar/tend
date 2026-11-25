// Makes an upgrade fixture (PLAN.md §15): a site with awkward things in it, as this version of
// Tend makes and answers about it. The test packages/tendcms/test/upgrades.test.ts brings every
// fixture up to date with the newest migrations and checks that nothing in it was lost.
//
// Run it once for each release, after `pnpm build`, and commit what it writes:
//
//   node scripts/make-fixture.mjs
//
// It writes fixtures/upgrades/<version>.db.gz, and <version>.json.gz with how many rows each
// table has and what the API and the pages said. Nothing in either is a secret: the site is made up,
// and its key stays behind in a temporary folder. Zero dependencies.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateSync, gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const cli = join(root, "packages", "tendcms", "dist", "cli.mjs");
const out = join(root, "fixtures", "upgrades");
if (!existsSync(cli)) {
  console.error(`${cli} doesn't exist. Run pnpm build first.`);
  process.exit(1);
}
const { version } = JSON.parse(
  readFileSync(join(root, "packages", "tendcms", "package.json"), "utf8"),
);

const OWNER = {
  name: "Zoë O'Brien-García",
  email: "zoe@example.com",
  password: "maple-river-candle-stone-orbit",
};

/** A PNG of one colour, so no picture has to be kept in the repository. */
function png(width, height, [red, green, blue]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, Buffer.from([red, green, blue])),
  ]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const folder = mkdtempSync(join(tmpdir(), "tend-fixture-"));
const tend = spawn(process.execPath, [cli, "start"], {
  cwd: folder,
  env: { ...process.env, PORT: "0", TEND_ADMIN_DEV_URL: "", TEND_DATA_DIR: join(folder, "data") },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [tend.stdout, tend.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk;
  });
}

async function stopped() {
  if (tend.exitCode !== null || tend.signalCode !== null) return;
  const exited = new Promise((resolve) => tend.once("exit", resolve));
  tend.kill("SIGTERM");
  await exited;
}

/** One person's browser. */
function person(base) {
  let cookie = "";
  const send = async (method, path, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const reply = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(method === "GET"
          ? {}
          : { "Content-Type": raw ? "application/octet-stream" : "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(method === "GET" ? {} : { body: raw ? body : JSON.stringify(body ?? {}) }),
    });
    const set = reply.headers.getSetCookie().map((line) => line.split(";")[0]);
    if (set.length > 0) cookie = set.join("; ");
    const text = await reply.text();
    return { status: reply.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  return {
    send,
    /** The same, for what has to work. */
    async ask(method, path, body, headers) {
      const reply = await send(method, path, body, headers);
      if (reply.status >= 400) {
        throw new Error(`${method} ${path}: ${reply.status} ${JSON.stringify(reply.body)}`);
      }
      return reply.body;
    },
  };
}

const text = (value, ...marks) => ({
  type: "text",
  text: value,
  ...(marks.length > 0 ? { marks } : {}),
});
const p = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", content });
const heading = (level, value) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const link = (href) => ({ type: "link", attrs: { href } });

try {
  for (let waited = 0; waited < 400 && !/#code=/.test(output); waited++) {
    if (tend.exitCode !== null) throw new Error("Tend didn't start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const base = output.match(/is running: (http:\/\/[^/\s]+)/)[1];
  const owner = person(base);
  const { ask, send } = owner;
  const admin = (method, path, body, headers) => ask(method, `/api/admin${path}`, body, headers);
  const version_ = (rev) => ({ "If-Match": String(rev) });

  await ask("POST", "/api/auth/setup", {
    code: output.match(/#code=(\S+)/)[1],
    site: {
      name: "Rise & Shine “Bakery” 🥐",
      tagline: "Pão & bröd: 50% off <b>today</b>",
      locale: "pt-BR",
      timezone: "America/Sao_Paulo",
    },
    owner: OWNER,
    starter: "business",
  });

  // Pictures: one that's used, one described, one replaced, one in the Trash, and a PDF.
  const upload = (data, name) =>
    admin("POST", "/media", data, { "X-File-Name": encodeURIComponent(name) });
  const loaf = await upload(png(900, 600, [170, 120, 60]), "pão de queijo (1).png");
  const oven = await upload(png(700, 500, [90, 40, 20]), "oven.png");
  await admin("PATCH", `/media/${loaf.id}`, {
    alt: 'A loaf, "still warm"',
    caption: "Ontem, às 7h",
    credit: "© Zoë",
  });
  await admin("PATCH", `/media/${oven.id}`, { decorative: true });
  // A copy of the site that shows the first one, so its original is kept for it.
  await admin("POST", "/backups");
  await admin("POST", `/media/${oven.id}/replace`, png(640, 480, [20, 20, 90]), {
    "X-File-Name": "oven-2.png",
  });
  const binned = await upload(png(300, 300, [1, 2, 3]), "binned.png");
  await admin("POST", `/media/${binned.id}/trash`);
  const menuPdf = await upload(
    Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    "cardápio.pdf",
  );

  const tags = [];
  for (const name of ["Хлеб", "C++", "Receitas & dicas", "パン"]) {
    tags.push(await admin("POST", "/tags", { name }));
  }

  const write = async (type, fields) => {
    const made = await admin("POST", "/entries", { type });
    return admin("PATCH", `/entries/${made.id}`, fields, version_(made.rev));
  };
  const publish = (entry) => admin("POST", `/entries/${entry.id}/publish`, {}, version_(entry.rev));
  const save = (entry, fields) =>
    admin("PATCH", `/entries/${entry.id}`, fields, version_(entry.rev));

  const about = await publish(
    await write("page", {
      title: "Sobre nós",
      doc: doc(
        {
          type: "section",
          attrs: { kind: "intro", preset: "2", tone: "accent", align: "center" },
          content: [
            heading(2, "Desde 1987"),
            p(text("Feito à mão.")),
            { type: "button", attrs: { href: "/contact", label: "Fale conosco" } },
          ],
        },
        {
          type: "section",
          attrs: { kind: "pictureText", preset: "1", tone: "muted", align: "left" },
          content: [
            { type: "image", attrs: { mediaId: loaf.id, alt: null } },
            p(text("O forno chega a 250 °C.")),
          ],
        },
        {
          type: "section",
          attrs: { kind: "contact", preset: "2", tone: "none", align: "left" },
          content: [heading(2, "Onde estamos")],
        },
      ),
    }),
  );

  // Everything that can be in a post, and everything that could be taken for code.
  const everything = await publish(
    await write("post", {
      title: "Olá, mundo! 你好 مرحبا 👩‍👩‍👧‍👦 <script>",
      summary: 'A summary with "quotes", an & and <tags>.',
      tagIds: tags.map(({ id }) => id),
      featuredImage: { mediaId: loaf.id, alt: "The loaf" },
      seo: { title: "A search title", description: "A description", noindex: false },
      doc: doc(
        heading(2, "Título"),
        p(
          text("Bold", { type: "bold" }),
          text(", "),
          text("italic", { type: "italic" }),
          text(", "),
          text("underlined", { type: "underline" }),
          text(", "),
          text("struck", { type: "strike" }),
          text(" and "),
          text("code < & >", { type: "code" }),
          { type: "hardBreak" },
          text("after a break. "),
          text("Sobre nós", link(`entry:${about.id}`)),
          text(", "),
          text("elsewhere", link("https://example.com/?a=1&b=2"), { type: "bold" }),
          text(", "),
          text("email", link("mailto:oi@example.com")),
          text(" and "),
          text("the menu", link(menuPdf.url)),
        ),
        p(text("שלום עולם, right to left. Zero​width, é and é.")),
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                p(text("One")),
                {
                  type: "orderedList",
                  attrs: { start: 3 },
                  content: [{ type: "listItem", content: [p(text("Three, inside one"))] }],
                },
              ],
            },
          ],
        },
        { type: "blockquote", content: [p(text("“A quote”")), p(text("of two paragraphs"))] },
        {
          type: "codeBlock",
          content: [text('<script>alert("x")</script>\n{{ site.name }}\n\ttabbed\n')],
        },
        {
          type: "image",
          attrs: {
            mediaId: oven.id,
            alt: "Said here",
            decorative: false,
            caption: "Uma legenda & tal",
            size: "wide",
          },
        },
        { type: "horizontalRule" },
        { type: "button", attrs: { href: "https://example.com", label: "Um botão" } },
        heading(3, "Menor"),
        heading(4, "Menor ainda"),
      ),
    }),
  );

  // On the site, with newer words that aren't.
  const waiting = await publish(
    await write("post", { title: "Com mudanças", doc: doc(p(text("O que está no site."))) }),
  );
  await save(waiting, { title: "Com mudanças!", doc: doc(p(text("O que ainda não está."))) });

  // Moved twice, so one redirect leads to another's place.
  let moved = await publish(
    await write("post", { title: "Mudou de lugar", doc: doc(p(text("Siga o caminho."))) }),
  );
  for (const slug of ["segundo-lugar", "terceiro-lugar"]) {
    moved = await publish(await save(moved, { slug }));
  }

  // Taken off the site, in the Trash, never published, and one that's a conflict.
  const off = await publish(
    await write("post", { title: "Fora do ar", doc: doc(p(text("Saiu."))) }),
  );
  await admin("POST", `/entries/${off.id}/unpublish`, {}, version_(off.rev));
  const gone = await publish(await write("post", { title: "No lixo", doc: doc(p(text("Foi."))) }));
  await admin("POST", `/entries/${gone.id}/trash`);
  await write("post", { title: "", doc: doc(p(text("Sem título."))) });
  const contested = await write("post", { title: "Conflito", doc: doc(p(text("Uma."))) });
  await save(contested, { doc: doc(p(text("Duas."))) });
  const lost = await send(
    "PATCH",
    `/api/admin/entries/${contested.id}`,
    { doc: doc(p(text("Três, que perdeu."))) },
    version_(contested.rev),
  );
  if (lost.status !== 409) throw new Error(`A conflict answered ${lost.status}`);
  const long = await publish(
    await write("page", {
      title: "L".repeat(190),
      doc: doc(...Array.from({ length: 120 }, (_, n) => p(text(`Parágrafo ${n}. `.repeat(12))))),
    }),
  );

  // The site's own choices, each changed twice, so there's history to undo.
  for (const note of ["Fechado nos feriados", "Fechado no Carnaval"]) {
    await admin("PUT", "/settings/business", {
      address: "Rua das Flores, 12\nSão Paulo",
      phone: "+55 11 5555-0100",
      email: "oi@example.com",
      mapUrl: "https://example.com/map",
      hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
        day,
        closed: day === "sun",
        opens: "07:00",
        closes: "18:30",
      })),
      hoursNote: note,
    });
  }
  await admin("PUT", "/settings/seo", { description: "Pães & bolos", imageId: loaf.id });
  await admin("PUT", "/settings/code", {
    head: '<meta name="fixture" content="yes">',
    bodyEnd: "<!-- the end -->",
  });
  const design = await admin("GET", "/design");
  for (const footerText of ["© Rise & Shine", "© Rise & Shine, 1987"]) {
    await admin("PUT", "/design", {
      ...design.value,
      logoId: loaf.id,
      footerText,
      social: [{ network: "instagram", url: "https://example.com/rise" }],
      customCss: ".t-intro { letter-spacing: 0.01em; }",
      theme: { ...design.value.theme, accent: "#7a3b12", fonts: "classic", header: "centered" },
    });
  }
  const item = (id, label, target, children = []) => ({ id, label, target, children });
  await admin("PUT", "/menus/main", {
    items: [
      item("home", "Início", { type: "home" }),
      item("about", null, { type: "entry", id: about.id }, [
        { id: "shop", label: "Loja", target: { type: "url", url: "https://example.com/shop" } },
        { id: "tag", label: null, target: { type: "tag", id: tags[0].id } },
      ]),
      item("gone", null, { type: "entry", id: gone.id }),
      item("blog", "Notícias", { type: "blog" }),
    ],
  });
  await admin("PUT", "/menus/footer", {
    items: [item("long", "Longa", { type: "entry", id: long.id })],
  });
  await admin("POST", "/redirects", { from: "/café", to: "/sobre-nos" });
  await admin("POST", "/redirects", { from: "/100%-rye", to: "https://example.com/rye" });

  // People: one who joined, one who can't sign in, one invited, one whose invite was taken back.
  const invite = (email, role) => admin("POST", "/people/invites", { email, role });
  const join_ = async (email, role, name) => {
    const { token } = await invite(email, role);
    const someone = person(base);
    const { user } = await someone.ask("POST", "/api/auth/invite/accept", {
      token,
      name,
      password: OWNER.password,
    });
    return { someone, user };
  };
  await join_("ana@example.com", "admin", "Ana Müller");
  const ed = await join_("ed@example.com", "editor", "Ed Ward");
  const wes = await join_("wes@example.com", "writer", "Wes");
  const draft = await wes.someone.ask("POST", "/api/admin/entries", { type: "post" });
  await wes.someone.ask(
    "PATCH",
    `/api/admin/entries/${draft.id}`,
    { title: "Do Wes", doc: doc(p(text("Por Wes."))) },
    version_(draft.rev),
  );
  await admin("PATCH", `/people/${ed.user.id}`, { disabled: true });
  await invite("waiting@example.com", "editor");
  const { invite: back } = await invite("back@example.com", "writer");
  await admin("DELETE", `/people/invites/${back.id}`);
  await ask("POST", "/api/auth/recovery-kit", { password: OWNER.password });

  // What this version says about all of it.
  const paths = [
    "/entries?type=post",
    "/entries?type=page",
    "/entries?type=post&view=trash",
    "/media",
    "/media?view=trash",
    "/menus",
    "/design",
    "/redirects",
    "/tags",
    "/people",
    "/settings/general",
    "/settings/business",
    "/settings/seo",
    "/settings/code",
    "/settings/visibility",
  ];
  const api = {};
  for (const path of paths) api[path] = await admin("GET", path);
  // Signing in to look changes these.
  for (const someone of api["/people"].people) delete someone.lastSeenAt;
  for (const list of paths.slice(0, 3)) {
    for (const { id } of api[list].entries) {
      api[`/entries/${id}`] = await admin("GET", `/entries/${id}`);
      const { revisions } = await admin("GET", `/entries/${id}/revisions`);
      api[`/entries/${id}/revisions`] = { revisions };
      for (const { id: rid } of revisions.slice(0, 2)) {
        // All but how it looks, which the theme and the date decide.
        const { previewHtml, ...kept } = await admin("GET", `/revisions/${rid}`);
        if (!previewHtml) throw new Error("A version has no page to look at");
        api[`/revisions/${rid}`] = kept;
      }
    }
  }

  // And what visitors read: every page on the site has its title and its words.
  const wordsOf = (node) =>
    node.type === "text" ? [node.text] : (node.content ?? []).flatMap(wordsOf);
  const pages = {};
  for (const entry of [about, everything, moved, long]) {
    const { data, title, url } = await admin("GET", `/entries/${entry.id}`);
    pages[url] = [title, ...wordsOf(data.doc)];
  }
  pages[waiting.url] = ["Com mudanças", "O que está no site."];
  const leadsTo = { "/blog/mudou-de-lugar": moved.url, "/caf%C3%A9": "/sobre-nos" };

  await stopped();
  const dbPath = join(folder, "data", "tend.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA journal_mode = DELETE");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(({ name }) => name)
    .sort();
  const rows = Object.fromEntries(
    tables.map((name) => [name, db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]),
  );
  db.close();
  for (const [name, count] of Object.entries(rows)) {
    if (count === 0) throw new Error(`Nothing in ${name}, so nothing would be checked about it`);
  }

  const made = { version, madeAt: Date.now(), owner: OWNER, rows, api, pages, leadsTo };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${version}.db.gz`), gzipSync(readFileSync(dbPath), { level: 9 }));
  writeFileSync(join(out, `${version}.json.gz`), gzipSync(JSON.stringify(made), { level: 9 }));
  console.log(`fixtures/upgrades/${version}:`, rows);
} catch (error) {
  console.error(`The fixture wasn't made: ${error.message}\n\nTend's output:\n${output}`);
  process.exitCode = 1;
} finally {
  await stopped();
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
