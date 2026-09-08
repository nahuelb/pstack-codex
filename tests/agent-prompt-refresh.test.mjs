import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installAgents } from '../skills/setup-pstack/scripts/manage-agents.mjs';
import { planPromptRefresh, applyPromptRefresh, promptRefreshPlanHash, replaceAgentPrompt } from '../skills/setup-pstack/scripts/refresh-agent-prompts.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t, scope = 'user') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'prompt-refresh-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { projectRoot: path.join(directory, 'repo'), userHome: path.join(directory, 'home'), scope };
  await fs.mkdir(options.projectRoot);
  await fs.mkdir(options.userHome);
  await installAgents({ ...options, pluginRoot });
  const codex = path.join(scope === 'user' ? options.userHome : options.projectRoot, '.codex');
  const agent = path.join(codex, 'agents/pstack-poteto-agent.toml');
  const original = `# custom configuration\nname = 'pstack-poteto-agent'\ndescription = 'local description'\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = 'medium'\nsandbox_mode = 'workspace-write'\nservice_tier = 'priority'\ndeveloper_instructions = '''old prompt''' # keep this\n[extra]\nflag = true\nvalue = 1979-05-27T07:32:00Z\n`;
  await fs.writeFile(agent, original);
  return { options, codex, agent, original, receipt: path.join(codex, 'pstack-for-codex-agent-receipt.json'), registry: path.join(codex, 'pstack-models.json') };
}
const apply = (plan) => applyPromptRefresh(plan, { expectedPlanHash: promptRefreshPlanHash(plan) });

for (const scope of ['user', 'project']) test(`${scope} refresh preserves non-prompt bytes and divergent registry ownership`, async (t) => {
  const f = await fixture(t, scope);
  const registry = `${await fs.readFile(f.registry, 'utf8')} \n`;
  await fs.writeFile(f.registry, registry);
  const prior = JSON.parse(await fs.readFile(f.receipt, 'utf8'));
  const plan = await planPromptRefresh(f.options);
  assert.equal(await fs.readFile(f.agent, 'utf8'), f.original);
  assert.equal(plan.reconciliation.find((item) => item.path.endsWith('pstack-models.json')).divergent, true);
  const result = await apply(plan);
  const updated = await fs.readFile(f.agent, 'utf8');
  const source = await fs.readFile(path.join(pluginRoot, 'skills/poteto-mode/references/poteto-agent-prompt.md'), 'utf8');
  assert.equal(updated, f.original.replace("'''old prompt'''", JSON.stringify(source.trim())));
  assert.equal(await fs.readFile(f.registry, 'utf8'), registry);
  const receipt = JSON.parse(await fs.readFile(f.receipt, 'utf8'));
  assert.deepEqual(receipt.files.find((item) => item.kind === 'model-role-registry'), prior.files.find((item) => item.kind === 'model-role-registry'));
  assert.deepEqual(receipt.role_policies, prior.role_policies);
  const record = receipt.files.find((item) => item.path.endsWith('pstack-poteto-agent.toml'));
  assert.equal(record.model_policy.status, 'preserved-unverified');
  assert.equal(record.model_policy.toml.model, 'gpt-6-astra');
  assert.equal(record.model_policy.toml.model_reasoning_effort, 'medium');
  assert.equal(record.model_policy.resolved, null);
  assert.equal(record.capability, undefined);
  assert.deepEqual(record.prompt_refresh.previous_record, prior.files.find((item) => item.path === record.path));
  assert.equal(record.sha256, plan.changes.find((item) => item.file === f.agent).after_sha256);
  assert.equal(await fs.readFile(path.join(result.backup, '0.before'), 'utf8'), f.original);
  assert.equal((await fs.stat(f.agent)).mode & 0o777, plan.changes[0].mode);
});

for (const target of ['agent', 'registry', 'receipt']) test(`refuses stale ${target} without mutation`, async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  await fs.appendFile(f[target], ' \n');
  const before = await Promise.all(plan.changes.map((item) => fs.readFile(item.file, 'utf8')));
  await assert.rejects(apply(plan), /stale/);
  assert.deepEqual(await Promise.all(plan.changes.map((item) => fs.readFile(item.file, 'utf8'))), before);
});

test('refuses altered plans, absent review hash, and new duplicate names', async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  await assert.rejects(applyPromptRefresh(plan), /reviewed plan hash/);
  const altered = structuredClone(plan);
  altered.changes[0].after += '\nmodel = "other"';
  await assert.rejects(apply(altered), /stale or altered/);
  await fs.mkdir(path.join(f.options.projectRoot, '.codex/agents'), { recursive: true });
  await fs.writeFile(path.join(f.options.projectRoot, '.codex/agents/local.toml'), '"name" = "pstack-poteto-agent"\n');
  await assert.rejects(apply(plan), /duplicate/);
});

test('rejects unsafe receipt paths and unknown owners', async (t) => {
  const f = await fixture(t);
  const receipt = JSON.parse(await fs.readFile(f.receipt, 'utf8'));
  for (const value of ['../outside.toml', '/tmp/outside.toml', 'agents/other.toml']) {
    const changed = structuredClone(receipt);
    changed.files[0].path = value;
    await fs.writeFile(f.receipt, JSON.stringify(changed));
    await assert.rejects(planPromptRefresh(f.options), /receipt paths/);
  }
  receipt.owner = 'another-owner';
  await fs.writeFile(f.receipt, JSON.stringify(receipt));
  await assert.rejects(planPromptRefresh(f.options), /owner/);
});

for (const kind of ['symlink', 'hardlink']) test(`rejects ${kind} agent paths`, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.options.userHome, 'outside');
  await fs.rename(f.agent, outside);
  if (kind === 'symlink') await fs.symlink(outside, f.agent);
  else await fs.link(outside, f.agent);
  await assert.rejects(planPromptRefresh(f.options), /unsafe/);
  assert.equal(await fs.readFile(outside, 'utf8'), f.original);
});

test('rejects symlink directory ancestors', async (t) => {
  const f = await fixture(t);
  const moved = `${f.codex}-moved`;
  await fs.rename(f.codex, moved);
  await fs.symlink(moved, f.codex);
  await assert.rejects(planPromptRefresh(f.options), /unsafe symlink/);
});

test('rejects invalid, nested, duplicate or ambiguous prompt assignments', () => {
  const header = 'name = "pstack-poteto-agent"\ndescription = "d"\n';
  for (const suffix of [
    'developer_instructions = "old"\ndeveloper_instructions = "again"\n',
    '[nested]\ndeveloper_instructions = "old"\n',
    'developer_instructions = """\ndeveloper_instructions = \'bait\'\n"""\n',
    'developer_instructions = 42\n',
    'developer_instructions = "unfinished\n',
  ]) assert.throws(() => replaceAgentPrompt(header + suffix, 'new', 'pstack-poteto-agent'));
  assert.throws(() => replaceAgentPrompt(header + 'developer_instructions = "old"', 'new', 'pstack-comment-sicko'), /identity/);
});

test('escapes portable text without changing other fields', () => {
  const before = 'name="pstack-poteto-agent"\ndescription="d"\n"developer_instructions" = "old"\n[extra]\ns = "keep"\n';
  const prompt = 'quote """ and \'\'\' and \\path\nnew line\t tab\b\f';
  const result = replaceAgentPrompt(before, prompt, 'pstack-poteto-agent');
  assert.deepEqual(result.fields, { name: 'pstack-poteto-agent', description: 'd', extra: { s: 'keep' } });
  assert.ok(result.content.endsWith('[extra]\ns = "keep"\n'));
});

test('restores all written files and receipt after a write failure, with backups', async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  const rename = fs.rename.bind(fs);
  let calls = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (++calls === 3) throw new Error('injected receipt failure');
    return rename(...args);
  });
  await assert.rejects(apply(plan), /injected receipt failure.*written files restored/);
  for (const change of plan.changes) assert.equal(await fs.readFile(change.file, 'utf8'), change.content);
  const backups = await fs.readdir(path.join(f.codex, 'pstack-prompt-refresh-backups'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.codex, 'pstack-prompt-refresh-backups', backups[0], '2.before'), 'utf8'), plan.changes[2].content);
});

test('rollback preserves a concurrent edit and reports manual recovery', async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  const rename = fs.rename.bind(fs);
  let calls = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (++calls === 2) {
      await fs.writeFile(f.agent, 'concurrent user edit');
      throw new Error('injected failure');
    }
    return rename(...args);
  });
  await assert.rejects(apply(plan), /manual restore required.*concurrent edit preserved/);
  assert.equal(await fs.readFile(f.agent, 'utf8'), 'concurrent user edit');
  assert.equal(await fs.readFile(f.receipt, 'utf8'), plan.changes[2].content);
});

test('repeat refresh is stable and does not nest receipt history', async (t) => {
  const f = await fixture(t);
  await apply(await planPromptRefresh(f.options));
  const before = await fs.readFile(f.receipt, 'utf8');
  const plan = await planPromptRefresh(f.options);
  assert.equal(plan.changes.at(-1).after, before);
  await apply(plan);
  assert.equal(await fs.readFile(f.receipt, 'utf8'), before);
});

test('refuses a changed shipped source against the reviewed plan', async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    const value = await read(file, ...args);
    if (file === plan.sources[0].file) return Buffer.concat([Buffer.from(value), Buffer.from('\nchanged source\n')]);
    return value;
  });
  await assert.rejects(apply(plan), /stale/);
  assert.equal(await fs.readFile(f.agent, 'utf8'), f.original);
});

test('supports literal backslash sequences in prompts', () => {
  const before = 'name="pstack-poteto-agent"\ndescription="d"\ndeveloper_instructions="old"\n';
  assert.doesNotThrow(() => replaceAgentPrompt(before, String.raw`\bin\file\new\tab`, 'pstack-poteto-agent'));
});

test('backs up successfully before any rename', async (t) => {
  const f = await fixture(t);
  const plan = await planPromptRefresh(f.options);
  const write = fs.writeFile.bind(fs);
  let renamed = false;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (file.endsWith('2.before')) throw new Error('backup failed');
    return write(file, ...args);
  });
  t.mock.method(fs, 'rename', async () => { renamed = true; });
  await assert.rejects(apply(plan), /backup failed/);
  assert.equal(renamed, false);
  for (const item of plan.changes) assert.equal(await fs.readFile(item.file, 'utf8'), item.content);
});

test('CLI writes a reviewable plan and applies only its supplied hash', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const f = await fixture(t);
  const script = path.join(pluginRoot, 'skills/setup-pstack/scripts/refresh-agent-prompts.mjs');
  const planFile = path.join(f.options.userHome, 'review.json');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const result = run('plan', '--scope', 'user', '--project-root', f.options.projectRoot, '--user-home', f.options.userHome, '--plan', planFile);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.plan_sha256, promptRefreshPlanHash(JSON.parse(await fs.readFile(planFile, 'utf8'))));
  assert.equal(await fs.readFile(f.agent, 'utf8'), f.original);
  const rejected = run('apply', '--plan', planFile, '--expected-plan-hash', '0'.repeat(64));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /reviewed plan hash/);
  const applied = run('apply', '--plan', planFile, '--expected-plan-hash', output.plan_sha256);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, 'refreshed');
});
