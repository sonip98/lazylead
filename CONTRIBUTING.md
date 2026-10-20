# Contributing to LazyLead

Small, focused pull requests are easiest to review.

## Run it locally

```bash
node --version        # 20 or newer
npm test              # offline, no GitHub or Ollama needed
node bin/lazylead.js --config lazylead.config.json --from-snapshot test/fixtures/snapshot.json
```

`--from-snapshot` rebuilds a brief from saved data, so you can work on the output without a token and without a model.

## Ground rules

- **Facts come from code, words come from the model.** Counts, wait times and who-owes-what belong in `src/facts.js`. The model may only phrase things and read threads (`src/brief.js`).
- **LazyLead never writes to GitHub.** No comments, merges or label changes.
- **Every model call needs a fallback**, so a brief always ships.
- Add a test for each bug you fix. Tests use `test/fixtures/snapshot.json` and a fake model.

## Pull requests

Describe what you saw (a real brief, a log line) and what changed. If the model's output was wrong, paste what it wrote.
