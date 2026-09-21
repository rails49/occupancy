# The look rules' values, copied

`tokens.css` beside this file is a **verbatim copy** of
[`docs/tokens.css`](https://github.com/rails49/.github/blob/main/docs/tokens.css)
in `rails49/.github`, taken at:

    c91e9bea6680808edab65675998ab49ea6309cd3

[ADR-0005](https://github.com/rails49/.github/blob/main/docs/adr/0005-the-look-rules-travel-as-a-copied-file-not-a-package.md)
decides that nothing is installed: every consumer copies the file, records the
commit it came from, and keeps a test asserting that the values it actually
draws with equal the copy's. The recorded commit is the pin a git dependency
would have given.

**The copy is inert.** Nothing imports it, no build reads it, and it is not in
the bundle — `values.test.ts` reads it. How this UI expresses the values is its
own business (ADR-0003): they are five custom properties in `src/look.ts` and
one number in `src/layout.ts`, because a media query cannot read a custom
property.

## The test runs outside the required gate

`values.test.ts` is not in `ui/tests/`, so `pnpm test` and therefore
`bin/test.sh` do not run it. Run it by hand:

```bash
pnpm --filter @occupancy/ui test:look
```

That placement is ADR-0005's, and the reason is what a drift check is for: it
reports that this repository has fallen out of step with a decision taken
elsewhere, which is not a reason to red-light a pull request that has nothing
to do with the chrome. It never fetches, so it cannot go red on someone else's
commit in `.github` either — it fails only on a local edit.

## Taking a change

`.github` announces a change by filing an issue here; nothing is scheduled and
nothing is automated. To take one: replace `tokens.css` with the new file
verbatim, write the new commit above, run the test, and change whatever it
reports. A token that arrives with no expression here fails the first
assertion rather than being quietly ignored.
