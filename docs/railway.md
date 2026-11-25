# Railway

Railway runs Tend for you, with no commands to type. It takes about 20 minutes, with signing up.

**It needs the Hobby plan:** $5 a month, which includes $5 of usage, and a card. The Trial and Free plans would stop your site. [What it costs](costs.md) says more, and how to set a limit.

## Start

1. Open [tendcms.dev/railway](https://tendcms.dev/railway) and choose **Deploy**. Sign up, and choose **Hobby**.
2. It asks for one thing: a **setup password**. Make one up of 8 characters or more, and write it down. You'll type it once.
3. Wait 2 to 3 minutes, then open the address Railway gives you. It ends with `up.railway.app`.
4. Type the setup password. Then **Start a new site**, or **Start from a backup**.
5. Overview asks whether the address is the site's. Choose **Use this address**, or [connect your domain](connect-your-domain.md) first.

## Update

Open your project, then the service, then its menu (**⋯**), and choose **Redeploy**. Railway gets the newest version. Your site is away for a moment while it starts. Tend saves a copy of your data first.

**To go back:** open **Deployments**, then the one before, and choose **Redeploy** there. If the update changed the database, put back the copy from before it: [Restore a copy by hand](backups.md#restore-a-copy-by-hand).

## What's where

- Your site is on the service's **volume**, mounted at `/data`. Deleting the volume deletes the site.
- The Hobby plan's volumes hold 5 GB. Overview says how full it is.
- Railway can back the volume up as well: **Settings** of the volume, then **Backups**. Turn it on, and [download a backup](backups.md#download-a-backup) all the same.

## If something's wrong

- **"Can't write to its data folder":** the variable `RAILWAY_RUN_UID` has to be `0`. Railway's volumes belong to root.
- **"The data folder isn't on a volume":** the service has none. If your site is set up, download a backup first. Then attach a volume mounted at `/data`, and redeploy.
- **You forgot the setup password:** it's the variable `TEND_SETUP_CODE`. It's only used until the site is set up.
- Everything Tend prints is under **Deployments**, then **View logs**.
