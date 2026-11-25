# The command line

In your site's folder, if it was made with npm, as `npx tendcms <command>`. In Docker, as `docker compose exec tend tendcms <command>`.

| Command | What it does | While Tend runs |
|---|---|---|
| `start [--open]` | Starts Tend. With `--open` it opens the admin in your browser. `npm start` does this. | |
| `backup [file]` | Saves the whole site to a zip file. Keep it private. | yes |
| `restore <file>` | Puts the site back as it is in a backup, or in a copy Tend kept. The site that was here is saved first. | no: stop it |
| `doctor` | Checks what Tend needs to run here, and says how to fix what's wrong. It changes nothing. | yes |
| `setup-code` | Shows the code that setup asks for. | yes |
| `reset-password <email>` | Gives an account a new password, and signs it out everywhere. | yes |
| `theme copy <from> <to>` | Starts a [theme of your own](themes.md) from a copy of another. Tend comes with `meadow`. | yes |

`--help` lists them, and `--version` says which Tend it is.

`doctor` ends with a failure if there's something to fix, so a script can use it.

## npm create tend

```
npm create tend@latest my-site
```

Makes a folder with your site in it, installs Tend, starts it and opens the browser. `npm create tend@latest my-site -- --no-start` doesn't start it.

It never changes a folder that has something in it.
