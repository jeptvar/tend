# The key file is damaged

> The key file … is damaged, so Tend won't start.

## What happened

`secret.key` signs the devices people have signed in from and guards recovery codes. Tend never replaces a damaged one by itself, because recovery codes made with the old one would stop working.

## What to do

- Put it back from a backup: it's `secret.key` in the zip.
- With no backup, delete it and start Tend. It makes a new one. Everyone's recovery codes stop working, so each person makes a new kit in **Account**, and devices are treated as new.
