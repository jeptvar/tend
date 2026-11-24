# Connect your domain

With a domain of your own, people find your site at a name like `www.risebakery.com`. It takes about 15 minutes, and then some waiting. Your site has to be [online](move-your-site.md) first.

**Use the name with `www` as your main address.** Many domain companies can't point the bare name, `risebakery.com`, at a host. They can forward it to the one with `www`.

## 1. Tell your host about the domain

**Railway:** open the service, then **Settings**, then **Networking**, then **Custom domain**. Type the name with `www`. Railway shows two records, a **CNAME** and a **TXT**. Both are needed.

**A server of your own:** put it in `.env` as `TEND_DOMAIN`, then run `docker compose up -d`.

**Somewhere else:** add it in your host's settings for the site.

## 2. Add the records where you bought it

| Company | Where |
|---|---|
| **Squarespace** (also domains from Google) | **Domains**, the domain, **DNS**, **DNS settings**, then **Custom records** |
| **GoDaddy** | **My products**, **DNS** beside the domain, then **Add new record** |
| **Namecheap** | **Domain list**, **Manage**, **Advanced DNS**, then **Add new record** |
| **Cloudflare** | the domain, **DNS**, **Records**, then **Add record**. Choose **DNS only**, the grey cloud. |

Companies move things around, so it may look a little different.

- **Railway:** add both records exactly as Railway shows them. For the CNAME, the name or host is `www`, and the value is what Railway gives you.
- **A server of your own:** an **A** record. The name is `www`, or `@` for the bare name, and the value is the server's IP address.

Take out any other record with the same name, such as a parking page's.

## 3. Forward the bare name

So that people who type `risebakery.com` arrive as well:

- **Squarespace:** the domain, **Website**, then **Domain forwarding**. From `@`, to `https://www.risebakery.com`.
- **GoDaddy:** the domain, **Forwarding**, then **Add forwarding**.
- **Namecheap:** in **Advanced DNS**, a **URL redirect record** with the host `@`, to `https://www.risebakery.com`.
- **Cloudflare:** it can point the bare name at a host itself. Add a CNAME with the name `@`, and add the bare name in Railway as well.
- **A server of your own:** an A record for both, and both names in the first line of the `Caddyfile`.

## 4. Wait

It usually works within the hour, and can take a day. The certificate for HTTPS comes by itself once the records are right.

## 5. Use the new address

Open the admin at the new address: `https://www.risebakery.com/admin/`. Sign in, and Overview asks whether to use it. Choose **Use this address**.

Links, the sitemap and previews on social media use it from then on. The old address still works.

## Don't lose your email

Adding records leaves email alone. **If you're asked to move your domain's nameservers,** copy its **MX** and **TXT** records across first, or email to your domain stops arriving.

## If it doesn't work

- **Railway says the domain isn't found:** the TXT record is missing, or not exactly as shown.
- **"Not secure":** the certificate isn't there yet. Wait an hour, and check that ports 80 and 443 are open on a server of your own.
- **A parking page:** an old record with the same name is still there.
- **`TEND_PUBLIC_URL` is set** on the server: it decides the address, so change it there.
