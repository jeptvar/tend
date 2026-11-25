# Themes

For developers. A theme is a folder of [Liquid](https://shopify.github.io/liquid/) templates, a stylesheet, and a `theme.json`. It decides how the site looks, and which choices **Design** offers. It can't run code on the server.

Tend comes with one, **Meadow**. Start yours from a copy:

```
npx tendcms theme copy meadow my-theme
```

Choose it in **Design**. Then change its files: on your computer, the next reload shows it. Online, Tend notices changed files by itself.

## Where themes go

| Where Tend runs | Folder |
|---|---|
| npm | `themes/my-theme` in the site's folder |
| Docker | `/data/themes/my-theme`, on the volume |
| An image of your own | `/opt/tend/themes/my-theme` |

On Railway, deploy from a repository of your own with this Dockerfile:

```
FROM ghcr.io/tendcms/tend:0
COPY themes /opt/tend/themes
```

A plain deploy of the Railway template can't have one yet.

Themes aren't in backups. Keep yours in a repository.

## What's in one

```
my-theme/
  theme.json     its name, and what Design offers
  templates/     layout, home, page, post, blog, tag, 404 and coming-soon, each .liquid
  partials/      pieces that templates share
  assets/        theme.css, pictures, fonts
  locales/       words, one file for each language
```

**A file you don't have comes from Meadow.** Delete what you don't change, and you get later versions of it with each update. Asset files fall back the same way.

A mistake in a theme never takes a site down: visitors get that page with Meadow, and **Design** says what's wrong. On your computer, you see the mistake instead of the page.

## theme.json

```json
{
  "name": "My theme",
  "version": "1.0.0",
  "tend": ">=0.1 <2",
  "settings": [
    {
      "id": "accent",
      "type": "color",
      "label": "Accent colour",
      "default": "#1f6f4a",
      "contrastAgainst": ["#ffffff"]
    },
    {
      "id": "fonts",
      "type": "select",
      "label": "Fonts",
      "default": "clean",
      "options": [
        { "value": "clean", "label": "Clean", "hint": "Plain and easy to read." },
        { "value": "classic", "label": "Classic" }
      ]
    }
  ]
}
```

- `tend` says which versions of Tend it's for. With another, it still draws, and Design says so.
- Each setting is a field in Design. `type` is `color` or `select`. `hint` is a line of help.
- `contrastAgainst` is the backgrounds that words in this colour go on. Design warns about a colour that's hard to read there.
- A choice is `design.fonts` in templates, and `--tend-fonts` in CSS when it isn't the default. An underscore in an `id` is a dash in CSS.
- Meadow gives `contrastAgainst` two backgrounds and makes all its other colours from the accent, so a colour that's readable on those two makes a palette that is.

## What templates get

Everywhere, in partials too:

| | |
|---|---|
| `site` | `name`, `tagline`, `url`, `locale`, `logo`, `icon`, `footer_text`, `social` (each with `network`, `name`, `url`), `business`, `has_posts` |
| `site.business` | `address_lines`, `phone`, `phone_href`, `email`, `email_href`, `map_url`, `hours`, `hours_summary`, `hours_note`, `has_any` |
| `design` | What was chosen for each setting. `accent_dark` is a changed accent for dark mode. |
| `menus` | `menus.main` and `menus.footer`: each link has `title`, `url` and `children` |
| `request.path` | The page's address |

And each template its own:

| Template | |
|---|---|
| `home` | `page`, if there's a homepage, or else `posts` and `pagination` |
| `page`, `post` | `page` or `post`: `title`, `html`, `summary`, `url`, `published_at`, `updated_at`, `image`, `tags` (each with `name`, `url`), `seo` |
| `blog`, `tag` | `posts` and `pagination` (`page`, `page_count`, `newer_url`, `older_url`). `tag` has `name`, `url` and `description`. |

`html` is the only thing that's safe to write as it is: `{{ post.html | raw }}`. Everything else is escaped for you.

On pages, use Meadow's `page-text` partial, which fills in Contact & hours: `{% render "page-text", html: page.html, business: site.business %}`.

## Tags

| | |
|---|---|
| `{% seo %}` | In `<head>`: the title, description, canonical link, sharing details, icons, structured data, Design's CSS, and code added in Settings. Every page needs it. |
| `{% body_end %}` | Before `</body>`: code added in Settings |
| `{% menu "main" %}`, `{% menu "footer" %}` | A menu, drawn with the `menu` partial |
| `{% image post.image, size: "card" %}` | A picture, in the size each screen needs, with its dimensions and its description |

`{% image %}` takes `size` (`normal`, `half`, `wide`, `full`, `card`, `cover` or `logo`), `sizes` for a layout of your own, `alt`, `decorative: true` beside words that say it all, and `priority: true` for the one to fetch first. The first picture on a page is fetched first by itself. The sizes are Meadow's: if your layout is another, pass `sizes`, or phones get bigger files than they need.

Templates share a layout with `{% layout "layout" %}` and `{% block content %}`.

## Filters

| | |
|---|---|
| `{{ "theme.css" \| asset_url }}` | An asset's address, which changes with its contents |
| `{{ post.published_at \| date: "long" }}` | A date in the site's language and time zone: `short`, `medium`, `long` or `full` |
| `{{ post.published_at \| iso_date }}` | The same for `<time datetime>` |
| `{{ post.image \| img_url: 960 }}` | A picture's address, at least that wide |
| `{{ post.image \| srcset }}` | All its sizes |
| `{{ "call" \| t: phone: site.business.phone }}` | The theme's words, in the site's language |

And [Liquid's own](https://liquidjs.com/filters/overview.html).

## Words

`locales/en.json` has the theme's words, and other languages theirs: `locales/pt-BR.json`. Tend looks in the site's language, then the same language elsewhere, then English, and then in Meadow. `{phone}` in a word's text is a value given to `t`.

## Fonts

Put them in `assets/fonts`, and their `@font-face` in `partials/fonts.liquid`, which Meadow's layout writes into every page as CSS. Each address goes through `asset_url`, so a browser keeps the file for good:

```liquid
{%- if design.fonts == "classic" -%}
@font-face {
  font-family: "My font";
  font-display: swap;
  src: url("{{ "fonts/my-font.woff2" | asset_url }}") format("woff2");
}
:root { --tend-font-heading: "My font", Georgia, serif; }
{%- endif -%}
```

The admin uses the same CSS where people write, so a title there looks as it will on the site. Meadow's are **Fraunces** (Classic) and **Nunito** (Friendly), both under the SIL Open Font License. Keep a font's licence beside it.

## Sections

What people put on pages has stable classes to style: `.t-intro`, `.t-picture-text` and `.t-contact`, with the background (`.t-tone-none`, `.t-tone-muted`, `.t-tone-accent`) and the alignment as classes on them, and the layout as `data-preset`. Meadow's `theme.css` shows them all.

A Big intro's first picture is the photo it opens with. Meadow puts it beside the words in layout 1, and behind them in layout 2, under a veil of one colour thick enough to read the words on any photo.

## Limits

A page has half a second and 100 MB to be drawn in, and a template 1 MB to be. One that takes longer is tried once more, with two seconds, in case the computer was busy. Templates are read from the theme's own folder only.

## Make it good

- Keep one `<h1>`, and a skip link to the content, as Meadow's layout has.
- Check it with a keyboard, at 320 px wide, and in dark mode.
- Pages have no JavaScript. Yours doesn't need any either.
- Words on a photo have to be readable on an all-white one and an all-black one.
