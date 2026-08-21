# Profiles

Everyone reading from the same library keeps their own place in each book.

Everyone reading from the same library keeps their own place in each book. A
library that has never been configured has one profile, called Reader, and no
profile file at all — the default is implicit until something is actually
changed, so a fresh install writes nothing it might never need.

The shelf header holds the switcher: who is reading, everyone else in one
click, and a field to add someone. Creating a profile starts reading as it,
wherever it was created from — the alternative leaves the shelf showing another
person's positions with nothing to say why. `/profiles` is for renaming and
deleting, which are rarer and want more room.

It is a `<details>` element, so switching and creating are ordinary form posts
and work with scripting off; the client half only adds closing on Escape or on
a click elsewhere. The cookie is set per request rather than per build, because
a `Secure` cookie decided by NODE_ENV is one a browser silently discards over
plain HTTP — which is exactly how a box on your own network is reached.

Profiles are not accounts. A cookie names one; it does not prove anything about
who is holding it, and anyone who can reach the library can read as any profile
in it. That is the right amount of ceremony for a shelf shared with the people
you live with, and the wrong amount for one on the open internet — see
[Not done yet](../README.md#not-done-yet).

Positions are written to the browser first and to the library after a pause,
which is what keeps page turns off the network: a chapter's worth of turns
collapses into one write, and leaving the page flushes what is outstanding
through `sendBeacon`. Both copies carry a timestamp and the newest wins, so
picking a book up on a phone resumes where the laptop left off, and a reader
that was offline does not lose its place to a stale copy.

Storage the app cannot write to is not an error. `writableStorage()` returns
null, the profiles page says so, and reading positions stay in the browser
exactly as they did before any of this existed.

This costs one read of the profile's positions per shelf render, on top of the
cached catalog. It is not cached, because a position saved a moment ago should
show as *Continue* immediately.
