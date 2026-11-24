# Proxies

For a server of your own. Railway, Render and Fly need nothing, and neither does the [compose file](own-server.md), which has Caddy.

A proxy, such as Caddy, nginx or Traefik, takes care of HTTPS and passes visitors on to Tend. Tell Tend two things:

| Setting | Why |
|---|---|
| `TEND_PUBLIC_URL=https://example.com` | What the site's address is, whatever the proxy says. Sign-in cookies need it to be https. |
| `TEND_TRUST_PROXY=1` | How many proxies there are between visitors and Tend, so that it knows who's visiting. |

**`TEND_TRUST_PROXY` is a number of proxies.** With 1, the visitor is the last address in `X-Forwarded-For`, which your proxy added. With 2, say Cloudflare in front of nginx, it's the one before. Too low, and everyone looks like your proxy, so limits on signing in are shared by all of them. Too high, and anyone can pretend to be someone else by sending the header.

Tend warns in its window when requests come through a proxy it wasn't told about.

## Caddy

```
example.com {
	reverse_proxy localhost:3000
}
```

## nginx

```
server {
    listen 443 ssl;
    server_name example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Uploads are up to 20 MB, and backups come in pieces of 8 MB.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Traefik

Its defaults pass on what Tend needs. Point a service at port 3000.

## What has to reach Tend

- **`Host`**, as the visitor sent it. Tend compares it to where requests come from.
- **`X-Forwarded-For`**, with the visitor's address added at the end.
- Uploads of up to 20 MB in one request, and time for a big backup to download.

## Keep Tend to itself

Only the proxy should reach Tend's port. With npm, Tend listens on this computer only, unless `TEND_HOST` says otherwise. With Docker, use `-p 127.0.0.1:3000:3000`, or don't publish the port at all.

## Caching

Pages say `max-age=0, must-revalidate`: a proxy or CDN that keeps them asks Tend every time, and Tend answers that nothing has changed. Pictures and styles have addresses that change with their contents, and can be kept forever. Anything under `/admin` and `/api` is never to be kept.
