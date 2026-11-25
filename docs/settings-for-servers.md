# Settings for servers

None of them is needed. They're environment variables, for where Tend runs. Everything about the site itself is in the admin.

| Variable | Without it | What it's for |
|---|---|---|
| `PORT` | 3000. With npm, the next free one up to 3010 if that's taken | Where to listen |
| `TEND_DATA_DIR` | `./data`, or `/data` in Docker | The folder the whole site is in |
| `TEND_PUBLIC_URL` | The address an Admin confirms in the admin, or the one Railway, Render or Fly gives | The site's address, such as `https://example.com`. It decides links and cookies, and can't be changed in the admin. |
| `TEND_TRUST_PROXY` | 1 on Railway, Render and Fly, otherwise 0 | How many [proxies](proxies.md) are in front |
| `TEND_SETUP_CODE` | A code Tend makes and prints | A setup password of your own, 8 characters or more. Only used until the site is set up. |
| `TEND_HOST` | This computer only with npm, everyone in Docker and on hosts | Which address to listen on |
| `TEND_CACHE_MB` | 32 | How much memory kept pages may take. 0 keeps none. On a site at `localhost`, none are kept. |
| `TEND_PLATFORM` | Worked out | `docker` says it's in a container, where Tend can't tell. The image sets it. |

Tend also looks at what hosts set themselves: `RAILWAY_ENVIRONMENT`, `RAILWAY_PROJECT_ID`, `RAILWAY_PUBLIC_DOMAIN`, `RENDER`, `RENDER_EXTERNAL_URL` and `FLY_APP_NAME`.

## The data folder

| | |
|---|---|
| `tend.db`, `tend.db-wal`, `tend.db-shm` | Pages, posts, settings and accounts |
| `uploads/originals` | Photos and files |
| `uploads/variants` | The sizes made of photos. They can be deleted: they're made again. |
| `backups` | Copies of the data |
| `secret.key` | Guards recovery codes and the devices people have signed in from |
| `themes` | Themes of your own, in Docker |
| `.lock.db`, `.lock` | Keep a second Tend out |

To move a site by hand: stop Tend, copy the whole folder, and start Tend with the copy. While Tend runs, use `tendcms backup` instead.

## What Tend listens for

- `GET /healthz` answers `{"ok":true,"version":"0.1.0"}`, for a host's health check.
- `SIGTERM` stops it: it finishes what it's answering, for up to 5 seconds, and closes the database.
