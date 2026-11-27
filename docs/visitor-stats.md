# Visitor stats

Tend can add a service that counts your visitors to every page. Each one here counts without cookies, so your site doesn't need a banner asking visitors about them first.

**Settings**, then **Visitor stats**. Choose the service, paste what it gives your site, and save. Its script loads without holding your pages up. Previews in the admin aren't counted.

| Service | What to paste | Where to find it |
|---|---|---|
| Plausible | The domain you added to Plausible, like `rise-bakery.com` | Your sites in Plausible |
| Fathom | The Site ID, like `ABCDEFGH` | Your site's settings in Fathom, under Embed code |
| Umami | The website ID | The website's settings in Umami, under Tracking code |
| Cloudflare Web Analytics | The token: 32 letters and numbers | Web Analytics in Cloudflare, under Manage site, in the snippet |

You can paste the whole snippet the service gives you instead. Tend takes what it needs from it.

**Umami on a server of your own:** paste its script's address too, such as `https://stats.rise-bakery.com/script.js`. Leave it empty for Umami Cloud.

**Plausible** now gives each site a snippet with `pa-` in its name. Tend uses the domain instead, in the form Plausible's own docs still describe. To use the newer snippet, paste it in **Settings**, then **Advanced**, under **Add code to every page**.

## Why there's no Google Analytics

Google Analytics stores cookies in your visitors' browsers. In the EU, the UK and other places, the law asks you to get visitors' agreement before a cookie like that is stored, which means a banner on every page and keeping track of who agreed. Tend doesn't make that banner. The services here count visits without cookies, so you don't need one.

## Another service

Paste its code in **Settings**, then **Advanced**, under **Add code to every page**. Only paste code from a company you trust: it can do anything on your site. Find out whether it uses cookies first, because if it does, your visitors' laws may ask for a banner.

## Good to know

- Ad blockers stop some visitors being counted, whichever service it is.
- What the service keeps about your visitors is between you and it: see its own privacy page. What Tend keeps is in [Privacy](privacy.md).
