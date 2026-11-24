# Security

## Report a problem

Tell us privately, through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Only the maintainers see it.

Please say what you did, what happened, and which version. A way to make it happen again helps most. Try it on a site of your own, never on someone else's.

Tend is made by very few people, so an answer can take some days. Once the problem is understood, we'll agree with you on when to say what. You'll be credited unless you'd rather not be. There's no reward for reports.

## Which versions get fixes

| Version | |
|---|---|
| The newest 0.x | yes |
| The one before it | yes |
| Older | no: [update](docs/updates.md) |

Nothing is released yet. Until it is, only the newest commit counts.

## What counts

Anything that lets someone do what they shouldn't: read or change a site without signing in, do more than their role lets them, run code on the server, or get at what's in someone else's browser.

What doesn't:

- An Admin putting a script on their own site. **Add code to every page** is meant to.
- Someone with the server, the data folder or a backup reading what's in it.
- A site whose `TEND_TRUST_PROXY` doesn't match [its proxies](docs/proxies.md).

## How Tend is kept safe

[Privacy](docs/privacy.md) says what's kept and how. [PLAN.md](PLAN.md), section 12, has the rest: how signing in, uploads, themes, backups and updates are protected, and what's tested on every change.
