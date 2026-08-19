@AGENTS.md


## Writing commit messages

Follow the seven rules from <https://chris.beams.io/git-commit>:

1. Separate subject from body with a blank line.
2. Limit the subject line to ~50 characters.
3. Capitalize the subject line.
4. Do not end the subject line with a period.
5. Use the imperative mood — the subject should complete "If applied, this commit will ___" (write `Add reading dispatcher`, not `Added` / `Adds` / `Fixed`).
6. Wrap the body at 72 characters.
7. Use the body to explain **what and why**, not how — the diff already shows how. Add a body only when the change needs context (motivation, side effects, trade-offs); skip it for trivial changes.

**Do not add any AI/tool attribution to commits.** No `Co-Authored-By` trailer, no "Generated with Claude Code", no signatures or emoji trailers. Write the message as the developer would.

Example:

```
Create bookshelf UI
```
