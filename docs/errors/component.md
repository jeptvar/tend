# A component won't load

> The database, picture or password component couldn't be loaded.

## What happened

Tend uses three components made for your system: better-sqlite3, sharp and @node-rs/argon2. Installing on one system and running on another, or with a Node.js they don't know, leaves the wrong one. Without the picture component Tend runs, and [pictures can't be added](pictures_unavailable.md). Without one of the others it doesn't start.

## What to do

- Install Tend again, on the computer it runs on: delete `node_modules`, then `npm install`.
- On Alpine Linux or another system without glibc, use the [Docker version](../own-server.md).
- On a virtual machine whose processor is too old, choose a newer processor type for it, such as `host`.
