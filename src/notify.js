// Optional phone push via ntfy (https://ntfy.sh, open source, self-hostable).
// Quiet unless needed: nothing is sent when no one is blocked.
import { fmtHours } from './brief.js';

const ref = (p) => `${p.repo.split('/')[1]}#${p.number}`;

// Only exceptions: overdue reviews, PRs nobody picked up, questions nobody answered.
// Normal flow (a review requested an hour ago) is not worth a buzz.
export function attentionItems(b) {
  const items = [];
  for (const w of b.facts.waiting.filter((x) => x.stale)) {
    items.push({ text: `@${w.reviewer}: review ${ref(w)} "${w.title}" overdue (${fmtHours(w.waitingHours)})`, url: w.url });
  }
  for (const s of b.facts.stuck) {
    items.push({ text: `${ref(s)} "${s.title}" has no reviewer after ${fmtHours(s.ageHours)}`, url: s.url });
  }
  for (const p of b.people) {
    for (const a of p.asks) items.push({ text: `@${p.login}: reply on ${ref(a)}: ${a.ask}`, url: a.url });
    for (const m of p.mentions) items.push({ text: `@${p.login}: unanswered mention on ${ref(m)} by @${m.by}`, url: m.url });
  }
  return items;
}

export async function sendNtfy(b, { url = 'https://ntfy.sh', topic, token, maxItems = 5 }, { fetchImpl = fetch } = {}) {
  const items = attentionItems(b);
  if (!items.length) return { sent: false, items: 0 };

  const lines = items.slice(0, maxItems).map((i) => `• ${i.text}`);
  if (items.length > maxItems) lines.push(`…and ${items.length - maxItems} more`);
  // JSON publishing keeps non-ASCII PR titles safe (HTTP headers are not).
  const res = await fetchImpl(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      topic,
      title: `LazyLead: ${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} attention`,
      message: `${b.tldr.text}\n\n${lines.join('\n')}`,
      tags: ['sloth'],
      click: items[0].url,
      actions: items.slice(0, 3).map((i) => ({ action: 'view', label: i.text.split(':')[0].slice(0, 30), url: i.url })),
    }),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { sent: true, items: items.length };
}
