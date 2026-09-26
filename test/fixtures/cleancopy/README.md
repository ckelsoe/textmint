# CleanCopy fixtures

Copied from [kart1ka/CleanCopy](https://github.com/kart1ka/CleanCopy) at commit `6d07466`
(v1.1.0), under the MIT licence in `LICENSE` here. Each directory holds a real terminal copy
(`input.txt`) and CleanCopy's cleaned result (`expected.txt`).

`test/protection.test.js` uses the inputs, not CleanCopy's expected output, since the two
tools clean differently. It checks two things:

- Code, logs, transcripts, diffs and data that CleanCopy leaves verbatim come through
  textmint's `clean()` verbatim too, with every pass on.
- Prose that CleanCopy reflows is never classified as code by `scanProtected()`.

To refresh: copy `test/fixtures/` from a newer CleanCopy checkout, update the commit above, and
sort any new directory into a list in the test.
