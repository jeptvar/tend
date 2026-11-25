# 4. Themes are Liquid, and can't run code

**Decided:** October 2026.

## The question

What's a theme made of?

## The decision

Liquid templates, a stylesheet and a `theme.json`, drawn by LiquidJS with limits on time, memory and size, and only the theme's own folder to read from. What's written is escaped unless a template says otherwise, and the only thing meant for that is HTML Tend made.

## Why

- A theme from anyone can't read files, reach the network, or take the server with it.
- Liquid is known from Shopify and Jekyll, and fits on one page.
- A mistake in one file falls back to Meadow's, so a site is never down because of its theme.

## What it costs

- What a theme can do is what Tend gives it. Something new needs a new filter or tag.
- There are no components, and no build step to bring any.
