# Not the address this page is open at

> That isn't the address this page is open at.

## What happened

A site's address can only be chosen from the address itself, so that it's sure to lead there. Behind a proxy that changes the Host header, Tend can't tell.

## What to do

- Open the admin at the address you want, and choose it there.
- Behind a proxy, set `TEND_PUBLIC_URL` instead: see [Behind a proxy](../proxies.md).
