# Locked out

If you can't sign in, there are three ways back in. None of them needs email.

## Use a recovery code

When you set up your account, Tend gave you a recovery kit with 8 codes.

1. Open your site's address followed by `/recover`, or choose **Forgot password?** where you sign in.
2. Type your email and one of the codes.
3. Choose a new password.

You're signed in, and everyone who was signed in as you isn't any more. Each code works once. **Account** says how many are left, and makes a new kit, which ends the old one.

## Ask someone

The Owner can send anyone a link to choose a new password, from **People**. Admins can for Editors and Writers. It works once, for a day.

## Ask whoever looks after the server

They can make you a new password there. In your site's folder, if it was made with npm:

```
npx tendcms reset-password you@example.com
```

On the server, if it's in Docker:

```
docker compose exec tend tendcms reset-password you@example.com
```

It prints the new password, and signs you out everywhere. With an email nobody uses, it lists the ones there are.

## "Too many tries"

After several wrong passwords, Tend makes a device it doesn't know wait, from a minute up to an hour. Devices you've signed in from before aren't held up, so someone else's guessing can't keep you out. A new password, however you got it, ends the waiting.

## The Owner, with nothing left

With no codes, nobody to ask, and Tend on a host where you can't run a command, restore a backup into a new Tend where you can, such as your computer: the accounts come with it. Run `tendcms reset-password` there, download a new backup, and [move it back](move-your-site.md).
