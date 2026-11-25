# Update Tend

| | How |
|---|---|
| **Railway** | The service's menu (**⋯**), then **Redeploy** |
| **Docker** | `docker compose pull`, then `docker compose up -d` |
| **npm** | `npm install tendcms@0.2.0` in your site's folder, with the version you want, then stop Tend and `npm start` |

[The changelog](../CHANGELOG.md) says what's new, and what needs something from you.

## What happens

1. Tend saves a copy of your data, if the update changes how it's stored. The last 3 are kept.
2. It makes the change, all at once. If anything fails, nothing is changed, and Tend says so and stops.
3. Pages that the new version draws differently are drawn again.
4. Your site is back. It's away for a few seconds, or longer for a big change.

Your pages, photos, settings and themes stay as they are.

## Go back

If the update changed the database, an older Tend won't open it, and says so. So:

1. Put back the copy from before the update: [Restore a copy by hand](backups.md#restore-a-copy-by-hand). It has nothing you changed since.
2. Start the version you had: with Railway, **Redeploy** the deployment before. With Docker, set the version in `compose.yml`, such as `ghcr.io/tendcms/tend:0.1.3`. With npm, `npm install tendcms@0.1.3`.

## Before you update

Nothing is required. Downloading a backup first is a good habit.

## Versions

Before 1.0, `0.2.0` after `0.1.3` can need something from you, and the changelog says what. `0.1.4` after `0.1.3` never does. The current 0.x and the one before get security fixes.

Tend doesn't look for updates by itself in this version, and tells nobody that you're using it. Watch [the releases](https://github.com/tendcms/tend/releases) to hear of them.
