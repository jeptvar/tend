# 5. Signing in is written here

**Decided:** October 2026.

## The question

Use a library or a service for accounts, or write it?

## The decision

Written here: Argon2id for passwords, random tokens of which only a hash is stored, cookies that follow the site's address, limits on guessing, recovery codes instead of email, and one function that decides who can do what. A test goes through every route with every role.

## Why

- A library brings tables, settings and its own ideas about email, which P7 rules out.
- A service means an account somewhere else, and a site that can't be signed in to without it.
- What's needed is small enough to read in an afternoon.

## What it costs

- Every mistake is ours, and so are the tests that have to find it.
- Passkeys and one-time codes have to be written too, when they come.
