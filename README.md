# Tend CMS

An easy, fast, self-hosted CMS for small websites. **In development**: nothing is released yet.
The full plan lives in [PLAN.md](PLAN.md).

## Working on Tend

You need Node.js 26 (24 also works) and pnpm 12. With [fnm](https://github.com/Schniz/fnm), `.node-version` picks the right Node for you.

```bash
pnpm install
pnpm dev          # server on http://localhost:3000, admin with hot reload
```

Open http://localhost:3000/admin/setup. Development data lives in `./data` (git-ignored); delete it to start over.

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the server from TypeScript (`node --watch`) and the admin's Vite dev server together |
| `pnpm build` | Builds the admin, then bundles the server into `packages/tendcms/dist` |
| `pnpm smoke` | Boots the built package from an empty folder and checks it serves the real admin |
| `pnpm test` | Vitest: server boot, admin serving, data-folder lock, port handling, migrations |
| `pnpm lint` | Biome, plus a check that no migration contains a `PRAGMA` |
| `pnpm typecheck` | `tsc -b` across the packages |
| `pnpm db:generate <name>` | Generates a migration from `src/db/schema.ts` and strips drizzle's `PRAGMA` lines |

## Layout

```
packages/
  tendcms/     the published package: server, CLI, migrations (bundled by tsdown)
  admin/       React admin (Vite); copied into tendcms/dist/admin at build time
scripts/       dev runner and migration helpers (zero dependencies)
```

Migrations are applied by Tend's own runner (`packages/tendcms/src/db/migrate.ts`), never by drizzle's migrator. It snapshots the database first, turns foreign keys off outside the transaction, and restores the snapshot if anything fails after commit (PLAN.md §13).
