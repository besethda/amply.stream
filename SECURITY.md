# Security

Amply asks artists for one-time access to their Cloudflare account, runs code
inside it, and moves listeners' money. A flaw in any of that matters, so
reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue.** Use GitHub's private reporting instead:
the **Security** tab of this repository → **Report a vulnerability**. Only the
maintainer sees it.

Include what you can: the affected part (`node/`, `manage/`, `relay/`,
`site/`, `app/` or the spec), how to reproduce it, and what an attacker gains.
A rough report is better than none.

You should hear back within a week. Once a fix ships, you're credited in the
release notes unless you'd rather not be.

## What's in scope

Anything that breaks one of the properties the README promises, for example:

- Amply keeping, or being able to regain, access to an artist's account after setup
- the relay being usable as a general proxy, or storing or logging anything
- writing to a node without passing Cloudflare Access
- a manifest, page or audio file making a client run script, overcharge, or pay the wrong address
- the listener app leaking or spending a wallet's key other than as the listener approved
- a node serving a paid track to a wallet that hasn't identified itself

## Fixes reach artists slowly

Every artist runs their own copy of the node, and nobody but the artist can
update it. The editor tells an artist when their node is out of date (see
`site/node-version.json`), but a fix only protects them once they apply it.
Please allow for that before disclosing publicly.
