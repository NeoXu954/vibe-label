import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeRepository } from '../plugins/vibe-label/skills/vibe-label/scripts/lib/analyze.mjs';
import { parseNameStatusZ, parseNumstatZ } from '../plugins/vibe-label/skills/vibe-label/scripts/lib/git.mjs';
import { renderHtml } from '../plugins/vibe-label/skills/vibe-label/scripts/lib/render.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-label-test-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'VibeLabel Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commitAll(root, message = 'fixture') {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

test('parses NUL-delimited status and numstat records, including renames and binary files', () => {
  assert.deepEqual(parseNameStatusZ('M\0src/a.ts\0R100\0old.ts\0new.ts\0'), [
    { status: 'M', path: 'src/a.ts' },
    { status: 'R', score: 100, previousPath: 'old.ts', path: 'new.ts' },
  ]);
  assert.deepEqual(parseNumstatZ('3\t1\tsrc/a.ts\0-\t-\timage.png\0 0\t0\t\0old.ts\0new.ts\0'.replace(' 0', '0')), [
    { path: 'src/a.ts', previousPath: undefined, additions: 3, deletions: 1 },
    { path: 'image.png', previousPath: undefined, additions: null, deletions: null },
    { path: 'new.ts', previousPath: 'old.ts', additions: 0, deletions: 0 },
  ]);
});

test('default current scope includes staged, unstaged, and untracked changes', () => {
  const root = makeRepository();
  write(root, 'src/app.ts', 'export const value = 1;\n');
  commitAll(root);

  write(root, 'src/app.ts', 'export const value = 1;\nexport const staged = 2;\n');
  git(root, ['add', 'src/app.ts']);
  write(root, 'src/app.ts', 'export const value = 1;\nexport const staged = 2;\nexport const unstaged = 3;\n');
  write(root, 'src/new.ts', 'export const untracked = true;\n');

  const current = analyzeRepository({ repository: root, mode: 'current' }).report;
  const staged = analyzeRepository({ repository: root, mode: 'staged' }).report;
  const unstaged = analyzeRepository({ repository: root, mode: 'unstaged' }).report;

  assert.equal(current.summary.files.total, 2);
  assert.equal(current.summary.lines.additions, 3);
  assert.deepEqual(current.selection.includes, { committed: false, staged: true, unstaged: true, untracked: true });
  assert.equal(staged.summary.files.total, 1);
  assert.equal(staged.summary.lines.additions, 1);
  assert.equal(unstaged.summary.files.total, 2);
  assert.equal(unstaged.summary.lines.additions, 2);
});

test('reports factual attention areas and added-line patterns without source snippets', () => {
  const root = makeRepository();
  write(root, 'src/index.ts', 'export const ready = true;\n');
  commitAll(root);
  const secret = `ghp_${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'}${'123456'}`;
  write(root, 'src/auth/session.ts', [
    '// TODO rotate the test token',
    `const access_token = "${secret}";`,
    'console.log("debug");',
    'export const session = process.env.SESSION_SECRET;',
    '',
  ].join('\n'));
  write(root, 'src/auth/session.test.ts', 'test.only("session", () => {});\n');
  write(root, '.env', `API_KEY="${secret}"\n`);

  const report = analyzeRepository({ repository: root }).report;
  const serialized = JSON.stringify(report);
  assert.ok(report.attentionAreas.some((item) => item.ruleId === 'authentication'));
  assert.ok(report.attentionAreas.some((item) => item.ruleId === 'secrets-environment'));
  assert.ok(report.patternsOnAddedLines.some((item) => item.ruleId === 'maintenance-marker'));
  assert.ok(report.patternsOnAddedLines.some((item) => item.ruleId === 'test-control'));
  assert.ok(report.privacy.possibleSecretsMatched >= 2);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('rotate the test token'), false);
  assert.equal(report.tests.files, 1);
  assert.equal(report.tests.additions, 1);
});

test('compares direct package declarations without counting version changes as new packages', () => {
  const root = makeRepository();
  write(root, 'package.json', JSON.stringify({ dependencies: { alpha: '^1.0.0' } }, null, 2));
  commitAll(root);
  write(root, 'package.json', JSON.stringify({
    dependencies: {
      alpha: '^2.0.0',
      gamma: 'git+https://user:private-token@example.invalid/org/gamma.git#main',
    },
    devDependencies: { beta: '^1.0.0' },
  }, null, 2));
  write(root, 'package-lock.json', '{}\n');

  const report = analyzeRepository({ repository: root }).report;
  assert.deepEqual(report.dependencies.direct.added.map((item) => item.name), ['beta', 'gamma']);
  assert.deepEqual(report.dependencies.direct.changed.map((item) => item.name), ['alpha']);
  assert.equal(report.dependencies.direct.removed.length, 0);
  assert.deepEqual(report.dependencies.lockfilesTouched, ['package-lock.json']);
  const gamma = report.dependencies.direct.added.find((item) => item.name === 'gamma');
  assert.equal(gamma.after[0].spec, '[remote-url]');
  assert.equal(JSON.stringify(report).includes('private-token'), false);
});

test('base scope excludes dirty worktree changes', () => {
  const root = makeRepository();
  write(root, 'src/app.ts', 'line one\n');
  commitAll(root, 'base');
  write(root, 'src/app.ts', 'line one\ncommitted line\n');
  commitAll(root, 'feature');
  write(root, 'src/app.ts', 'line one\ncommitted line\ndirty line\n');

  const report = analyzeRepository({ repository: root, mode: 'base', baseRef: 'HEAD~1' }).report;
  assert.equal(report.summary.lines.additions, 1);
  assert.equal(report.selection.includes.committed, true);
  assert.equal(report.selection.includes.unstaged, false);
});

test('keeps binary line counts unknown instead of reporting zero', () => {
  const root = makeRepository();
  write(root, 'README.md', '# Fixture\n');
  commitAll(root);
  write(root, 'assets/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

  const report = analyzeRepository({ repository: root }).report;
  const image = report.files.find((file) => file.path === 'assets/image.png');
  assert.equal(image.binary, true);
  assert.deepEqual(image.lines, { additions: null, deletions: null, churn: null });
  assert.equal(report.summary.lines.filesWithoutNumericStats, 1);
});

test('renders a self-contained local HTML label without absolute repository paths', () => {
  const root = makeRepository();
  git(root, ['checkout', '-b', 'private-topic-branch']);
  write(root, 'src/app.ts', 'export const value = 1;\n');
  const report = analyzeRepository({ repository: root }).report;
  const html = renderHtml(report, { mode: 'safe' });
  const detailed = renderHtml(report, { mode: 'detailed' });
  assert.match(html, /Download PNG/);
  assert.match(html, /LOCAL ANALYSIS/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.equal(html.includes(root), false);
  assert.equal(html.includes(path.basename(root)), false);
  assert.equal(html.includes('private-topic-branch'), false);
  assert.equal(detailed.includes(path.basename(root)), true);
  assert.equal(detailed.includes('private-topic-branch'), true);
  assert.equal(html.includes('−0'), false);
  assert.equal(html.includes('source code uploaded'), false);
});

test('safe base labels omit the base ref', () => {
  const root = makeRepository();
  write(root, 'src/app.ts', 'base\n');
  commitAll(root, 'base');
  git(root, ['branch', 'private-customer-release']);
  write(root, 'src/app.ts', 'base\nfeature\n');
  commitAll(root, 'feature');
  const report = analyzeRepository({ repository: root, mode: 'base', baseRef: 'private-customer-release' }).report;
  assert.equal(renderHtml(report, { mode: 'safe' }).includes('private-customer-release'), false);
  assert.equal(renderHtml(report, { mode: 'detailed' }).includes('private-customer-release'), true);
});

test('CLI writes report and HTML to an explicit output directory', () => {
  const root = makeRepository();
  const output = path.join(root, 'label-output');
  write(root, 'src/app.ts', 'export const value = 1;\n');
  const cli = path.resolve('plugins/vibe-label/skills/vibe-label/scripts/vibe-label.mjs');
  execFileSync(process.execPath, [cli, '--repo', root, '--output', output], { encoding: 'utf8' });
  const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
  const html = readFileSync(path.join(output, 'index.html'), 'utf8');
  const detailed = readFileSync(path.join(output, 'detailed.html'), 'utf8');
  assert.equal(report.summary.files.total, 1);
  assert.match(html, /VIBELABEL/);
  assert.match(detailed, /DETAILED MODE/);
  if (process.platform !== 'win32') assert.equal(statSync(path.join(output, 'report.json')).mode & 0o777, 0o600);
});

test('CLI JSON output stays machine-readable when verification commands run', () => {
  const root = makeRepository();
  write(root, 'src/app.ts', 'export const value = 1;\n');
  const cli = path.resolve('plugins/vibe-label/skills/vibe-label/scripts/vibe-label.mjs');
  const stdout = execFileSync(process.execPath, [
    cli,
    '--repo', root,
    '--check', `BUILD=${process.execPath} --version`,
    '--json',
  ], { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  assert.equal(report.verification.results[0].label, 'BUILD');
  assert.equal(report.verification.results[0].status, 'passed');
});

test('CLI executes through a package-style symlink', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vibe-label-bin-'));
  const cli = path.resolve('plugins/vibe-label/skills/vibe-label/scripts/vibe-label.mjs');
  const link = path.join(directory, 'vibe-label');
  symlinkSync(cli, link);
  const stdout = execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
  const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(stdout.trim(), packageManifest.version);
});

test('npm, Codex, and Claude manifests stay version-aligned', () => {
  const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const codexManifest = JSON.parse(readFileSync('plugins/vibe-label/.codex-plugin/plugin.json', 'utf8'));
  const claudeManifest = JSON.parse(readFileSync('plugins/vibe-label/.claude-plugin/plugin.json', 'utf8'));
  assert.equal(codexManifest.version, packageManifest.version);
  assert.equal(claudeManifest.version, packageManifest.version);
  assert.ok(Array.isArray(codexManifest.interface.defaultPrompt));
  assert.ok(codexManifest.interface.defaultPrompt.length <= 3);
});
