# Privacy

## Visitors

A site made with Tend, as it comes:

- **Sets no cookies** for visitors, and stores nothing in their browser.
- **Has no JavaScript**, and no fonts, pictures or anything else from another company's server.
- **Doesn't count or record visits.** Tend keeps no log of who visits. Your host, or a proxy in front, may keep one of its own.

That changes with what you add: code in **Settings**, then **Advanced**, or a page that links to something elsewhere. A visitor counter needs whatever notice your visitors' laws ask for.

## Photos

What a camera writes in a photo, such as where and when it was taken, is removed as it's uploaded. A photo's original is kept without it.

## People who sign in

Tend keeps, on your server only:

| | For how long |
|---|---|
| Name, email, role, and a hash of their password | Until they're removed |
| Each place they're signed in: when, the browser's name for itself, and part of the address (the first three numbers of an IPv4 address, or the first half of an IPv6 one) | Until it ends: two weeks without use, or 60 days |
| Invitations, links for a new password, and recovery codes, as hashes | 30 days after they can't be used |
| Who wrote, changed and published what | With what it's about |

Two cookies are set when someone signs in: one that keeps them signed in, and one, kept for a year, that says they've signed in on this device before, so that someone else's guessing at their password doesn't hold them up. The admin also keeps unsaved writing in the browser until it's on the server, and small choices such as light or dark.

Passwords are hashed with Argon2id. Recovery codes and links are only ever stored as hashes, so a copy of the database doesn't give them away.

## Nothing is sent to anyone

Tend has no telemetry and doesn't check for updates in this version. The admin asks nothing of any other server. This is tested on every change: the admin and the site are used with every other address blocked.

## Backups

A backup holds all of it: every account's email and password hash, and the key that guards recovery codes. Keep it private. Only the Owner can download one.

## When someone leaves

**People**, then **Remove**. Their account, their sign-ins and their links go at once. Copies and backups from before still have them, until those go.
