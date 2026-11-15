# Contributing to Scribe

## Issues

Issues are welcome. Bug reports, questions and ideas all help. For a bug, say what you ran, what you expected and what happened, and include your Node version, your operating system and, if you can share it, the Target repo.

## Pull requests

Pull requests are by arrangement. Please open an issue first and agree the change there before writing code, so that no work is wasted on a change that won't be merged. Unsolicited pull requests may be closed.

## Working on Scribe

You need Node 24 or later and git.

```sh
npm ci
npm run check
```

`npm run check` is the bar every change must clear: it typechecks, builds, runs the tests, and checks that no recorded response is left unused. A change is done when it passes.

## Tests need no Claude key

The tests never call Claude. Every test that needs Claude's answer replays a response recorded earlier, kept under `src/test/cassettes/`. You don't need an `ANTHROPIC_API_KEY` to run them, and running them costs nothing.

## Recordings

Recordings are made only by the maintainer, live against Claude, with `npm run record -- <cassette>`. They are never written or edited by hand: each recording carries the id of the Claude message it came from, and the tests check that it does. If your change alters what Scribe asks Claude, say so in its issue, and the maintainer will record the new responses.
