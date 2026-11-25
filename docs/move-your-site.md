# Move your site online

From your computer to Railway or a server of your own, or from one host to another: it's the same. Everything comes over: pages, posts, photos, settings and everyone's accounts. Once you have somewhere to put it, it takes about ten minutes.

1. **Download a backup** of the site you have: **Settings**, then **Backups**, then **Download backup**. Keep it private.
2. **Start a new Tend** where the site will be: on [Railway](railway.md), or on [a server of your own](own-server.md).
3. **Open its address** and type its setup password or code.
4. **Choose Start from a backup**, then the file. It's sent in pieces, so it can be big, and a progress bar shows how far it is. Keep the page open.
5. **Sign in** with the same email and password as before.
6. Overview asks whether the address you're at is the site's. Choose **Use this address**.

Until you do, links in your pages, the sitemap and previews on social media follow the address each page is opened at, so nothing ever says `localhost`.

Your site is live. From then on make your changes there: nothing you change in one reaches the other.

## Afterwards

- [Connect your domain](connect-your-domain.md).
- Photos can take a moment the first time they're seen: their sizes aren't in a backup, and are made again.
- A theme of your own isn't in a backup. [Themes](themes.md) says where to put it.
- When you're sure everything is there, the old one can go.

## If it doesn't work

- **The backup can't be used:** [why, and what to do](errors/backup_refused.md). One made by a newer Tend needs a Tend at least as new.
- **The connection drops:** each part is tried again by itself, up to 5 times. If it stops for good, choose the file and try again: it starts from the beginning.
- **"Already set up":** Start from a backup is only there before a site is set up. Start another new Tend, or use [the command line](backups.md#restore-from-the-command-line).
