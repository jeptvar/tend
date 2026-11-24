# Releasing Tend

For maintainers. A release is a signed tag; `.github/workflows/release.yml` does the rest, and waits for your click before it publishes.

## Before the first release

Only once, and only whoever owns the names can do it:

1. On npm, claim `tendcms` and `create-tend`, and `tend-cms` and `create-tendcms` so that nobody else has them. Publish a placeholder of each by hand, with a passkey.
2. On npm, in the settings of `tendcms` and of `create-tend`, add a **trusted publisher**: this repository, the workflow `release.yml` and the environment `release`. Then choose **Require two-factor authentication and disallow tokens**.
3. On GitHub, make an environment called `release`, with yourself as a required reviewer, that only tags matching `v*` can use.
4. Make sure `repository` in both packages' `package.json` names this repository. npm checks it against where the release was made.
5. Make a key to sign tags with, and add it to your GitHub account, so that GitHub shows its tags as verified.
6. After the first release, make the image public: on GitHub, the package **tend**, then **Package settings**, then **Change visibility**.

## Each release

1. Choose the version. Before 1.0, a new minor version can need something from people, and a patch can't.
2. Set it in `packages/tendcms/package.json` and `packages/create-tend/package.json`. They're always the same.
3. In `CHANGELOG.md`, give what's under **Unreleased** the heading `## [0.1.0] - 2026-12-01`, and leave an empty **Unreleased** above it. It's for the people who run Tend: say what they'll notice, and what they have to do.
4. Make the site that later versions are upgraded from, and commit what it writes:

   ```
   pnpm build
   node scripts/make-fixture.mjs
   ```

5. Check it, the way the release will:

   ```
   node scripts/check-release.mjs v0.1.0
   ```

6. Merge it to `main`, and wait for CI there.
7. Look at last night's `lighthouse` and `nightly` runs.
8. Go through what only a person can check: a real iPhone and a real Android phone (writing a post, changing the hours), and a screen reader.
9. Sign the tag and push it:

   ```
   git tag --sign v0.1.0 --message "Tend 0.1.0"
   git push origin v0.1.0
   ```

10. When the release has been built and tried on three systems, approve the **publish** job.
11. The image, what's on npm, and the release's page follow by themselves. Watch them.

## If it goes wrong

- **Before publishing:** nothing has happened. Delete the tag, fix it, and tag again.
- **While publishing:** run the job again. What's on npm already is left as it is.
- **After publishing:** npm doesn't let a version be replaced. Tell people not to use it, then fix it in a patch:

  ```
  npm deprecate tendcms@0.1.0 "Has a problem: use 0.1.1"
  npm deprecate create-tend@0.1.0 "Has a problem: use 0.1.1"
  ```

## Railway

The template is described in [deploy/railway](../deploy/railway/README.md). `.github/workflows/railway-check.yml` redeploys a test site made from it every week, and expects the newest version with the same content. To set that up:

1. Make a Railway project from the template, and set its site up.
2. Make a **project token** for it, in the project's settings.
3. On GitHub, make an environment called `railway` with the secret `RAILWAY_TOKEN`, and the repository variables `RAILWAY_CHECK_URL` (the site's address, with no slash at the end), `RAILWAY_SERVICE_ID` and `RAILWAY_ENVIRONMENT_ID`. The IDs are in the address of the service's page.
