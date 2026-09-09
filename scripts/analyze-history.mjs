#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyzeHistory, renderMarkdown } from './lib/history-analysis.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, cutoff: { type: 'string' }, json: { type: 'string' },
    markdown: { type: 'string' }, notes: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: node scripts/analyze-history.mjs --root ID --cutoff ISO_WITH_TIMEZONE [--json PATH] [--markdown PATH] [--notes PATH] SNAPSHOT.json ...\n');
  } else {
    if (!values.root || !values.cutoff || !positionals.length) throw new Error('Required: --root, --cutoff, and explicit snapshot paths');
    const outputPaths = [values.json, values.markdown].filter(Boolean);
    const { resolve } = await import('node:path');
    const { realpath } = await import('node:fs/promises');
    const canonical = async path => realpath(path).catch(() => resolve(path));
    const inputs = await Promise.all([...positionals, ...[values.notes].filter(Boolean)].map(canonical));
    const outputs = await Promise.all(outputPaths.map(canonical));
    if (outputs.some(path => inputs.includes(path)) || new Set(outputs).size !== outputs.length) {
      throw new Error('Output paths must be distinct and must not overwrite inputs');
    }
    const snapshots = await Promise.all(positionals.map(async source => ({ source, document: JSON.parse(await readFile(source, 'utf8')) })));
    const notes = values.notes ? JSON.parse(await readFile(values.notes, 'utf8')) : [];
    if (!Array.isArray(notes)) throw new Error('Notes must be an array');
    const report = analyzeHistory({ rootId: values.root, cutoff: values.cutoff, snapshots, notes });
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.json) await writeFile(values.json, json);
    else process.stdout.write(json);
    if (values.markdown) await writeFile(values.markdown, renderMarkdown(report));
  }
} catch (error) {
  process.stderr.write(`analyze-history: ${error.message}\n`);
  process.exitCode = 1;
}
