# 3. No JavaScript for visitors

**Decided:** October 2026.

## The question

What runs in a visitor's browser?

## The decision

Nothing, on pages Tend makes. Menus open with `<details>`, dark mode follows the device with CSS, and the next page is fetched ahead with speculation rules, which are data.

## Why

- Pages are small and quick on any phone.
- Nothing can break, and nothing can watch.
- Every page is complete as it arrives, for search engines, screen readers and people whose script didn't load.

## What it costs

- No live search and no carousels. Forms, when there are any, are sent the old way.
- People can add code of their own in Settings, which is theirs to look after.
