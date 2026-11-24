# The data folder isn't on a volume

> /data isn't on a volume, so this site is lost when its container is replaced.

## What happened

A container's own files go with it at the next update. What has to last lives on a volume, which is kept apart from it.

## What to do

- If the site is set up: download a backup first, in Settings → Backups.
- Railway: attach a volume mounted at `/data` to the service, then redeploy.
- Docker: start it with a volume that has a name, `--volume tend-data:/data`, or use the [compose file](../own-server.md).
- A new volume starts empty, so choose **Start from a backup** to put the site back.
