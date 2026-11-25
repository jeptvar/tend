# Working on Tend

Thank you for looking. Small fixes are welcome as they are. For anything bigger, open an issue first: what gets in is decided by [a few principles](docs/principles.md), and it's a pity to do the work before knowing.

## Start

You need Node.js 26 (24 also works) and pnpm 12.

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000/admin/setup with the code it prints. The server restarts and the admin reloads as you change things. Your data is in `./data`, which git ignores: delete it to start over.

For a site with awkward things in it, rather than an empty one, before the first `pnpm dev`:

```bash
mkdir data
gunzip --stdout fixtures/upgrades/0.0.0.db.gz > data/tend.db
```

Then sign in as `zoe@example.com`, with the password in `scripts/make-fixture.mjs`. Its photos aren't there, only what's written about them.

## Where things are

| | |
|---|---|
| `packages/tendcms` | The server, the command line and the migrations |
| `packages/admin` | The admin, in React |
| `packages/create-tend` | `npm create tend` |
| `themes/meadow` | The theme |
| `e2e` | Tests in real browsers |
| `docs` | [The guide](docs/README.md), [decisions](docs/adr/README.md), [words we use](docs/glossary.md) |
| `PLAN.md` | What's being built, and why. Section 16 says where the code differs. |

## Check it

```bash
pnpm lint          # npx biome check --write . fixes what it can
pnpm typecheck
pnpm test
pnpm build
pnpm smoke         # the built package, from an empty folder
pnpm e2e           # after pnpm build, and once: pnpm exec playwright install chromium webkit
pnpm size          # what the admin and the theme weigh
node scripts/bench.mjs   # how quickly it answers
```

CI does all of it on Linux, macOS and Windows, and builds the Docker image.

## What we look for

- **It's true.** What a screen says has to be so, in every state it can be in.
- **It can be taken back,** with Undo or the Trash.
- **It works by keyboard,** at 320 px, with a screen reader, and on a phone.
- **It has words** from [the list](docs/glossary.md), in `messages/en.json`. Errors say what happened and what to do, and have a page in `docs/errors`.
- **It has a test** that fails without it. For anything on a journey (PLAN.md section 6), one in a browser.
- **It's in the guide,** if someone would look for it there.
- **Nothing new to install,** unless there's no other way. Packages wait 7 days after they're published.

## Commits

`type(scope): what changed`, such as `fix(editor): …`. Say why in the body, and what someone could learn from it. One change in each.

Sign off your commits (`git commit --signoff`), which says you may contribute them under [the MIT licence](LICENSE): the [Developer Certificate of Origin](https://developercertificate.org). There's no other agreement to sign.

Never copy code under the GPL, or from anywhere you don't know the licence of.

## Migrations

Change `src/db/schema.ts`, then `pnpm db:generate <name>`, and read what it wrote. Test it with rows that have others under them. The fixtures in `fixtures/upgrades` are upgraded on every run.

## Security

Not in an issue, please: see [SECURITY](SECURITY.md).
