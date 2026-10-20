import { fmtHours } from './brief.js';

const prLink = (p) => `[${p.repo.split('/')[1]}#${p.number}](${p.url}) ${p.title}`;
const day = (iso) => new Date(iso).toISOString().slice(0, 10);

const MAX_LINES = 10;
// Long lists end with a count instead of a wall of links.
const capped = (lines, what = 'more') => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- …and ${lines.length - MAX_LINES} ${what}`] : lines);

function personLines(p) {
  const lines = [
    ...p.reviews.map((w) => `- Review ${prLink(w)} — ${fmtHours(w.waitingHours) === 'just now' ? 'requested just now' : `waiting ${fmtHours(w.waitingHours)}`}${w.stale ? ' ⏰' : ''}`),
    ...p.asks.map((a) => `- Reply on ${prLink(a)}: ${a.ask}`),
    ...p.mentions.map((m) => `- @${m.by} mentioned you on ${prLink(m)}`),
    ...p.authoredChangesRequested.map((c) => `- Your ${prLink(c)} has changes requested by ${c.by.map((u) => `@${u}`).join(', ')}`),
    ...p.authoredReady.map((r) => `- Your ${prLink(r)} is approved — merge it`),
    ...p.authoredStuck.map((s) => `- Your ${prLink(s)} has no reviewer after ${fmtHours(s.ageHours)} — ask someone`),
  ];
  return lines.length ? capped(lines) : ['- Nothing. Go have a coffee. ☕'];
}

// A short brief for one teammate: only what waits on them.
export function toPersonMarkdown(b, p) {
  return [`# 🦥 Waiting on @${p.login} — ${day(b.facts.generatedAt)}`, '', ...personLines(p), ''].join('\n');
}

export function toMarkdown(b) {
  const f = b.facts;
  const out = [];
  out.push(`# 🦥 LazyLead brief — ${day(f.generatedAt)}`, '');
  out.push(`**TL;DR:** ${b.tldr.text}`, '');
  if (b.tldr.rejected) out.push(`_Gemma's TL;DR was replaced because it used a number not in the facts: "${b.tldr.rejected}"_`, '');
  out.push(`_Read ${b.lazyMath.scanned} items so you can read ${b.lazyMath.needYou}. Ignored ${b.lazyMath.ignored} bot items._`, '');
  for (const w of f.warnings || []) out.push(`> ⚠️ ${w}`, '');

  if (b.people.length) {
    out.push('## Needs someone');
    for (const p of b.people) out.push('', `### @${p.login}`, ...personLines(p));
  }

  out.push('', '## Yesterday');
  out.push(...(f.shipped.length ? capped(f.shipped.map((p) => `- ✅ Merged ${prLink(p)} (@${p.author})`), 'more merged') : ['- Nothing merged.']));
  out.push(...capped(f.opened.map((p) => `- 🆕 Opened ${prLink(p)} (@${p.author})`), 'more opened'));
  out.push(...capped(f.closedUnmerged.map((p) => `- ✖️ Closed without merge ${prLink(p)}`), 'more closed'));
  if (f.skippedOutsideTeam) out.push(`- _${f.skippedOutsideTeam} PRs from outside the team not listed._`);

  if (b.summaries.length) {
    out.push('', '## Discussions');
    out.push(...b.summaries.map((s) => `- ${prLink(s)} — ${s.summary}`));
    if (b.skipped?.threads) out.push(`- _${b.skipped.threads} quieter threads not summarized._`);
  }

  if (f.stuck.length || f.waiting.length || f.abandoned) {
    out.push('', '## Stuck & review load');
    out.push(...capped(f.stuck.map((p) => `- 🧊 ${prLink(p)} open ${fmtHours(p.ageHours)} with no reviewer`), 'more with no reviewer'));
    if (f.abandoned) out.push(`- 🕸️ ${f.abandoned} older PRs have had no reviewer for weeks (not listed).`);
    const load = Object.entries(f.reviewLoad).sort((a, b) => b[1] - a[1]);
    if (load.length) out.push(`- Pending reviews: ${load.slice(0, MAX_LINES).map(([u, n]) => `@${u} ${n}`).join(', ')}${load.length > MAX_LINES ? `, +${load.length - MAX_LINES} people` : ''}`);
  }

  if (b.nudges.length) {
    out.push('', '## Nudge drafts (copy, paste, done)');
    out.push(...b.nudges.map((n) => `- To @${n.reviewer} on ${prLink(n)}:\n  > ${n.message}`));
    if (b.skipped?.nudges) out.push(`- _${b.skipped.nudges} more overdue reviews (oldest shown first)._`);
  }

  const s = b.llmStats;
  out.push('', '---');
  if (!b.model) out.push('_Model unavailable: facts-only brief, nudges from a template._');
  else
    out.push(
      `_${b.model} on local Ollama · ${s.calls} calls · ${s.promptTokens + s.outputTokens} tokens · ${(s.ms / 1000).toFixed(0)}s · $0 · TL;DR numbers ${b.tldr.checked ? 'checked ✓' : 'replaced with facts'}` +
        `${b.modelFailures ? ` · ${b.modelFailures} model call(s) fell back` : ''}_`,
    );
  return out.join('\n') + '\n';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Small markdown subset → HTML (links, bold, italics, blockquotes, lists, headings).
function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
}

export function toHtml(b) {
  const md = toMarkdown(b).split('\n');
  const body = [];
  let inList = false;
  const closeList = () => inList && (body.push('</ul>'), (inList = false));
  for (const line of md) {
    if (line.startsWith('- ')) {
      if (!inList) body.push('<ul>'), (inList = true);
      body.push(`<li>${inline(line.slice(2))}`);
    } else if (line.startsWith('> ')) {
      closeList();
      body.push(`<p class="warn">${inline(line.slice(2))}</p>`);
    } else if (line.startsWith('  > ')) {
      const text = line.slice(4);
      body.push(`<blockquote>${esc(text)}<button data-copy="${esc(text)}">Copy</button></blockquote>`);
    } else {
      closeList();
      if (line.startsWith('### ')) body.push(`<h3>${inline(line.slice(4))}</h3>`);
      else if (line.startsWith('## ')) body.push(`<h2>${inline(line.slice(3))}</h2>`);
      else if (line.startsWith('# ')) body.push(`<h1>${inline(line.slice(2))}</h1>`);
      else if (line === '---') body.push('<hr>');
      else if (line.trim()) body.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LazyLead brief ${day(b.facts.generatedAt)}</title>
<style>
:root{--bg:#f7f5ef;--card:#fff;--ink:#1f2a1f;--muted:#5f6b5f;--accent:#2f7d4f;--line:#e2ddd0}
@media (prefers-color-scheme:dark){:root{--bg:#141a15;--card:#1c241d;--ink:#e6efe6;--muted:#9aab9a;--accent:#6fcf97;--line:#2c382d}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem}h2{margin-top:2rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
h3{margin:1.2rem 0 .3rem;color:var(--accent)}
a{color:var(--accent)}em{color:var(--muted)}
ul{padding-left:1.2rem}li{margin:.25rem 0}
blockquote{margin:.4rem 0 .8rem;padding:.6rem .8rem;background:var(--card);border-left:3px solid var(--accent);border-radius:6px;display:flex;gap:.8rem;justify-content:space-between;align-items:center}
button{font:inherit;font-size:.85rem;padding:.25rem .7rem;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px;cursor:pointer}
p strong{font-size:1.05rem}
.warn{padding:.5rem .8rem;border:1px solid #d9a441;border-radius:6px;background:var(--card)}
</style></head><body><main>
${body.join('\n')}
</main>
<script>
document.addEventListener('click',e=>{const t=e.target.closest('[data-copy]');if(!t)return;
navigator.clipboard.writeText(t.dataset.copy).then(()=>{t.textContent='Copied';setTimeout(()=>t.textContent='Copy',1500)})});
</script></body></html>
`;
}
