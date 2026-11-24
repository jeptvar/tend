# Tend can't write to its data folder

> Tend can't write to its data folder.

## What happened

Everything a site is made of lives in one folder, and Tend isn't allowed to write there, or its disk is full or read-only.

## What to do

- Railway: set `RAILWAY_RUN_UID=0` in the service's variables, then redeploy.
- Docker with a folder from the server: `sudo chown -R 1000:1000 <that folder>`, since Tend runs as user 1000.
- npm: give your own user write access to the folder, or choose another with `TEND_DATA_DIR`.
- If the message says the disk is full, make room on it. If it says read-only, mount it to be written to as well.
