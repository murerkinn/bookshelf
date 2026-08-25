# Security

## Reporting a vulnerability

Please don't open a public issue for anything exploitable. Use [private
vulnerability reporting][report] on this repository — it opens a private
thread with the maintainer, and a fix can be prepared before anything is
public.

[report]: https://github.com/murerkinn/bookshelf/security/advisories/new

Useful in a report: what an attacker gets, and the shortest path to seeing it
happen. A key that escapes the library, a way to reach one profile's reading
positions from another, a request that makes the Worker serve bytes from
outside the configured bucket — those are the shapes worth writing up.

This is a side project with one maintainer, so treat any timeline as best
effort. You will get an acknowledgement; you may not get it the same day.

## Supported versions

There are no releases yet. `main` is the only version that gets fixes, and
self-hosted instances need to pull and redeploy to receive one.

## Not vulnerabilities

**The app has no authentication.** Anyone with the URL can read and download
the whole library, and pick any profile while doing it. That is deliberate and
documented in [Not done yet](README.md#not-done-yet). Profiles keep housemates'
bookmarks apart; they are not an access control boundary. A report that amounts
to "an unauthenticated user can read the books" describes the design.

**Whatever you put in a library is served.** The sync tool publishes what it is
pointed at. Deciding what belongs in a public bucket is the operator's call.

**A library is stored in the clear.** Books, covers and the catalog are
published as they are, and the object keys are slugified titles — so whoever
holds the storage can read the shelf, and so can anything able to list the
bucket. That is the design today, not an oversight: see
[roadmap #18](docs/roadmap.md) for what changing it would take, and
[the filesystem provider](docs/providers/fs.md#encrypting-the-directory) for
encrypting a library at rest without waiting for it.
