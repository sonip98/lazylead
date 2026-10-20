// The only place the model is used. Three small jobs:
//   1. summarize each active PR thread and spot open asks (map)
//   2. draft a friendly nudge for each stale review request
//   3. write the TL;DR from the facts (reduce), and reject it if it invents numbers

const SYSTEM =
  'You help a busy tech lead read GitHub pull request activity. Be factual and brief. ' +
  'Use only the text you are given. Never invent people, numbers, decisions or deadlines.';

const THREAD_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    asks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { to: { type: 'string' }, ask: { type: 'string' } },
        required: ['to', 'ask'],
      },
    },
  },
  required: ['summary', 'asks'],
};

const MESSAGE_SCHEMA = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
const TLDR_SCHEMA = { type: 'object', properties: { tldr: { type: 'string' } }, required: ['tldr'] };

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const fmtHours = (h) => (h < 2 / 60 ? 'just now' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

export async function summarizeThread(llm, t) {
  const input = {
    pr: `#${t.number} ${t.title}`,
    author: t.author,
    state: t.state,
    description: clip(t.body || '', 1200),
    comments: t.comments.map((c) => ({ by: c.by, new: c.isNew, text: clip(c.text, 700) })),
  };
  const out = await llm.json(
    SYSTEM,
    `Pull request discussion as JSON:\n${JSON.stringify(input)}\n\n` +
      'Return JSON with:\n' +
      'Focus on comments with "new": true. The description and older comments are only context.\n' +
      '- summary: one sentence, at most 25 words: what the new comments say and where things stand now.\n' +
      `- asks: questions or requests in the new comments that still wait for a reply. "to" is the GitHub login who must answer, one of: ${t.participants.join(', ')}. "ask" is at most 15 words. Empty list if nothing is waiting.`,
    THREAD_SCHEMA,
  );
  // The model may only point at people who are actually in the thread.
  const asks = (out.asks || []).filter((a) => t.participants.includes(a.to.replace(/^@/, ''))).map((a) => ({ ...a, to: a.to.replace(/^@/, '') }));
  return { summary: out.summary, asks };
}

export async function draftNudge(llm, w) {
  const out = await llm.json(
    SYSTEM,
    `Write one short, friendly chat message to @${w.reviewer} asking them to review pull request #${w.number} "${w.title}" by @${w.author}. ` +
      `It has waited ${fmtHours(w.waitingHours)}. At most 30 words. Polite, not pushy, no guilt. Return JSON {"message": "..."}.`,
    MESSAGE_SCHEMA,
  );
  return out.message;
}

export function factNumbers(f) {
  return {
    merged: f.shipped.length,
    opened: f.opened.length,
    reviewsWaiting: f.waiting.length,
    staleReviews: f.waiting.filter((w) => w.stale).length,
    stuckPrs: f.stuck.length,
    readyToMerge: f.readyToMerge.length,
    mentions: f.mentions.length,
  };
}

export function fallbackTldr(n) {
  const parts = [`${n.merged} merged`, `${n.opened} opened`, `${n.reviewsWaiting} ${n.reviewsWaiting === 1 ? 'review' : 'reviews'} waiting (${n.staleReviews} stale)`];
  if (n.stuckPrs) parts.push(`${n.stuckPrs} stuck without a reviewer`);
  if (n.readyToMerge) parts.push(`${n.readyToMerge} approved and ready to merge`);
  return `${parts.join(', ')}.`;
}

// Titles only, no PR numbers or hours, so the TL;DR number check stays strict.
function urgentItems(f) {
  return [
    ...f.waiting.filter((w) => w.stale).map((w) => `- review of "${w.title}" by @${w.reviewer} is overdue`),
    ...f.changesRequested.map((p) => `- "${p.title}" has changes requested`),
    ...f.stuck.map((p) => `- "${p.title}" has no reviewer`),
    ...f.readyToMerge.map((p) => `- "${p.title}" is approved, not merged`),
  ].slice(0, 5);
}

// Every number in the model's TL;DR must be one we gave it.
// Digits inside @logins or words (sonip98, gemma4) are not numbers; #refs must be real PRs.
export function numbersCheck(text, n, extra = [], prNumbers = []) {
  const allowed = new Set([...Object.values(n), ...extra].map(String));
  const refs = new Set(prNumbers.map(String));
  const withoutLogins = text.replace(/@[\w-]+/g, '');
  const usedRefs = [...withoutLogins.matchAll(/#(\d+)\b/g)].map((m) => m[1]);
  const used = withoutLogins.replace(/#\d+\b/g, '').match(/\b\d+\b/g) || [];
  return usedRefs.every((x) => refs.has(x)) && used.every((x) => allowed.has(x));
}

// The counts as plain words, so the model does not echo JSON keys back.
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function countsInWords(n) {
  return [
    `${plural(n.merged, 'PR', 'PRs')} merged`,
    `${plural(n.opened, 'PR', 'PRs')} opened`,
    `${plural(n.reviewsWaiting, 'review', 'reviews')} waiting, ${n.staleReviews} of them overdue`,
    `${plural(n.stuckPrs, 'PR', 'PRs')} with no reviewer`,
    `${plural(n.readyToMerge, 'PR', 'PRs')} approved but not merged`,
    `${plural(n.mentions, 'unanswered mention', 'unanswered mentions')}`,
  ].join('; ');
}

export async function writeTldr(llm, f, summaries) {
  const n = factNumbers(f);
  const windowHours = Math.round((new Date(f.generatedAt) - new Date(f.windowStart)) / 3600_000);
  const out = await llm.json(
    SYSTEM,
    `Counts for the last ${windowHours} hours: ${countsInWords(n)}.\n` +
      `Most urgent items, in order:\n${urgentItems(f).join('\n') || '- none'}\n` +
      `Thread summaries:\n${summaries.map((s) => `- "${s.title}": ${s.summary}`).join('\n') || '- none'}\n\n` +
      'Write a TL;DR for the tech lead: at most 2 sentences. If there are urgent items, start with the most urgent one by its title; ' +
      'if there are none, start with the most notable activity instead and do not mention urgency at all. Then the counts. ' +
      'Use digits only from the counts above; do not compute new numbers. Leave out counts that are zero. Return JSON {"tldr": "..."}.',
    TLDR_SCHEMA,
  );
  const prNumbers = [...f.shipped, ...f.opened, ...f.closedUnmerged, ...f.waiting, ...f.stuck, ...f.readyToMerge, ...f.changesRequested].map((p) => p.number);
  const ok = numbersCheck(out.tldr, n, [windowHours], prNumbers);
  // Keep what the model wrote when it is rejected, so you can see why.
  return ok ? { text: out.tldr, checked: true } : { text: fallbackTldr(n), checked: false, rejected: out.tldr };
}

export const templateNudge = (w) =>
  `Hi @${w.reviewer}, could you take a look at #${w.number} "${w.title}" when you get a moment? It has waited ${fmtHours(w.waitingHours)}. Thanks!`;

// llm may be null (model down). Any single failed call falls back too, so the facts always ship.
// limits keep model work bounded on busy repos: most active threads, oldest overdue reviews first.
export async function buildBrief(f, { llm, team = [], lead, log = () => {}, limits = {} }) {
  const maxThreads = limits.threads ?? 25;
  const maxNudges = limits.nudges ?? 10;
  let modelFailures = 0;
  const tryModel = async (label, fn, fallback) => {
    if (!llm) return fallback();
    try {
      return await fn();
    } catch (err) {
      modelFailures++;
      log(`${label} failed, using fallback: ${err.message}`);
      return fallback();
    }
  };

  const summaries = [];
  const threads = [...f.threads].sort((a, b) => b.comments.filter((c) => c.isNew).length - a.comments.filter((c) => c.isNew).length).slice(0, maxThreads);
  for (const t of threads) {
    log(`summarize #${t.number}`);
    const newCount = t.comments.filter((c) => c.isNew).length;
    const s = await tryModel(`summarize #${t.number}`, () => summarizeThread(llm, t), () => ({
      summary: `${newCount} new comment${newCount === 1 ? '' : 's'}.`,
      asks: [],
    }));
    summaries.push({ repo: t.repo, number: t.number, title: t.title, url: t.url, ...s });
  }

  const nudges = [];
  for (const w of f.waiting.filter((x) => x.stale).slice(0, maxNudges)) {
    log(`nudge @${w.reviewer} on #${w.number}`);
    nudges.push({ ...w, message: await tryModel(`nudge #${w.number}`, () => draftNudge(llm, w), () => templateNudge(w)) });
  }

  log('tldr');
  const tldr = await tryModel('tldr', () => writeTldr(llm, f, summaries), () => ({ text: fallbackTldr(factNumbers(f)), checked: false }));

  const people = [...new Set([lead, ...team].filter(Boolean))].map((login) => {
    const asks = summaries.flatMap((s) => s.asks.filter((a) => a.to === login).map((a) => ({ ...a, repo: s.repo, number: s.number, title: s.title, url: s.url })));
    return {
      login,
      reviews: f.waiting.filter((w) => w.reviewer === login),
      asks,
      // A mention that the model already turned into an ask is shown once, as the ask.
      mentions: f.mentions.filter((m) => m.who === login && !asks.some((a) => a.repo === m.repo && a.number === m.number)),
      authoredChangesRequested: f.changesRequested.filter((p) => p.author === login),
      authoredReady: f.readyToMerge.filter((p) => p.author === login),
      authoredStuck: f.stuck.filter((p) => p.author === login),
    };
  });

  // What needs a human: overdue reviews, PRs nobody picked up, open questions to the team.
  const needYou =
    f.waiting.filter((w) => w.stale).length + f.stuck.length + people.reduce((sum, p) => sum + p.asks.length + p.mentions.length, 0);
  return {
    facts: f,
    numbers: factNumbers(f),
    tldr,
    summaries,
    skipped: { threads: f.threads.length - threads.length, nudges: Math.max(0, f.waiting.filter((x) => x.stale).length - maxNudges) },
    nudges,
    people,
    lazyMath: { scanned: f.itemsScanned, needYou, ignored: f.noise.botComments + f.noise.botPulls },
    model: llm ? llm.model : null,
    modelFailures,
    llmStats: llm ? { ...llm.stats } : { calls: 0, promptTokens: 0, outputTokens: 0, ms: 0 },
  };
}
