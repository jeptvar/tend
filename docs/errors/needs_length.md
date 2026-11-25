# The file's size is missing

> Tend needs to know how big a file is before it arrives.

## What happened

This is about a program using Tend's API: an upload has to say its size first.

## What to do

- Send a `Content-Length` header.
