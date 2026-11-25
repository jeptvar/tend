# The backup couldn't be restored

> Tend couldn't restore that backup.

## What happened

Something stopped the restore after it was checked, often a full disk. What was there before is put back.

After an update, this can also say that the update was applied, that a check after it failed, and that Tend couldn't undo it. The message then names the copy saved before the update.

## What to do

- Look at what Tend printed where it runs, or in your host's logs. It names the reason.
- Make room on the disk, then try again.
- After an update: stop Tend, put the named copy back, and start the version you had before. See [Back up and restore](../backups.md#restore-a-copy-by-hand).
