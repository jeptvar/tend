# 7. Every migration in one transaction, after a copy

**Decided:** October 2026.

## The question

How does an update change people's data without someone there to fix it?

## The decision

Tend's own runner, not the library's. At start, if anything is pending: a copy of the database, then every pending migration in one transaction with foreign keys checked by hand, then everything else. Any failure leaves things as they were, and Tend stops with a reason.

## Why

- A half-applied update is the one thing an owner can't get out of by themselves.
- The library's runner turns foreign keys off inside a transaction, where SQLite ignores that, so rebuilding a table would delete what belongs to it.
- A host then shows a failed start, rather than a broken site.

## What it costs

- Migrations are generated, then cleaned and read. A check fails on any `PRAGMA` in one.
- An older Tend won't open newer data: going back means the copy from before.
