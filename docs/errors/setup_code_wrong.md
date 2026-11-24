# Setup code not accepted

> That setup code doesn't match.

## What happened

Setting up a new site needs the code Tend shows where it runs, so that nobody who finds the address first can take the site.

## What to do

- Copy the code from the window Tend runs in, or from your host's logs.
- With Docker: `docker exec tend tendcms setup-code`. With npm: `npx tendcms setup-code` in your site's folder.
- On Railway, it's the setup password you chose in the template.
