#!/usr/bin/env node
// Usage:
//   lazylead [--config lazylead.config.json] [--save-snapshot file] [--from-snapshot file] [--facts-only]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGitHub } from '../src/github.js';
import { collect } from '../src/collect.js';
import { computeFacts } from '../src/facts.js';
import { createOllama } from '../src/llm.js';
import { buildBrief } from '../src/brief.js';
import { toMarkdown, toHtml } from '../src/render.js';

const { values: args } = parseArgs({
  options: {
    config: { type: 'string', default: 'lazylead.config.json' },
    'save-snapshot': { type: 'string' },
    'from-snapshot': { type: 'string' },
    'facts-only': { type: 'boolean', default: false },
  },
});

const log = (msg) => console.error(`[lazylead ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const config = JSON.parse(readFileSync(args.config, 'utf8'));

let snapshot;
if (args['from-snapshot']) {
  snapshot = JSON.parse(readFileSync(args['from-snapshot'], 'utf8'));
} else {
  const token = (process.env.GITHUB_TOKEN || readFileSync(config.tokenFile, 'utf8')).trim();
  log(`collecting ${config.repos.join(', ')}`);
  snapshot = await collect(createGitHub(token), { repos: config.repos, windowHours: config.windowHours ?? 24 });
  if (args['save-snapshot']) writeFileSync(args['save-snapshot'], JSON.stringify(snapshot, null, 2));
}

const facts = computeFacts(snapshot, { team: config.team ?? [], staleHours: config.staleHours ?? 24 });
if (args['facts-only']) {
  console.log(JSON.stringify(facts, null, 2));
  process.exit(0);
}

log(`${facts.threads.length} threads, ${facts.waiting.length} pending reviews; asking ${config.ollama.model}`);
let llm = createOllama(config.ollama);
if (!(await llm.ready())) {
  log(`${config.ollama.model} is not available at ${config.ollama.url}; writing a facts-only brief`);
  llm = null;
}
const brief = await buildBrief(facts, { llm, team: config.team ?? [], lead: config.lead, log });

const outDir = config.outDir ?? './briefs';
mkdirSync(outDir, { recursive: true });
const name = snapshot.generatedAt.slice(0, 10);
writeFileSync(join(outDir, `${name}.md`), toMarkdown(brief));
writeFileSync(join(outDir, `${name}.html`), toHtml(brief));
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(brief, null, 2));
writeFileSync(join(outDir, 'latest.html'), toHtml(brief));
log(`done in ${(brief.llmStats.ms / 1000).toFixed(0)}s of model time → ${join(outDir, name)}.{md,html,json}`);
