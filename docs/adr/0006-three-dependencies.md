# 6. Three packages to install

**Decided:** October 2026.

## The question

What does `npm install tendcms` bring?

## The decision

better-sqlite3, sharp and @node-rs/argon2: machine code that can't be bundled, pinned exactly, with no install scripts. Everything else is bundled when Tend is built. A shrinkwrap pins what those three need.

## Why

- Every package is someone who could be taken over, and a version that could break on someone's computer months later.
- Installs are the same tree that was tested, and work where install scripts are blocked.
- It's about ten packages in all.

## What it costs

- Machine code has to exist for a computer. Where the one for pictures doesn't, Tend runs without it.
- Bundled code's licences have to be published with it, which the build does, or stops.
