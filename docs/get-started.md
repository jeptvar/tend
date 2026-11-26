# Get started

There are three ways to start. You can begin on your computer and [move online](move-your-site.md) later, with everything in your site.

| | You need | At the end |
|---|---|---|
| [On my computer](#on-my-computer) | Node.js, and one command to type | Your site is ready on this computer, and only you can see it. |
| [Online with Railway](#online-with-railway) | A Railway account and a card, and no commands | Your site is live, at an address from Railway. |
| [On a server of my own](#on-a-server-of-my-own) | A server, a domain, and SSH | Your site is live, at your domain. |

## On my computer

1. [Install Node.js](install-node.md), if you haven't. Tend needs version 24 or newer.
2. Open Terminal on a Mac, or Command Prompt on Windows, and type:

   ```
   npm create tend@latest my-site
   ```

   `my-site` is the folder your site goes in. Choose any name.
3. Your browser opens at the setup screen by itself. If it doesn't, open the link in the window.
4. **Start a new site**, then: name it, make your account, and pick a starting point. You can change everything later. Blog, Business and Portfolio come with pictures to swap for your own. They were drawn for Tend, so there's nobody to pay or credit.
5. Save your recovery kit. If you forget your password, a code from it gets you back in.

Keep the window open: Tend stops when you close it. To start it again:

```
cd my-site
npm start
```

On Windows, if PowerShell says that running scripts is disabled, use Command Prompt instead.

## Online with Railway

Railway runs Tend for you. [Railway](railway.md) has the steps, and [What it costs](costs.md) has the price.

## On a server of my own

For people comfortable with SSH. [A server of your own](own-server.md) has the steps, with Docker, and HTTPS set up for you.

## Next

- Choose **Edit homepage** on Overview, change something, and choose **Publish changes**.
- Overview has a short list of what's worth doing first. It ticks itself off.
- [Write and publish](writing.md)
