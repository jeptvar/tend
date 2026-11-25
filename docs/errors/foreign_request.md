# The request came from another website

> That request came from another website.

## What happened

Tend only takes changes from its own pages. Behind a proxy, this can also mean that Tend doesn't know the address it's reached at.

## What to do

- Open the admin at your site's own address and try again.
- Behind a proxy, set `TEND_PUBLIC_URL` to the address visitors use, for example `https://example.com`: see [Behind a proxy](../proxies.md).
