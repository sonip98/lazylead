# 🦥 LazyLead

**A morning brief for engineering managers, written overnight by a local Gemma. No GitHub tab needed.**

A manager wants to know how the team is doing, but opening GitHub and reading through PRs every morning takes time they don't have, and most days nothing is wrong. So they usually look only when something has already gone wrong. LazyLead reads the team's GitHub every night on your own machine, writes one page, and (optionally) pushes to the manager's phone only when a review is overdue, a PR has no reviewer, or a question is still unanswered. Quiet nights stay quiet.

The page has:

- **TL;DR** – the most urgent thing first, then the counts
- **Needs someone** – per person: reviews waiting on you, questions asked of you, your PRs that are approved or need changes
- **Yesterday** – merged, opened, closed
- **Discussions** – one line per active PR thread
- **Stuck & review load** – PRs with no reviewer, who has too many reviews
- **Nudge drafts** – a friendly reminder for every overdue review, ready to copy

It only reads GitHub. It never comments, merges or changes anything.

## What a morning looks like

From the first real run on this repo:

```
### @sonip98
- Review lazylead#1 Per-person briefs — requested just now
- Review lazylead#2 Facts-only brief when the model is down — requested just now

### @piyushsoni-wq
- Reply on lazylead#1 Per-person briefs: Should the per-person file list the author's own stuck PRs?
```

Nobody told LazyLead that the question was for @piyushsoni-wq. Gemma read the thread and worked it out; code then checked that @piyushsoni-wq is really in the thread.

## Facts from code, words from Gemma

The model never counts. Counts, wait times, who was asked to review, @mentions and bot noise are computed in plain code from the GitHub API. Gemma only does what a model is good at:

1. **Map**: summarize each active PR thread and find questions still waiting for a reply (JSON output, only people in the thread are allowed).
2. **Nudge**: write a polite reminder for each overdue review.
3. **Reduce**: write the TL;DR. Every number in it is checked against the facts; if Gemma invents one, the TL;DR is replaced by a plain one built from the facts.

```
GitHub API ──► collect (code) ──► facts (code) ──┬─► Gemma: thread summaries + asks
                                                 ├─► Gemma: nudge drafts
                                                 └─► Gemma: TL;DR ──► number check
                                                                         │
                                       briefs/YYYY-MM-DD.{md,html,json} ◄┘
```

## Run it

Requirements: Node 20+, [Ollama](https://ollama.com), a GitHub token with read access to your repos.

```bash
ollama pull gemma4:e4b-it-qat
cp lazylead.config.example.json lazylead.config.json   # set repos, lead, team, tokenFile
node bin/lazylead.js
open briefs/latest.html
```

Useful flags:

- `--save-snapshot file.json` keeps the raw GitHub data
- `--from-snapshot file.json` rebuilds a brief offline from saved data (no network at all)
- `--facts-only` prints the computed facts without calling the model

Token: put it in the file named by `tokenFile` (or set `GITHUB_TOKEN`). A fine-grained token with **Pull requests: read** and **Issues: read** is enough.

## Busy repos

On a big repo, add these to the config:

```json
"teamOnly": true,
"abandonedDays": 14,
"limits": { "threads": 25, "nudges": 10 }
```

- `teamOnly`: ignore PRs from people outside `team`, except when a teammate was asked to review them.
- `abandonedDays`: a PR with no reviewer for longer than this is counted in one line instead of listed.
- `limits`: at most this many threads summarized and nudges written per night (most active threads and oldest reviews first), so model time stays bounded.

Lists in the brief show 10 items and then "…and N more". If GitHub has more than 500 open PRs, the brief says so instead of silently stopping.

### Load test: ollama/ollama

Run on the same 4-core ARM server, while it also serves three live websites:

| | Before | After |
|---|---|---|
| Collecting 24 h of ollama/ollama (500 open PRs) | 450 s, 1,013 API calls | 60 s, 537 API calls |
| Gemma (gemma4:e4b-it-qat, CPU only) | 29 calls, 412 s | 17 calls, 306 s |
| PRs "with no reviewer" listed | 400 | 10 shown of 143, plus 258 abandoned in one line |
| Other sites on the box during the model run | | median +5 to 12 ms, max 57 ms, 0 failed requests |

## Phone push (optional)

Off by default. To get a push only when something needs attention, install the free [ntfy](https://ntfy.sh) app (open source, no account), subscribe to a topic name nobody can guess, and add to your config:

```json
"notify": { "ntfy": { "url": "https://ntfy.sh", "topic": "lazylead-your-unguessable-topic" } }
```

What gets sent: the TL;DR plus up to five lines (overdue reviews, PRs with no reviewer, unanswered questions), with buttons that open the PRs. Nothing is sent on an all-clear night. The text goes through the ntfy server, so for private repos either self-host ntfy (one binary) or use a token-protected topic (`"token": "..."`).

## Nightly on a server

`deploy/` has a systemd service and timer that run LazyLead every night at 03:00 as its own user, at low priority. On a 4-core ARM server with no GPU, `gemma4:e4b-it-qat` writes about 8 tokens per second. That is slow, and it does not matter: nobody is awake.

```bash
sudo cp deploy/lazylead.service deploy/lazylead.timer /etc/systemd/system/
sudo systemctl enable --now lazylead.timer
```

The service runs `git pull --ff-only` in `/opt/lazylead` before each brief, so merged changes go live on the next run.

## Tests

```bash
npm test
```

The tests use a saved snapshot and a fake model, so they run offline in under a second.

## License

MIT
