import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeFacts, mentionsIn } from '../src/facts.js';
import { buildBrief, numbersCheck } from '../src/brief.js';
import { toMarkdown, toHtml, toPersonMarkdown } from '../src/render.js';

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url)));
const team = ['lead', 'ravi', 'asha'];

// Stands in for Gemma: answers by schema, records prompts.
function fakeLlm({ tldr = 'Checkout fix waits on lead; 1 merged.' } = {}) {
  const prompts = [];
  return {
    model: 'fake',
    stats: { calls: 0, promptTokens: 0, outputTokens: 0, ms: 0 },
    prompts,
    async json(system, user, schema) {
      prompts.push(user);
      this.stats.calls++;
      if (schema.required.includes('summary')) return { summary: 'Ravi asks about retries.', asks: [{ to: '@lead', ask: 'Confirm 3 retries' }, { to: 'stranger', ask: 'x' }] };
      if (schema.required.includes('message')) return { message: 'Hey @lead, could you look at #2?' };
      return { tldr };
    },
  };
}

test('facts: shipped, waiting, stuck, ready, noise', () => {
  const f = computeFacts(snapshot, { team, staleHours: 24 });
  assert.deepEqual(f.shipped.map((p) => p.number), [1]);
  assert.deepEqual(f.opened.map((p) => p.number), [4]);
  assert.equal(f.waiting.length, 1);
  assert.equal(f.waiting[0].reviewer, 'lead');
  assert.equal(Math.round(f.waiting[0].waitingHours), 30);
  assert.equal(f.waiting[0].stale, true);
  assert.deepEqual(f.stuck.map((p) => p.number), [3]);
  assert.deepEqual(f.readyToMerge.map((p) => p.number), [4]);
  assert.deepEqual(f.noise, { botComments: 1, botPulls: 1 });
  assert.deepEqual(f.reviewLoad, { lead: 1 });
});

test('facts: mentions skip code spans and self-mentions', () => {
  assert.deepEqual(mentionsIn('@lead see `@asha` and ```\n@ravi\n```', team), ['lead']);
  assert.deepEqual(mentionsIn('email me at x@lead.com', team), []);
  const f = computeFacts(snapshot, { team });
  assert.deepEqual(f.mentions.map((m) => [m.who, m.by, m.number]), [['lead', 'ravi', 2]]);
});

test('facts: thread keeps older context and marks new comments', () => {
  const [t] = computeFacts(snapshot, { team }).threads;
  assert.equal(t.number, 2);
  assert.deepEqual(t.comments.map((c) => c.isNew), [false, true]);
  assert.ok(t.participants.includes('lead'));
});

test('numbersCheck rejects invented numbers', () => {
  const n = { merged: 1, opened: 1 };
  assert.equal(numbersCheck('1 merged, 1 opened', n), true);
  assert.equal(numbersCheck('3 merged', n), false);
  assert.equal(numbersCheck('in the last 24 hours, 1 merged', n, [24]), true);
  // Found in a real run: "@sonip98" was read as the number 98.
  assert.equal(numbersCheck('Review by @sonip98 is overdue; 1 merged', n), true);
  assert.equal(numbersCheck('Runs on gemma4, 1 merged', n), true);
  assert.equal(numbersCheck('#2 is overdue', n, [], [2]), true);
  assert.equal(numbersCheck('#99 is overdue', n, [], [2]), false);
});

test('brief: drops asks to non-participants, falls back on bad TL;DR', async () => {
  const f = computeFacts(snapshot, { team });
  const good = await buildBrief(f, { llm: fakeLlm(), team, lead: 'lead' });
  assert.deepEqual(good.summaries[0].asks, [{ to: 'lead', ask: 'Confirm 3 retries' }]);
  assert.equal(good.tldr.checked, true);
  assert.equal(good.nudges.length, 1);
  const lead = good.people.find((p) => p.login === 'lead');
  assert.equal(lead.reviews.length, 1);
  assert.equal(lead.asks.length, 1);
  assert.equal(good.people.find((p) => p.login === 'asha').authoredReady.length, 1);

  const bad = await buildBrief(f, { llm: fakeLlm({ tldr: '7 PRs merged today!' }), team, lead: 'lead' });
  assert.equal(bad.tldr.checked, false);
  assert.equal(bad.tldr.rejected, '7 PRs merged today!');
  assert.match(bad.tldr.text, /1 review waiting/);
  assert.match(toMarkdown(bad), /was replaced because it used a number not in the facts: "7 PRs merged today!"/);
  assert.match(bad.tldr.text, /^1 merged/);
});

test('render: markdown and html', async () => {
  const b = await buildBrief(computeFacts(snapshot, { team }), { llm: fakeLlm(), team, lead: 'lead' });
  const md = toMarkdown(b);
  assert.match(md, /### @lead/);
  assert.match(md, /Review \[shop#2\]/);
  assert.match(md, /Nothing\. Go have a coffee/);
  const html = toHtml(b);
  assert.match(html, /<a href="https:\/\/github.com\/acme\/shop\/pull\/2">shop#2<\/a>/);
  assert.match(html, /data-copy="Hey @lead/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('brief: model down still ships the facts', async () => {
  const f = computeFacts(snapshot, { team });
  const b = await buildBrief(f, { llm: null, team, lead: 'lead' });
  assert.equal(b.model, null);
  assert.match(b.tldr.text, /^1 merged/);
  assert.match(b.nudges[0].message, /^Hi @lead, could you take a look at #2/);
  assert.equal(b.summaries[0].summary, '1 new comment.');
  assert.match(toMarkdown(b), /Model unavailable/);
});

test('brief: one failing model call falls back, the rest still run', async () => {
  const llm = fakeLlm();
  const real = llm.json.bind(llm);
  llm.json = async (system, user, schema) => {
    if (schema.required.includes('message')) throw new Error('timeout');
    return real(system, user, schema);
  };
  const b = await buildBrief(computeFacts(snapshot, { team }), { llm, team, lead: 'lead' });
  assert.equal(b.modelFailures, 1);
  assert.match(b.nudges[0].message, /^Hi @lead/);
  assert.equal(b.tldr.checked, true);
  assert.match(toMarkdown(b), /1 model call\(s\) fell back/);
});

test('render: per-person brief has only that person', async () => {
  const b = await buildBrief(computeFacts(snapshot, { team }), { llm: fakeLlm(), team, lead: 'lead' });
  const lead = toPersonMarkdown(b, b.people.find((p) => p.login === 'lead'));
  assert.match(lead, /Waiting on @lead/);
  assert.match(lead, /Review \[shop#2\]/);
  assert.doesNotMatch(lead, /footer links/);
  assert.match(toPersonMarkdown(b, b.people.find((p) => p.login === 'asha')), /Your \[shop#3\].*no reviewer after 2d/);
  assert.match(toPersonMarkdown(b, b.people.find((p) => p.login === 'ravi')), /Go have a coffee/);
});

test('fmtHours: just now, hours, days', async () => {
  const { fmtHours } = await import('../src/brief.js');
  assert.equal(fmtHours(0.01), 'just now');
  assert.equal(fmtHours(0.53), '32m');
  assert.equal(fmtHours(30), '30h');
  assert.equal(fmtHours(72), '3d');
});

test('facts: a mention that was answered later is dropped', () => {
  const answered = structuredClone(snapshot);
  answered.repos[0].comments.push({ pr: 2, kind: 'comment', id: 13, user: 'lead', isBot: false, body: '3 is fine.', createdAt: '2026-10-20T16:00:00Z', url: 'u' });
  assert.equal(computeFacts(answered, { team }).mentions.length, 0);
  assert.equal(computeFacts(snapshot, { team }).mentions.length, 1);
});

test('notify: only exceptions, quiet when all clear', async () => {
  const { attentionItems, sendNtfy } = await import('../src/notify.js');
  const b = await buildBrief(computeFacts(snapshot, { team }), { llm: fakeLlm(), team, lead: 'lead' });
  const items = attentionItems(b);
  // overdue review of #2, #3 with no reviewer, the ask to lead on #2
  assert.equal(items.length, 3);
  assert.match(items[0].text, /@lead: review shop#2 "Fix checkout timeout" overdue \(30h\)/);

  const calls = [];
  const fetchImpl = async (url, opts) => (calls.push({ url, body: JSON.parse(opts.body) }), { ok: true });
  const r = await sendNtfy(b, { topic: 't', url: 'https://ntfy.example/' }, { fetchImpl });
  assert.deepEqual(r, { sent: true, items: 3 });
  assert.equal(calls[0].url, 'https://ntfy.example');
  assert.equal(calls[0].body.topic, 't');
  assert.equal(calls[0].body.title, 'LazyLead: 3 things need attention');
  assert.equal(calls[0].body.click, 'https://github.com/acme/shop/pull/2');
  assert.deepEqual(calls[0].body.actions.map((a) => a.label), ['Review shop#2', 'Open shop#3', 'Reply shop#2']);

  const quiet = structuredClone(b);
  quiet.facts.waiting = [];
  quiet.facts.stuck = [];
  quiet.people = quiet.people.map((p) => ({ ...p, asks: [], mentions: [] }));
  calls.length = 0;
  assert.deepEqual(await sendNtfy(quiet, { topic: 't' }, { fetchImpl }), { sent: false, items: 0 });
  assert.equal(calls.length, 0);
});

test('scale: abandoned PRs are counted, not listed', () => {
  const s = structuredClone(snapshot);
  s.repos[0].pulls[2].createdAt = '2026-09-01T00:00:00Z'; // #3, weeks without a reviewer
  const f = computeFacts(s, { team, abandonedDays: 14 });
  assert.equal(f.stuck.length, 0);
  assert.equal(f.abandoned, 1);
});

test('scale: teamOnly skips outside PRs but keeps review requests to teammates', () => {
  const s = structuredClone(snapshot);
  s.repos[0].pulls[1].author = 'stranger'; // #2, review requested from lead
  s.repos[0].pulls[2].author = 'stranger'; // #3, stuck
  const f = computeFacts(s, { team, teamOnly: true });
  assert.equal(f.skippedOutsideTeam, 2);
  assert.deepEqual(f.stuck, []);
  assert.deepEqual(f.waiting.map((w) => [w.number, w.reviewer]), [[2, 'lead']]);
  assert.equal(f.threads.length, 0);
});

test('scale: long lists are capped, warnings shown', async () => {
  const s = structuredClone(snapshot);
  const base = s.repos[0].pulls[2];
  for (let i = 0; i < 25; i++) s.repos[0].pulls.push({ ...structuredClone(base), number: 100 + i, title: `Old thing ${i}` });
  s.repos[0].warnings = ['Only the first 500 open PRs of acme/shop were read.'];
  const f = computeFacts(s, { team });
  assert.equal(f.stuck.length, 26);
  const b = await buildBrief(f, { llm: null, team, lead: 'lead' });
  const md = toMarkdown(b);
  assert.equal((md.match(/🧊/g) || []).length, 10);
  assert.match(md, /…and 16 more with no reviewer/);
  assert.match(md, /⚠️ Only the first 500 open PRs/);
  assert.match(toHtml(b), /<p class="warn">⚠️ Only the first 500/);
});

test('scale: model work is bounded', async () => {
  const s = structuredClone(snapshot);
  const pr2 = s.repos[0].pulls[1];
  for (let i = 0; i < 15; i++) s.repos[0].pulls.push({ ...structuredClone(pr2), number: 200 + i });
  const llm = fakeLlm();
  const b = await buildBrief(computeFacts(s, { team }), { llm, team, lead: 'lead', limits: { nudges: 4, threads: 25 } });
  assert.equal(b.nudges.length, 4);
  assert.equal(b.skipped.nudges, 12);
  assert.match(toMarkdown(b), /12 more overdue reviews/);
});

test('collect: events only for PRs with requested reviewers, truncation warned, bounded concurrency', async () => {
  const { collect } = await import('../src/collect.js');
  const pull = (n, reviewers) => ({ number: n, title: `t${n}`, body: '', user: { login: 'dev', type: 'User' }, draft: false, state: 'open', html_url: `https://x/pull/${n}`, created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', closed_at: null, merged_at: null, requested_reviewers: reviewers.map((login) => ({ login })) });
  const open = Array.from({ length: 12 }, (_, i) => pull(i + 1, i === 0 ? ['lead'] : []));
  open.truncated = true;
  let inFlight = 0, maxInFlight = 0;
  const calls = { events: 0, reviews: 0 };
  const slow = async (v) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return v; };
  const gh = {
    openPulls: async () => open,
    recentClosedPulls: async () => [],
    reviews: async () => (calls.reviews++, slow([])),
    issueEvents: async () => (calls.events++, slow([{ event: 'review_requested', requested_reviewer: { login: 'lead' }, created_at: '2026-10-20T01:00:00Z' }])),
    issueComments: async () => [],
    reviewComments: async () => [],
  };
  const snap = await collect(gh, { repos: ['acme/big'], windowHours: 24, now: new Date('2026-10-21T00:00:00Z'), concurrency: 3 });
  assert.equal(calls.reviews, 12);
  assert.equal(calls.events, 1);
  assert.ok(maxInFlight <= 3 && maxInFlight > 1);
  assert.deepEqual(snap.repos[0].warnings, ['Only the first 12 open PRs of acme/big were read.']);
  assert.equal(snap.repos[0].pulls[0].reviewRequests[0].reviewer, 'lead');
});

test('lazy math: never claims you read more than it did', async () => {
  const s = structuredClone(snapshot);
  const base = s.repos[0].pulls[2];
  for (let i = 0; i < 25; i++) s.repos[0].pulls.push({ ...structuredClone(base), number: 300 + i });
  const b = await buildBrief(computeFacts(s, { team }), { llm: null, team, lead: 'lead' });
  assert.ok(b.lazyMath.needYou <= b.lazyMath.scanned, `${b.lazyMath.needYou} > ${b.lazyMath.scanned}`);
});
