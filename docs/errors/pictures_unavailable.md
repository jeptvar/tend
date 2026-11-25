# Pictures can't be added on this server

> Tend can't prepare pictures on this server, so that wasn't done.

## What happened

Tend prepares pictures with sharp, a component made for your system. It couldn't be loaded, so no picture can be added or replaced. Everything else works. The pictures your site has still show, and any that need a size made again show as they were uploaded, which takes visitors longer to load. PDFs can be added as usual.

## What to do

- Sign in as an Admin and open Help in the admin. It says why the component couldn't load.
- Install Tend again, on the computer it runs on: delete `node_modules`, then `npm install`, then start Tend again.
- On Alpine Linux or another system without glibc, use the [Docker version](../own-server.md).
- On a virtual machine whose processor is too old, choose a newer processor type for it, such as `host`.
