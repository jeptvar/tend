# 1. SQLite, in one process

**Decided:** October 2026.

## The question

Where does a site's data live, for someone who doesn't want to look after a database?

## The decision

In one SQLite file, in the data folder, read and written by one Node.js process. An operating system lock keeps a second one out.

## Why

- Nothing to install, set up or connect to. The folder is the site, and copying it moves it (P1).
- Reading is a function call, so a page takes a few milliseconds to make and kept ones less than one.
- A backup is a file that was consistent at one moment, made while the site runs.

## What it costs

- One server, so no second one to share the load or take over. A small site doesn't need either.
- It needs a disk that stays, so Vercel and the like are out.
- Network drives are out: their file locks aren't reliable.
