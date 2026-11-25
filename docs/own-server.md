# A server of your own

With Docker, on any Linux server you can reach with SSH. Caddy comes with it and sets up HTTPS. A small one is enough: 1 processor and 1 GB of memory.

## Before you start

- A server with [Docker](https://docs.docker.com/engine/install/) and its compose plugin, and ports 80 and 443 open.
- A domain. Point its A record (and AAAA, if the server has IPv6) at the server **first**, and check it, or getting a certificate fails and you may have to wait to try again:

  ```
  dig +short example.com
  ```

## Start

1. Make a folder, and get the two files:

   ```
   mkdir tend && cd tend
   curl -O https://raw.githubusercontent.com/tendcms/tend/main/docker/compose.yml
   curl -O https://raw.githubusercontent.com/tendcms/tend/main/docker/Caddyfile
   ```

2. Say what your domain is. This is the only setting:

   ```
   echo 'TEND_DOMAIN=example.com' > .env
   ```

3. Start it:

   ```
   docker compose up -d
   ```

4. Get the setup code:

   ```
   docker compose exec tend tendcms setup-code
   ```

5. Open `https://example.com/admin/setup` and type it.

## Update

```
docker compose pull
docker compose up -d
```

The image's `:0` tag is the newest 0.x. [Update Tend](updates.md) says more.

## Look after it

- **Logs:** `docker compose logs tend`
- **A check of everything:** `docker compose exec tend tendcms doctor`
- **A backup:** download it in the admin, or run:

  ```
  docker compose exec tend tendcms backup /data/site.zip
  docker compose cp tend:/data/site.zip .
  docker compose exec tend rm /data/site.zip
  ```

- **Your site** is on the volume `tend-data`. `docker compose down` keeps it. `docker compose down --volumes` deletes it.

## Without compose

```
docker run -d --name tend -p 3000:3000 -v tend-data:/data ghcr.io/tendcms/tend:0
```

Give the volume a name, as here: one without can be deleted with its container. For a folder on the server instead, it has to belong to user 1000:

```
sudo chown -R 1000:1000 /srv/tend
```

Put a proxy with HTTPS in front, and tell Tend about it: see [Proxies](proxies.md).

## Without Docker

Install Node.js 24 or newer, make the site with `npm create tend@latest my-site -- --no-start`, and run `npm start` in its folder with whatever keeps programs running on your server. Here's a unit for systemd:

```
[Unit]
Description=Tend
After=network-online.target

[Service]
User=tend
WorkingDirectory=/home/tend/my-site
ExecStart=/usr/bin/npm start
Environment=PORT=3000
Environment=TEND_PUBLIC_URL=https://example.com
Environment=TEND_TRUST_PROXY=1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Put a proxy with HTTPS in front: see [Proxies](proxies.md).
