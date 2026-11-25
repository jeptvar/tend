# Tend CMS

An easy, fast, self-hosted CMS for small websites. One command on your computer, one click on Railway, or one Docker line, and a few minutes later a site that already looks finished. No accounts with anyone, no JavaScript for your visitors, and everything in one folder that's yours.

**In development: nothing is released yet.** The plan is [PLAN.md](PLAN.md), and [what's built so far](CHANGELOG.md) is in the changelog.

- [The guide](docs/README.md): how to use it, and where it can run
- [Principles](docs/principles.md) and [decisions](docs/adr/README.md)
- [Working on Tend](CONTRIBUTING.md), with [a code of conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md) and [privacy](docs/privacy.md)

## Try it from source

You need Node.js 26 (24 also works) and pnpm 12. With [fnm](https://github.com/Schniz/fnm), `.node-version` picks the right Node for you.

```bash
pnpm install
pnpm dev          # server on http://localhost:3000, admin with hot reload
```

Open the setup link it prints. Your data is in `./data`, which git ignores: stop Tend and delete it to start over. If you lose the link, its code is in:

```bash
TEND_DATA_DIR=./data node packages/tendcms/src/cli.ts setup-code
```

## Layout

```
packages/
  tendcms/      the published package: server, command line, migrations (bundled by tsdown)
  admin/        the admin, in React (Vite); copied into tendcms/dist/admin at build time
  create-tend/  npm create tend
themes/meadow/  the theme: templates, styles, fonts, words and starting points
e2e/            tests in real browsers (Playwright)
fixtures/       a site from each version, to upgrade
docs/           the guide, the error pages and the decisions
docker/         the image, the compose file and Caddy's config
deploy/         templates for hosts
scripts/        development, checks and releases (zero dependencies)
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the commands. Migrations are applied by Tend's own runner (`packages/tendcms/src/db/migrate.ts`), never by drizzle's: [why](docs/adr/0007-migrations-in-one-transaction.md).

## Licence

[MIT](LICENSE). The name isn't part of it: [TRADEMARKS.md](TRADEMARKS.md).
