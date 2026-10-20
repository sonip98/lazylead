// Everything in this file is plain code: counts, wait times, who is waiting on whom.
// The model never produces these. It only writes words around them.

const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600_000;

export function mentionsIn(body, team) {
  const text = (body || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const wanted = new Map(team.map((t) => [t.toLowerCase(), t]));
  const found = new Set();
  for (const m of text.matchAll(/(^|[^\w`])@([A-Za-z0-9-]{1,39})\b/g)) {
    const login = wanted.get(m[2].toLowerCase());
    if (login) found.add(login);
  }
  return [...found];
}

// Latest review state per reviewer (COMMENTED does not override a decision).
function decisions(pr) {
  const latest = new Map();
  for (const r of [...pr.reviews].sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''))) {
    if (!r.user || r.user === pr.author) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || !latest.has(r.user)) latest.set(r.user, r.state);
  }
  return latest;
}

// teamOnly: ignore PRs authored outside the team (big open-source repos).
// abandonedDays: a PR with no reviewer for longer than this is counted, not listed.
export function computeFacts(snapshot, { team = [], staleHours = 24, teamOnly = false, abandonedDays = 14 } = {}) {
  const now = snapshot.generatedAt;
  const windowStart = snapshot.windowStart;
  const inWindow = (t) => t && t >= windowStart;

  const f = {
    generatedAt: now,
    windowStart,
    shipped: [],
    closedUnmerged: [],
    opened: [],
    waiting: [],
    stuck: [],
    abandoned: 0,
    skippedOutsideTeam: 0,
    warnings: [],
    readyToMerge: [],
    changesRequested: [],
    mentions: [],
    threads: [],
    reviewLoad: {},
    noise: { botComments: 0, botPulls: 0 },
    itemsScanned: 0,
  };

  const inTeam = new Set(team);
  for (const repo of snapshot.repos) {
    f.warnings.push(...(repo.warnings || []));
    const addWaiting = (pr, reviewers) => {
      for (const reviewer of reviewers) {
        const asked = pr.reviewRequests.filter((r) => r.reviewer === reviewer).at(-1)?.at || pr.createdAt;
        const waitingHours = hoursBetween(asked, now);
        f.waiting.push({ ...ref(pr), reviewer, waitingHours, stale: waitingHours >= staleHours });
        f.reviewLoad[reviewer] = (f.reviewLoad[reviewer] || 0) + 1;
      }
    };
    const ref = (pr) => ({ repo: repo.name, number: pr.number, title: pr.title, author: pr.author, url: pr.url });

    for (const pr of repo.pulls) {
      f.itemsScanned++; // every PR looked at counts, not only the day's activity
      if (pr.authorIsBot) {
        if (inWindow(pr.createdAt) || inWindow(pr.closedAt)) f.noise.botPulls++;
        continue;
      }
      const outside = teamOnly && inTeam.size && !inTeam.has(pr.author);
      if (outside) {
        f.skippedOutsideTeam++;
        // Outside PRs only matter when a teammate was asked to review them.
        if (pr.state === 'open' && !pr.draft) addWaiting(pr, pr.requestedReviewers.filter((r) => inTeam.has(r)));
        continue;
      }
      if (inWindow(pr.mergedAt)) f.shipped.push(ref(pr));
      else if (inWindow(pr.closedAt)) f.closedUnmerged.push(ref(pr));
      if (pr.state === 'open' && inWindow(pr.createdAt)) f.opened.push(ref(pr));
      f.itemsScanned += pr.reviews.filter((r) => inWindow(r.submittedAt)).length;

      if (pr.state !== 'open' || pr.draft) continue;
      const ageHours = hoursBetween(pr.createdAt, now);

      addWaiting(pr, pr.requestedReviewers);

      const d = decisions(pr);
      const states = [...d.values()];
      if (states.includes('CHANGES_REQUESTED')) {
        f.changesRequested.push({ ...ref(pr), by: [...d].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u) });
      } else if (states.includes('APPROVED') && pr.requestedReviewers.length === 0) {
        f.readyToMerge.push({ ...ref(pr), ageHours });
      } else if (pr.requestedReviewers.length === 0 && d.size === 0 && ageHours >= staleHours) {
        if (ageHours >= abandonedDays * 24) f.abandoned++;
        else f.stuck.push({ ...ref(pr), ageHours });
      }
    }

    // Comments: count noise, find @mentions, and group human discussion into threads.
    const activePrs = new Set();
    for (const c of repo.comments) {
      if (!inWindow(c.createdAt)) continue;
      f.itemsScanned++;
      if (c.isBot) {
        f.noise.botComments++;
        continue;
      }
      for (const who of mentionsIn(c.body, team)) {
        if (who === c.user) continue;
        const pr = repo.pulls.find((p) => p.number === c.pr);
        // Already answered: the mentioned person commented or reviewed on this PR afterwards.
        const answered =
          repo.comments.some((r) => r.pr === c.pr && r.user === who && r.createdAt > c.createdAt) ||
          (pr?.reviews || []).some((r) => r.user === who && r.submittedAt > c.createdAt);
        if (answered) continue;
        f.mentions.push({ repo: repo.name, number: c.pr, title: pr?.title, who, by: c.user, at: c.createdAt, url: c.url, excerpt: c.body.slice(0, 200) });
      }
      activePrs.add(c.pr);
    }
    for (const number of activePrs) {
      const pr = repo.pulls.find((p) => p.number === number);
      if (!pr || pr.authorIsBot) continue;
      if (teamOnly && inTeam.size && !inTeam.has(pr.author)) continue;
      const human = repo.comments.filter((c) => c.pr === number && !c.isBot);
      const firstNew = human.findIndex((c) => inWindow(c.createdAt));
      f.threads.push({
        ...ref(pr),
        body: pr.body,
        state: pr.mergedAt ? 'merged' : pr.state,
        // Up to 3 older comments for context, then everything new.
        comments: human.slice(Math.max(0, firstNew - 3)).map((c) => ({ by: c.user, at: c.createdAt, isNew: inWindow(c.createdAt), text: c.body })),
        participants: [...new Set([pr.author, ...human.map((c) => c.user), ...pr.requestedReviewers])],
      });
    }
  }

  f.waiting.sort((a, b) => b.waitingHours - a.waitingHours);
  f.stuck.sort((a, b) => b.ageHours - a.ageHours);
  return f;
}
