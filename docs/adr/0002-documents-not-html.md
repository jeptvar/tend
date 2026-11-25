# 2. Documents are stored, and pages are made from them

**Decided:** October 2026. The renderer became Tend's own while the editor was being built.

## The question

What does the editor save?

## The decision

A document: JSON with a small list of things that may be in it, checked on every save. When it's published, Tend's own renderer turns it into HTML, and that's stored too. Links to other pages, pictures and business details stay as placeholders until a page is shown.

## Why

- Only what's on the list can reach a visitor's page. Nothing has to be found and taken out of HTML.
- Replacing a photo, moving a page or changing the hours shows everywhere at once, because nothing has them written in.
- A theme can be changed without touching what people wrote.

## What it costs

- Everything new in the editor needs a place in the list, in the renderer, and in the editor.
- An update that draws something differently draws every published page again, before anyone is answered.
