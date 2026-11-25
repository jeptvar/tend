# Where can Tend run?

Tend needs two things: a computer that keeps running, and a disk that keeps your files.

## Works

| Where | What to know |
|---|---|
| **Your computer** | Windows, macOS or Linux, with Node.js 24 or newer. Only you can see the site. |
| **[Railway](railway.md)**, on the Hobby plan | With a volume at `/data`, which the template makes. |
| **[A server of your own](own-server.md)** | Any VPS with Docker, or with Node.js. |
| **Render**, on a paid instance with a disk | Set the disk's mount path to `/data` and use the Docker image. There's no template yet. |
| **Fly.io**, with a volume | Mounted at `/data`, with one machine. There's no template yet. |

## Doesn't work

| Where | Why |
|---|---|
| **Vercel, Netlify, AWS Lambda** and other serverless hosts | They start afresh for each visit, and keep no files. Tend says so and stops. |
| **Railway's Trial and Free plans** | They stop your site when the credit runs out. |
| **Render's free tier** | It has no disk, so everything would be lost at the next restart. |
| **Shared hosting for PHP** | It can't keep Node.js running. |
| **A folder on a network drive** | The database's locks aren't reliable there. Use a disk that belongs to the machine. |
| **Two copies on one folder** | One site is one Tend. The second one says so and stops. |

## What it needs

- **Memory:** about 100 MB when idle. Preparing a big photo takes more for a moment, so 512 MB in all is comfortable. On a small server, photos too big for it are refused with a reason.
- **Disk:** your photos, and the copies Tend keeps, which never take more than a fifth of it.
- **Processor:** anything from about 2009 on, 64-bit Intel, AMD or Arm.

`tendcms doctor` checks a place for all of this.
