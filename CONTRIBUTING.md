# Contributing

Thanks for looking. Issues, questions and pull requests are all welcome.

## Getting set up

You need Node 22 or later. Each part of the repo has its own dependencies:

```
npm ci --prefix node
npm ci --prefix manage
npm ci --prefix app
npm ci --prefix relay
```

Then:

```
npm run check
```

That builds everything, validates the spec, runs every test and typechecks
both Workers. CI runs the same command on every push and pull request.

## Before opening a pull request

- **Run `npm run check`.** It must pass.
- **Commit the rebuilt files in `site/`.** `site/node-worker.js`,
  `site/node-manage.html` and the app under `site/app/` are compiled from
  `node/`, `manage/` and `app/`. If you change those sources, `npm run build`
  updates the compiled copies, and they belong in the same commit. CI fails
  if they're out of date. [BUILD.md](BUILD.md) explains why this matters.
- **Don't add state to Amply itself.** The relay has no storage bindings and
  logs nothing; the site keeps no accounts. A change that makes Amply hold a
  credential, a database or a copy of anything is a change to what the
  project is, so open an issue to discuss it first.
- **Changing the manifest?** Update [`spec/README.md`](spec/README.md), the
  validator and `spec/example.json` together. Unknown fields must stay
  ignorable, so older clients keep working.
- **Keep the comments' habit.** Code here explains *why* it is the way it is.
  Please do the same for anything that isn't obvious.

## Security issues

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contribution is licensed under the
[Apache 2.0](LICENSE) licence, like the rest of the project. The name "Amply"
and the logo are not licensed; see [NOTICE](NOTICE).
