#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { scanAgentNames } from './manage-agents.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const owner = 'pstack-for-codex/setup-pstack';
const prompts = {
  'pstack-poteto-agent': 'skills/poteto-mode/references/poteto-agent-prompt.md',
  'pstack-comment-sicko': 'skills/no-comments/references/comment-sicko-prompt.md',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseToml(content) {
  const result = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read()),default=lambda v:{"toml_type":type(v).__name__,"value":str(v)}))'], {
    input: content, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`TOML validation requires Python 3.11+ tomllib: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout);
}

export function replaceAgentPrompt(content, prompt, name) {
  const before = parseToml(content);
  if (before.name !== name || typeof before.description !== 'string' || !before.description.trim() || typeof before.developer_instructions !== 'string') {
    throw new Error(`invalid custom-agent identity or required fields: ${name}`);
  }
  const candidates = [...content.matchAll(/^[ \t]*(?:developer_instructions|"developer_instructions"|'developer_instructions')[ \t]*=[ \t]*/gm)];
  if (candidates.length !== 1) throw new Error('ambiguous developer_instructions assignment');
  const start = candidates[0].index + candidates[0][0].length;
  const quote = content[start];
  if (quote !== '"' && quote !== "'") throw new Error('developer_instructions must be a string');
  const delimiter = content.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  let end = start + delimiter.length;
  for (; end < content.length; end++) {
    if (quote === '"' && content[end] === '\\') { end++; continue; }
    if (content.startsWith(delimiter, end)) break;
  }
  if (end === content.length) throw new Error('unterminated prompt');
  end += delimiter.length;
  if (delimiter.length === 3) while (content[end] === quote) end++;
  const value = prompt.trim();
  if (!value) throw new Error('empty portable prompt');
  const replacement = JSON.stringify(value);
  const afterContent = content.slice(0, start) + replacement + content.slice(end);
  const after = parseToml(afterContent);
  if (after.developer_instructions !== value) throw new Error('ambiguous prompt location');
  delete before.developer_instructions;
  delete after.developer_instructions;
  if (!isDeepStrictEqual(before, after)) throw new Error('non-prompt TOML fields would change');
  return { content: afterContent, fields: after };
}

async function safePath(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`unsafe symlink: ${current}`);
      if (current === absolute && stat.isFile() && stat.nlink !== 1) throw new Error(`unsafe hard link: ${current}`);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`unsafe special file: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function snapshot(file, optional = false) {
  await safePath(file);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`expected regular file: ${file}`);
    const bytes = await fs.readFile(file);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error(`invalid UTF-8: ${file}`);
    return { file, sha256: hash(bytes), mode: stat.mode & 0o777, content };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { file, sha256: null, content: null, mode: null };
    throw error;
  }
}

export async function planPromptRefresh({ scope, projectRoot, userHome } = {}) {
  if (!['project', 'user'].includes(scope) || !path.isAbsolute(projectRoot ?? '') || !path.isAbsolute(userHome ?? '')) {
    throw new Error('explicit scope, absolute projectRoot and userHome are required');
  }
  const options = { scope, projectRoot: path.resolve(projectRoot), userHome: path.resolve(userHome) };
  const codex = path.join(scope === 'user' ? options.userHome : options.projectRoot, '.codex');
  const receiptRoot = scope === 'user' ? codex : options.projectRoot;
  const receiptFile = path.join(codex, 'pstack-for-codex-agent-receipt.json');
  const receiptSnapshot = await snapshot(receiptFile);
  const receipt = JSON.parse(receiptSnapshot.content);
  if (receipt.owner !== owner || receipt.scope !== scope || ![1, 2].includes(receipt.schema_version) || !Array.isArray(receipt.files)) {
    throw new Error('unknown receipt owner, scope or schema');
  }
  const relative = (file) => path.relative(receiptRoot, file);
  const expected = Object.keys(prompts).map((name) => relative(path.join(codex, 'agents', `${name}.toml`)));
  if (receipt.schema_version === 2) expected.push(relative(path.join(codex, 'pstack-models.json')));
  if (receipt.files.length !== expected.length || new Set(receipt.files.map((record) => record.path)).size !== expected.length || receipt.files.some((record) => !expected.includes(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256 ?? ''))) {
    throw new Error('unsafe, missing or duplicate receipt paths/hashes');
  }
  const inventory = [];
  const seen = new Set();
  for (const directory of new Set([path.join(options.projectRoot, '.codex/agents'), path.join(options.userHome, '.codex/agents')])) {
    await safePath(directory);
    const filenames = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const filename of filenames.sort().filter((file) => file.endsWith('.toml'))) {
      const item = await snapshot(path.join(directory, filename));
      const parsed = parseToml(item.content);
      if (typeof parsed.name !== 'string' || !parsed.name) throw new Error(`missing agent name: ${item.file}`);
      if (seen.has(parsed.name)) throw new Error(`duplicate custom-agent name: ${parsed.name}`);
      seen.add(parsed.name);
      inventory.push(item);
    }
  }
  const scan = await scanAgentNames(options);
  if (scan.duplicates.length && options.projectRoot !== options.userHome) throw new Error('duplicate custom-agent names');
  const registries = [];
  for (const base of new Set([options.projectRoot, options.userHome])) registries.push(await snapshot(path.join(base, '.codex/pstack-models.json'), true));
  const sources = [];
  const changes = [];
  const reconciliation = [];
  const nextReceipt = structuredClone(receipt);
  for (const record of nextReceipt.files) {
    const file = path.resolve(receiptRoot, record.path);
    const current = inventory.find((item) => item.file === file) ?? registries.find((item) => item.file === file);
    if (!current?.sha256) throw new Error(`missing receipted file: ${file}`);
    const divergent = current.sha256 !== record.sha256;
    const name = path.basename(file, '.toml');
    if (!Object.hasOwn(prompts, name)) {
      reconciliation.push({ path: record.path, action: 'preserve-record', divergent, receipt_sha256: record.sha256, current_sha256: current.sha256 });
      continue;
    }
    const source = await snapshot(path.join(pluginRoot, prompts[name]));
    sources.push(source);
    const replacement = replaceAgentPrompt(current.content, source.content, name);
    const afterSha256 = hash(replacement.content);
    reconciliation.push({ path: record.path, action: 'refresh-prompt-and-reconcile-agent', divergent, receipt_sha256: record.sha256, current_sha256: current.sha256, after_sha256: afterSha256 });
    const previousRecord = structuredClone(record);
    record.sha256 = afterSha256;
    record.prompt = prompts[name];
    if (divergent) {
      const toml = Object.fromEntries(['model', 'model_reasoning_effort', 'service_tier'].filter((key) => Object.hasOwn(replacement.fields, key)).map((key) => [key, replacement.fields[key]]));
      record.model_policy = { status: 'preserved-unverified', requested: null, resolved: null, toml };
      delete record.capability;
    }
    if (divergent || current.sha256 !== afterSha256 || record.prompt_refresh?.source_sha256 !== source.sha256) {
      delete previousRecord.prompt_refresh;
      record.prompt_refresh = { previous_record: previousRecord, before_sha256: current.sha256, source_sha256: source.sha256, configuration_status: 'preserved-without-runtime-validation' };
    }
    changes.push({ ...current, after: replacement.content, after_sha256: afterSha256, diff: `--- ${file}\n+++ ${file}\n@@ complete file @@\n${current.content.split('\n').map((line) => `-${line}`).join('\n')}\n${replacement.content.split('\n').map((line) => `+${line}`).join('\n')}\n` });
  }
  const after = isDeepStrictEqual(nextReceipt, receipt) ? receiptSnapshot.content : json(nextReceipt);
  changes.push({ ...receiptSnapshot, after, after_sha256: hash(after) });
  return { schema_version: 1, operation: 'pstack-prompt-refresh', options, inventory, registries, sources, reconciliation, changes, expected_receipt: nextReceipt };
}

export const promptRefreshPlanHash = (plan) => hash(json(plan));

export async function applyPromptRefresh(plan, { expectedPlanHash } = {}) {
  if (!expectedPlanHash || promptRefreshPlanHash(plan) !== expectedPlanHash) throw new Error('reviewed plan hash does not match');
  const fresh = await planPromptRefresh(plan.options);
  if (!isDeepStrictEqual(fresh, plan)) throw new Error('stale or altered prompt refresh plan; review a new plan');
  const codex = path.dirname(plan.changes.at(-1).file);
  const backupRoot = path.join(codex, 'pstack-prompt-refresh-backups');
  await safePath(backupRoot);
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = await fs.mkdtemp(path.join(backupRoot, 'refresh-'));
  const written = [];
  try {
    await fs.writeFile(path.join(backup, 'plan.json'), json(plan), { flag: 'wx', mode: 0o600 });
    for (const [index, change] of plan.changes.entries()) await fs.writeFile(path.join(backup, `${index}.before`), change.content, { flag: 'wx', mode: 0o600 });
    if (!isDeepStrictEqual(await planPromptRefresh(plan.options), plan)) throw new Error('stale plan after backup');
    for (const change of plan.changes) {
      if (!isDeepStrictEqual(await snapshot(change.file), { file: change.file, sha256: change.sha256, mode: change.mode, content: change.content })) throw new Error(`stale file: ${change.file}`);
      const staged = path.join(path.dirname(change.file), `.pstack-refresh-${path.basename(backup)}-${path.basename(change.file)}`);
      let stagedCreated = false;
      try {
        await fs.writeFile(staged, change.after, { flag: 'wx', mode: change.mode });
        stagedCreated = true;
        await fs.chmod(staged, change.mode);
        await safePath(change.file);
        if ((await snapshot(change.file)).sha256 !== change.sha256) throw new Error(`stale file: ${change.file}`);
        await fs.rename(staged, change.file);
        written.push(change);
      } finally { if (stagedCreated) await fs.rm(staged, { force: true }); }
    }
    const finalInventory = (await planPromptRefresh(plan.options)).inventory;
    const expectedInventory = plan.inventory.map((item) => {
      const change = plan.changes.find((candidate) => candidate.file === item.file);
      return change ? { file: item.file, sha256: change.after_sha256, mode: item.mode, content: change.after } : item;
    });
    if (!isDeepStrictEqual(finalInventory, expectedInventory)) throw new Error('concurrent agent inventory change');
    for (const item of [...plan.registries, ...plan.sources]) if (!isDeepStrictEqual(await snapshot(item.file, true), item)) throw new Error(`concurrent change: ${item.file}`);
    for (const change of plan.changes) if ((await snapshot(change.file)).sha256 !== change.after_sha256) throw new Error(`concurrent change: ${change.file}`);
    return { status: 'refreshed', backup, plan_sha256: expectedPlanHash, reconciliation: plan.reconciliation };
  } catch (error) {
    const restoreErrors = [];
    for (const change of written.reverse()) {
      try {
        if ((await snapshot(change.file)).sha256 !== change.after_sha256) throw new Error('concurrent edit preserved');
        await fs.writeFile(change.file, change.content, { mode: change.mode });
      } catch (restoreError) { restoreErrors.push(`${change.file}: ${restoreError.message}`); }
    }
    throw new Error(`${error.message}; backup: ${backup}; ${restoreErrors.length ? `manual restore required: ${restoreErrors.join('; ')}` : 'written files restored'}`);
  }
}

async function main(args) {
  const [action, ...rest] = args;
  const options = {};
  const allowed = action === 'plan' ? ['--scope', '--project-root', '--user-home', '--plan'] : ['--plan', '--expected-plan-hash'];
  for (let index = 0; index < rest.length; index += 2) {
    if (!allowed.includes(rest[index]) || rest[index + 1] === undefined || Object.hasOwn(options, rest[index])) throw new Error('invalid or duplicate CLI option');
    options[rest[index]] = rest[index + 1];
  }
  if (action === 'plan') {
    const plan = await planPromptRefresh({ scope: options['--scope'], projectRoot: options['--project-root'], userHome: options['--user-home'] });
    if (!options['--plan']) throw new Error('--plan output file is required');
    await safePath(options['--plan']);
    await fs.writeFile(options['--plan'], json(plan), { flag: 'wx', mode: 0o600 });
    process.stdout.write(json({ plan_sha256: promptRefreshPlanHash(plan), plan }));
  } else if (action === 'apply') {
    const plan = JSON.parse(await fs.readFile(options['--plan'], 'utf8'));
    process.stdout.write(json(await applyPromptRefresh(plan, { expectedPlanHash: options['--expected-plan-hash'] })));
  } else throw new Error('usage: refresh-agent-prompts.mjs plan --scope project|user --project-root /repo --user-home /home --plan /new-plan.json | apply --plan /plan.json --expected-plan-hash SHA256');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
