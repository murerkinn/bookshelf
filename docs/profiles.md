# Profiles

Profiles let everyone sharing a library keep their own place in each book.

## Using them

Your shelf starts with one profile, called Reader. You don't have to do
anything with profiles if you're the only one using the library.

**To switch or add someone**, use the switcher in the shelf header. It shows who
is reading now, everyone else one click away, and a field to add a new person.
Adding someone switches you to them straight away.

**To rename or delete a profile**, go to `/profiles`.

Deleting a profile removes its reading positions. Everything else — your books,
your covers, your catalog — is untouched.

## What each profile keeps

Each profile has its own reading position in every book. That's the whole of it.

Layout, zoom and page tint are remembered per device instead, because they're
properties of the screen you're reading on rather than of you. Switch profiles
on the same laptop and the reader looks the same; open the same profile on a
phone and it doesn't.

## Reading on more than one device

Pick a book up on your phone and it resumes where your laptop left off. Both
copies carry a timestamp and the newest one wins, so a device that was offline
for a while won't overwrite a place you set somewhere else.

Two devices reading the same profile at the same time is last-write-wins. If you
read the same book on two screens at once, one of them will win and the other's
place is lost.

## Profiles are not accounts

**Anyone who can reach your library can read as any profile in it.** There's no
password and nothing to log in to. The cookie names a profile; it doesn't prove
anything about who's holding it.

Profiles are for keeping housemates' bookmarks apart. They are not a way to keep
anyone out. If your shelf is somewhere strangers can reach it, put it behind
something that asks who's calling — see [what's missing](roadmap.md).

## On a read-only library

If the app can't write to your library — a read-only instance, or storage that
declines writes — profiles can't be added, renamed or deleted, and the profiles
page tells you so. Switching between profiles that already exist still works.

Your reading positions keep working too. They stay in your browser instead of
being saved to the library, which is how the app behaved before profiles
existed.
