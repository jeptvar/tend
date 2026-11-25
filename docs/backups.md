# Back up and restore

There are two kinds, and you want both.

| | Download a backup | Copies kept on the server |
|---|---|---|
| Has | Everything: pages, posts, settings, accounts, photos and files | Pages, posts, settings and accounts. Photos and files stay where they are. |
| Where it is | Wherever you keep it | On the same disk as the site |
| Made | When you download it | Every day at 3 in the morning, before every update and restore, and when you choose **Save a copy now** |
| Good for | Losing the server, moving, starting again | Yesterday's mistake, an update that went wrong |

A host's own snapshot of a volume is good to have as well. It isn't a backup you hold.

## Download a backup

**Settings**, then **Backups**, then **Download backup**. Only the Owner can.

**Keep it private.** It holds everyone's sign-in details, so anyone who has it can make a copy of your site.

Overview reminds the Owner when it's been a month. From the command line: `tendcms backup`, which can run beside the site.

Themes of your own aren't in it, because they're part of where your site runs: keep them in a repository or a folder of their own.

## Copies on the server

Tend keeps the last 7 daily copies, one from each of the 4 weeks before those, 3 from before updates, 3 from before restores and 5 of those you saved. Together they never take more than a fifth of the disk, so on a small one there are fewer. The Owner can download any of them.

They're files in the data folder: `backups/daily-20271121T030000.000Z.db.gz`, for example.

A photo you delete forever stays on the disk for up to six weeks while a copy still shows it, or less if space runs low.

## Put a backup back

- **Into a new Tend:** choose **Start from a backup** when you set it up. This is also how you [move](move-your-site.md).
- **Over a site that's here:** [from the command line](#restore-from-the-command-line). Doing it from the admin comes in a later version.

Everything is checked before anything changes: each file against what the backup says it should be, and the whole database. What was there before is saved first.

## Restore from the command line

1. Stop Tend.
2. In your site's folder:

   ```
   npx tendcms restore rise-bakery-backup-PRIVATE-2027-11-21.zip
   ```

   It takes a backup, or a copy: `npx tendcms restore data/backups/daily-20271121T030000.000Z.db.gz`.
3. Start Tend.

With Docker, put the file in the volume first, then:

```
docker compose stop tend
docker compose run --rm --volume "$PWD:/from" tend tendcms restore /from/rise-bakery-backup-PRIVATE-2027-11-21.zip
docker compose start tend
```

It says where the site that was there before is saved, so you can go back to it the same way. A copy from before a restore may have its key file beside it, with the same name and `.secret.key`.

## Restore a copy by hand

For when `tendcms restore` isn't an option: you're going back to the version of Tend you had before an update.

1. Stop Tend.
2. In the data folder, move `tend.db`, `tend.db-wal` and `tend.db-shm` somewhere else. Some of them may not be there.
3. Unpack the copy as `tend.db`. The message named it, such as `backups/pre-0.2.0-from-0.1.3-20271121T030000.000Z.db.gz`:

   ```
   gunzip --stdout backups/pre-0.2.0-from-0.1.3-20271121T030000.000Z.db.gz > tend.db
   ```

   On Windows, 7-Zip unpacks it.
4. Start the version of Tend the copy is from: its name says which, after `from`.

## How to know a backup is good

Restore it somewhere else, once. On your computer: `npm create tend@latest try-it`, choose **Start from a backup**, and look around. Then delete the folder.
