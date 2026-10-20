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

test('render: per-person brief has only that person', async () => {
  const b = await buildBrief(computeFacts(snapshot, { team }), { llm: fakeLlm(), team, lead: 'lead' });
  const lead = toPersonMarkdown(b, b.people.find((p) => p.login === 'lead'));
  assert.match(lead, /Waiting on @lead/);
  assert.match(lead, /Review \[shop#2\]/);
  assert.doesNotMatch(lead, /footer links/);
  assert.match(toPersonMarkdown(b, b.people.find((p) => p.login === 'ravi')), /Go have a coffee/);
});
