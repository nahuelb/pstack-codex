#!/usr/bin/env node
import { readFile, writeFile, realpath, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { auditUsage, usageTopology, renderUsageMarkdown } from './lib/usage-audit.mjs';

const execute = promisify(execFile);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, cutoff: { type: 'string' }, since: { type: 'string' },
    history: { type: 'string', multiple: true }, roles: { type: 'string' },
    model: { type: 'string' }, provider: { type: 'string' }, live: { type: 'boolean' },
    limit: { type: 'string', default: '1000' }, json: { type: 'string' }, markdown: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('Usage: node scripts/audit-usage.mjs --root ID --cutoff ISO [--since ISO] [--history EXPORT.json] [--roles BINDINGS.json] [--model ID] [--provider NAME] [--live --limit 1000] [--json NEW_PATH] [--markdown NEW_PATH] LOGS.json ...\n');
  } else {
    if (!values.root || !values.cutoff || (!values.live && !positionals.length)) throw new Error('Required: --root, --cutoff, and explicit log exports or --live');
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('--limit must be between 1 and 2000');
    const inputPaths = [...positionals, ...(values.history ?? []), ...[values.roles].filter(Boolean)];
    const inputs = await Promise.all(inputPaths.map(p => realpath(p)));
    const outputs = [values.json, values.markdown].filter(Boolean).map(p => resolve(p));
    if (new Set(outputs).size !== outputs.length || outputs.some(p => inputs.includes(p))) throw new Error('Output paths must be distinct from inputs and each other');
    for (const output of outputs) {
      const exists = await access(output).then(() => true, () => false);
      if (exists) throw new Error('Output already exists; choose a new report path');
    }
    const read = async source => ({ source, document: JSON.parse(await readFile(source, 'utf8')) });
    const snapshots = await Promise.all((values.history ?? []).map(read));
    const logs = await Promise.all(positionals.map(read));
    const roleBindings = values.roles ? JSON.parse(await readFile(values.roles, 'utf8')) : [];
    const topology = usageTopology({ rootId: values.root, cutoff: values.cutoff, snapshots });
    let runtime = null;
    if (values.live) {
      const run = async args => {
        try { return (await execute('opencodex', args, { timeout: 20000, maxBuffer: 32 * 1024 * 1024 })).stdout; }
        catch { throw new Error('OpenCodex read-only command failed; check the active CLI and running proxy. No configuration was changed.'); }
      };
      const version = (await run(['--version'])).trim();
      if (!/^opencodex \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Unrecognized active OpenCodex version response');
      runtime = { version, interface: 'opencodex logs --json --conversation ID --limit N', limit };
      const parents = new Map(topology.edges.filter(e => e.cutoffPlacement === 'before').map(e => [e.to, e.from]));
      const groups = new Set([values.root]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, parent] of parents) if (groups.has(parent) && !groups.has(id)) { groups.add(id); changed = true; }
      }
      if (groups.size > 128) throw new Error('More than 128 bound threads; supply explicit supported log exports for this audit');
      for (const id of groups) {
        const document = JSON.parse(await run(['logs', '--json', '--conversation', id, '--limit', String(limit)]));
        logs.push({ source: `opencodex logs; conversation=${id}; limit=${limit}`, document });
      }
    }
    const report = auditUsage({ rootId: values.root, cutoff: values.cutoff, since: values.since,
      topology, logs, roleBindings, model: values.model, provider: values.provider });
    if (runtime) report.runtime = runtime;
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.json) await writeFile(values.json, json, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(json);
    if (values.markdown) await writeFile(values.markdown, renderUsageMarkdown(report), { flag: 'wx', mode: 0o600 });
  }
} catch (error) {
  process.stderr.write(`audit-usage: ${error instanceof SyntaxError ? 'Invalid JSON input' : error.message}\n`);
  process.exitCode = 1;
}
