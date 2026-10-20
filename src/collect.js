// Turns GitHub API responses into a plain snapshot object.
// A snapshot is just data, so a brief can be rebuilt offline (and tested) from a saved file.

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/.test(user.login);

function slimPull(p) {
  return {
    number: p.number,
    title: p.title,
    body: (p.body || '').slice(0, 2000),
    author: p.user?.login,
    authorIsBot: isBot(p.user),
    draft: Boolean(p.draft),
    state: p.state,
    url: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    closedAt: p.closed_at,
    mergedAt: p.merged_at,
    requestedReviewers: (p.requested_reviewers || []).map((u) => u.login),
  };
}

const prNumberFromUrl = (url) => Number(/\/(\d+)$/.exec(url || '')?.[1]);

export async function collect(gh, { repos, windowHours, now = new Date() }) {
  const windowStart = new Date(now.getTime() - windowHours * 3600_000);
  // Comments are fetched with extra lookback so a thread has some context before the window.
  const since = new Date(windowStart.getTime() - 48 * 3600_000).toISOString();
  const snapshot = { generatedAt: now.toISOString(), windowStart: windowStart.toISOString(), repos: [] };

  for (const repo of repos) {
    const open = (await gh.openPulls(repo)).map(slimPull);
    const closed = (await gh.recentClosedPulls(repo))
      .filter((p) => new Date(p.closed_at) >= windowStart)
      .map(slimPull);
    const pulls = [...open, ...closed];

    for (const pr of pulls) {
      pr.reviews = (await gh.reviews(repo, pr.number)).map((r) => ({
        user: r.user?.login,
        state: r.state,
        submittedAt: r.submitted_at,
      }));
      if (pr.state === 'open') {
        // When was each current reviewer asked? Last review_requested event wins.
        const events = await gh.issueEvents(repo, pr.number);
        pr.reviewRequests = events
          .filter((e) => e.event === 'review_requested' && e.requested_reviewer)
          .map((e) => ({ reviewer: e.requested_reviewer.login, at: e.created_at }));
      } else {
        pr.reviewRequests = [];
      }
    }

    const prNumbers = new Set(pulls.map((p) => p.number));
    const issueComments = (await gh.issueComments(repo, since))
      .filter((c) => /\/pull\/\d+/.test(c.html_url))
      .map((c) => ({ pr: prNumberFromUrl(c.issue_url), kind: 'comment', c }));
    const reviewComments = (await gh.reviewComments(repo, since)).map((c) => ({
      pr: prNumberFromUrl(c.pull_request_url),
      kind: 'review-comment',
      c,
    }));
    const comments = [...issueComments, ...reviewComments]
      .filter(({ pr }) => prNumbers.has(pr))
      .map(({ pr, kind, c }) => ({
        pr,
        kind,
        id: c.id,
        user: c.user?.login,
        isBot: isBot(c.user),
        body: (c.body || '').slice(0, 1500),
        createdAt: c.created_at,
        url: c.html_url,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    snapshot.repos.push({ name: repo, pulls, comments });
  }
  return snapshot;
}
