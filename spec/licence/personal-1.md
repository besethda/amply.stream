# Amply Personal Listening Licence 1.0

**Identifier:** `amply-personal-1`

This is a licence **an artist grants**, covering their own recordings. Amply is not a party
to it, cannot enforce it, and gains nothing under it. It is published here for the same
reason Creative Commons publishes licence texts: so that a short, shared, unambiguous set of
terms exists and each artist does not have to write their own.

---

## What the artist permits

**Listening.** Anyone may stream or download these recordings to listen to them personally,
using any software they choose. No payment is required to listen.

**Using any player.** Any client may fetch this manifest and play these recordings for the
person operating it. Clients that meter listening are expected to honour the rate and
payment destination declared in the manifest, and to send payment to the artist — but a
client that does not meter is still permitted to play, for personal listening.

**Linking and sharing.** Anyone may link to, share, embed or quote the address of this
manifest or of any page the artist publishes.

## What the artist does not permit

The following require the artist's separate, express permission. Without it, they are
infringements of the artist's copyright in the sound recording:

1. **Redistributing the recordings.** Hosting, mirroring or serving copies to other people.
2. **Including them in a catalogue, library, directory or index** presented to other people,
   whether or not the audio is served from the artist's own infrastructure.
3. **Operating a service** that provides access to these recordings for others — including
   any service supported by advertising, subscription or any other revenue.
4. **Transmitting them to the public** by any means, including broadcast, public performance
   and inclusion in a stream reaching more than the operator of the client.
5. **Training machine learning models** on the recordings.

## Why item 2 is worded that way

A service can present an artist's work to the public while the bytes still come from the
artist's own server. That is still building an audience on someone else's recordings without
permission, and it still imposes the running costs on the artist. Whether the audio passes
through the operator's infrastructure makes no difference to what is being done.

## No warranty, and no agency

The artist provides these recordings as-is. Amply publishes this text and nothing more: it
does not host the recordings, does not enforce these terms, has no standing to enforce them,
and receives nothing under them. Only the artist can act on a breach.

## Scope

This licence covers the **sound recordings** listed in the manifest that references it. It
says nothing about the underlying musical works, which may be administered separately — for
example by a performing rights organisation the artist belongs to.

## Using it

Reference it from a manifest:

```json
"licence": { "type": "amply-personal-1" }
```

An artist who wants different terms should publish their own and point to them instead,
with `"type": "custom"` and the address of their terms in `"url"`.
