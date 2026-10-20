// Read-only GitHub REST client. LazyLead never writes to GitHub.
const API = 'https://api.github.com';
const MAX_PAGES = 5;

export function createGitHub(token, { fetchImpl = fetch } = {}) {
  async function request(url) {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lazylead',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub ${res.status} for ${url.replace(API, '')}: ${body.slice(0, 200)}`);
    }
    return res;
  }

  // Follows Link rel="next" up to MAX_PAGES.
  async function getAll(path) {
    let url = `${API}${path}`;
    const items = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await request(url);
      items.push(...(await res.json()));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
      url = next ? next[1] : null;
    }
    return items;
  }

  async function getOne(path) {
    return (await request(`${API}${path}`)).json();
  }

  return {
    openPulls: (repo) => getAll(`/repos/${repo}/pulls?state=open&per_page=100`),
    // One page is enough: sorted by update time, we only need the last day or so.
    recentClosedPulls: (repo) =>
      getOne(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`),
    reviews: (repo, n) => getAll(`/repos/${repo}/pulls/${n}/reviews?per_page=100`),
    issueEvents: (repo, n) => getAll(`/repos/${repo}/issues/${n}/events?per_page=100`),
    issueComments: (repo, since) =>
      getAll(`/repos/${repo}/issues/comments?since=${since}&per_page=100`),
    reviewComments: (repo, since) =>
      getAll(`/repos/${repo}/pulls/comments?since=${since}&per_page=100`),
  };
}
