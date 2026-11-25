# The Railway template

Railway templates are made in Railway's own editor, not from a file in a repository. This is what Tend's has in it, so that it can be made again and checked against.

## The service

| Setting | Value | Why |
|---|---|---|
| Name | `Tend` | |
| Source | Docker image `ghcr.io/tendcms/tend:0` | **Redeploy** gets the newest 0.x. |
| Volume | mounted at `/data` | Everything the site is. Tend warns if it's missing. |
| Public networking | HTTP, a generated domain, port `3000` | |
| Health check path | `/healthz` | Railway waits for it before it calls a deploy done. |
| Restart policy | On failure | |
| Replicas | 1 | One process, one folder: a second one stops with a reason. |
| Serverless (app sleeping) | off | A sleeping site makes its first visitor wait. |

## Variables

| Variable | Value | Shown to the person |
|---|---|---|
| `TEND_SETUP_CODE` | required, no default | **Choose a setup password** (you'll type it once). At least 8 characters. |
| `RAILWAY_RUN_UID` | `0` | no: Railway's volumes belong to root, and the image runs as `node` otherwise. |
| `PORT` | `3000` | no |

`RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_ENVIRONMENT` come from Railway. Tend uses the first as the site's address until someone confirms another, and takes one proxy's word for who's visiting because of the second.

## What the template's page says

> **Tend** is an easy, fast CMS for a small website that you own.
>
> **It needs Railway's Hobby plan:** $5 a month, which includes $5 of usage, and a card. Railway's Trial and Free plans would stop your site. You can set a usage limit in Railway, so that it can't cost more than you expect.
>
> **Deploying takes 2 to 3 minutes.** Then open the address Railway gives you, type the setup password you chose, and start a new site, or start from a backup of one you made on your computer.
>
> **Updating:** open the service's menu and choose **Redeploy**. The site is away for a moment while the new version starts.

Check the plan's price and what it includes on [Railway's pricing page](https://railway.com/pricing) whenever the template changes.

## Trying it

1. Deploy the template into a new project.
2. Open its address, type the setup password, and go through setup.
3. The Overview asks whether the address is the site's. Choose **Use this address**.
4. Write a post with a photo, and publish it.
5. **Redeploy**, and check that the post and the photo are still there.
6. In the site's admin, **Help** has nothing to fix. A warning about the data folder means the volume is missing.
