# Install Node.js

Tend runs on Node.js, which is free. You need it on your computer to make a site there. A site on Railway, or with Docker, brings its own.

1. Go to [nodejs.org](https://nodejs.org/en/download) and download the **LTS** version: the `.pkg` on a Mac, or the `.msi` on Windows.
2. Open what you downloaded, and choose **Continue** or **Next** until it's done. The choices it offers are fine as they are.
3. Close Terminal or Command Prompt if it's open, then open it again. It only notices Node.js when it starts.
4. Check it:

   ```
   node --version
   ```

   It should say `v24` or a higher number.

## If it says something else

- **"command not found", or "is not recognized":** close the window and open a new one. If it's still not there, restart the computer.
- **A lower number, such as `v20`:** an older Node.js is installed as well. Install the LTS version again. If you use a version manager, such as nvm or fnm, choose the new version with it.
- **On Windows, PowerShell says running scripts is disabled:** use Command Prompt instead.

## Which versions work

Tend works on every LTS version of Node.js that still gets security fixes: 24 and 26 now. `tendcms doctor` says when the one you have is about to stop getting them.
