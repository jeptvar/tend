# Changelog

What changed in each version of Tend, for the people who run it. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): before 1.0, a new minor version can need something from you, which is said here.

## [Unreleased]

The first version, a developer preview.

### Added

- **Install:** `npm create tend@latest my-site` on your computer, a Docker image for a server of your own, and a template for Railway. Nothing has to be set up first.
- **Setup** in the browser: a name, an account and a starting point (Blog, Business, Portfolio or Blank, all but Blank with pictures), or a backup of another site.
- **The admin** works on a computer, a tablet and a phone, in light and dark. Overview starts with a picture of your site and what isn't on it yet.
- **Writing:** an editor for posts and pages in your site's own fonts and colour, with pictures, links, lists, tables, quotes, code, buttons and three kinds of section (Big intro, Picture and text, Contact & hours). It saves by itself, on the server and on your device, and works through a lost connection.
- **Publishing:** a review before anything goes on your site, with the address, how it looks when shared, and what may be worth another look. Later changes stay off the site until you publish them.
- **Getting things back:** earlier versions of every post and page, a Trash that keeps things for 30 days, and Undo for what can be taken back.
- **Media:** photos made ready for every screen size, with their camera details and location removed, and PDFs. JPG, PNG, WebP, GIF and AVIF. A photo too big for Tend is made smaller as it's added, and Safari makes HEIC photos JPEGs. Each picture can say what stays in sight where it's cropped.
- **Design:** the Meadow theme, with a logo, a site icon, an accent colour that makes the whole palette and is checked for contrast, three pairs of fonts (two of them its own), a header style, footer text, social links and CSS of your own. Your site is beside the form as you change it. Photos behind words, readable on any photo. `tendcms theme copy` starts a theme of your own.
- **Site menu**, redirects (by themselves when an address changes), who can see the site (everyone, nobody yet, or only people who can sign in), search and sharing details, `sitemap.xml`, `rss.xml` and `robots.txt`.
- **Visitor stats** from Plausible, Fathom, Umami or Cloudflare Web Analytics, which count without cookies, by pasting what the service gives your site.
- **Business details:** the address, phone, hours and map link, changed in one place and shown everywhere.
- **People:** Admins and Editors, invited with a link. Recovery codes get you back in without email.
- **Backups:** the whole site as one file, a copy of the data every day, and a check on how full the disk is. A backup starts a new site anywhere, and the Owner can put the site back as it was from Settings → Backups.
- **The command line:** `tendcms start`, `backup`, `restore`, `doctor`, `setup-code`, `reset-password` and `theme copy`.
- Public pages have no JavaScript, and neither they nor the admin ask anything of anyone else's server.
