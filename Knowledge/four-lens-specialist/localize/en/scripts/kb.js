#!/usr/bin/env node
/**
 * Knowledge-base reference query tool.
 *
 * Lets a skill/agent pull just the section it needs from lookup/ or learned/
 * markdown files instead of reading whole files into context. See
 * ../lookup/_SPEC.md for the file structure this relies on.
 *
 * Usage:
 *   node kb.js list                         list all cataloged slugs + titles
 *   node kb.js sections <slug>               list section headings (+ first line) for a slug
 *   node kb.js get <slug> <query> [--full]   print one section's body (lookup by default, learned with --full)
 *   node kb.js keytakeaways <slug>           print just the Key Takeaways section
 *   node kb.js search <keyword>              grep section headings + bodies across all lookup files
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..'; // Knowledge/localize/en
const LOOKUP_DIR = path.join(ROOT, 'lookup');
const LEARNED_DIR = path.join(ROOT, 'learned');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function listSlugs() {
  return fs.readdirSync(LOOKUP_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => f.slice(0, -3));
}

function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
      if (kv) fm[kv[1]] = kv[2];
    }
  }
  return { fm, bodyStart: m ? m[0].length : 0 };
}

// Splits markdown body into sections keyed by heading text, at a given heading level ('##' or '###'+).
function splitSections(body, level = '##') {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = null;
  const headingRe = new RegExp('^' + level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!#)\\s+(.*)$');
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function loadLookup(slug) {
  const p = path.join(LOOKUP_DIR, slug + '.md');
  if (!fs.existsSync(p)) return null;
  const text = readFile(p);
  const { fm, bodyStart } = parseFrontMatter(text);
  const body = text.slice(bodyStart);
  return { fm, sections: splitSections(body, '##'), raw: text };
}

function loadLearned(slug) {
  const p = path.join(LEARNED_DIR, slug + '.md');
  if (!fs.existsSync(p)) return null;
  const text = readFile(p);
  const { fm, bodyStart } = parseFrontMatter(text);
  const body = text.slice(bodyStart);
  // learned files use ## for top-level and ### for sub-sections; flatten both into one searchable list.
  const top = splitSections(body, '##');
  const flat = [];
  for (const sec of top) {
    const subBody = sec.lines.join('\n');
    const subs = splitSections(subBody, '###');
    if (subs.length === 0) {
      flat.push(sec);
    } else {
      // keep the parent section's lines before the first ### as its own entry, plus each ### as its own entry
      const firstSubIdx = sec.lines.findIndex(l => /^###(?!#)\s+/.test(l));
      const parentLines = firstSubIdx === -1 ? sec.lines : sec.lines.slice(0, firstSubIdx);
      flat.push({ heading: sec.heading, lines: parentLines });
      for (const sub of subs) flat.push({ heading: sec.heading + ' — ' + sub.heading, lines: sub.lines });
    }
  }
  return { fm, sections: flat, raw: text };
}

function findSection(sections, query) {
  const q = query.toLowerCase();
  let hit = sections.find(s => s.heading.toLowerCase() === q);
  if (!hit) hit = sections.find(s => s.heading.toLowerCase().includes(q));
  return hit;
}

function cmdList() {
  const slugs = listSlugs();
  if (slugs.length === 0) { console.log('(no lookup files yet)'); return; }
  for (const slug of slugs) {
    const { fm } = loadLookup(slug);
    console.log(`${slug}\t${fm.title || '(no title)'}${fm.author ? ' — ' + fm.author : ''}`);
  }
}

function cmdSections(slug) {
  const lk = loadLookup(slug);
  if (!lk) { console.error(`no lookup file for slug "${slug}". Run "list" to see valid slugs.`); process.exit(1); }
  console.log(`# ${lk.fm.title || slug}`);
  for (const s of lk.sections) {
    const firstLine = (s.lines.find(l => l.trim().length > 0) || '').trim();
    const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
    console.log(`## ${s.heading}\n   ${preview}`);
  }
}

function cmdGet(slug, query, full) {
  if (full) {
    const ln = loadLearned(slug);
    if (!ln) { console.error(`no learned file for slug "${slug}".`); process.exit(1); }
    const hit = findSection(ln.sections, query);
    if (!hit) { console.error(`no section matching "${query}" in learned/${slug}.md. Try "sections ${slug}" first.`); process.exit(1); }
    console.log(`### ${hit.heading}  (learned/${slug}.md)\n`);
    console.log(hit.lines.join('\n').trim());
  } else {
    const lk = loadLookup(slug);
    if (!lk) { console.error(`no lookup file for slug "${slug}". Run "list" to see valid slugs.`); process.exit(1); }
    const hit = findSection(lk.sections, query);
    if (!hit) { console.error(`no section matching "${query}" in lookup/${slug}.md. Try "sections ${slug}" first.`); process.exit(1); }
    console.log(`## ${hit.heading}  (lookup/${slug}.md)\n`);
    console.log(hit.lines.join('\n').trim());
    console.log(`\n(tip: add --full to pull the matching detailed section from learned/${slug}.md)`);
  }
}

function cmdKeyTakeaways(slug) {
  const lk = loadLookup(slug);
  if (!lk) { console.error(`no lookup file for slug "${slug}".`); process.exit(1); }
  const hit = lk.sections.find(s => /^key takeaways/i.test(s.heading));
  if (!hit) { console.error(`no "Key Takeaways" section found in lookup/${slug}.md.`); process.exit(1); }
  console.log(`## ${hit.heading}  (lookup/${slug}.md)\n`);
  console.log(hit.lines.join('\n').trim());
}

function cmdSearch(keyword) {
  const q = keyword.toLowerCase();
  const slugs = listSlugs();
  let hits = 0;
  for (const slug of slugs) {
    const lk = loadLookup(slug);
    for (const s of lk.sections) {
      const body = s.lines.join('\n');
      if (s.heading.toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
        hits++;
        const idx = body.toLowerCase().indexOf(q);
        const excerpt = idx === -1 ? body.trim().slice(0, 140) : body.slice(Math.max(0, idx - 60), idx + 80).replace(/\s+/g, ' ').trim();
        console.log(`${slug} § ${s.heading}\n  …${excerpt}…\n`);
      }
    }
  }
  if (hits === 0) console.log(`no matches for "${keyword}" across ${slugs.length} lookup files.`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'list': return cmdList();
    case 'sections': return cmdSections(rest[0]);
    case 'get': {
      const full = rest.includes('--full');
      const args = rest.filter(a => a !== '--full');
      return cmdGet(args[0], args.slice(1).join(' '), full);
    }
    case 'keytakeaways': return cmdKeyTakeaways(rest[0]);
    case 'search': return cmdSearch(rest.join(' '));
    default:
      console.log(__doc || '');
      console.log('Commands: list | sections <slug> | get <slug> <query> [--full] | keytakeaways <slug> | search <keyword>');
      process.exit(cmd ? 1 : 0);
  }
}

main();
