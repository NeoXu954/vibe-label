#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { analyzeRepository, refreshFingerprint } from './lib/analyze.mjs';
import { VibeLabelError, findRepositoryRoot } from './lib/git.mjs';
import { renderHtml } from './lib/render.mjs';

const VERSION = '0.1.0';

function usage() {
  return `VibeLabel ${VERSION}

Generate a factual, local code-change label from a Git diff.

Usage:
  vibe-label [options]

Scope options (choose one):
  --current            HEAD to worktree, including staged, unstaged, and untracked (default)
  --staged             HEAD to index only
  --unstaged           Index to worktree, including untracked
  --base <ref>         Merge-base(ref, HEAD) to HEAD only

Other options:
  --repo <path>        Repository to analyze (default: current directory)
  --output <path>      Output directory (default: a temporary local directory)
  --check <L=C>        Run a verification command before analysis, e.g. BUILD=npm run build
                       Labels BUILD, TEST, and TYPES appear on the share card; repeatable
  --check-timeout <ms> Timeout per check (default: 120000)
  --open               Open the generated HTML in the default browser
  --json               Print the machine report to stdout
  --help               Show this help
  --version            Print the version

VibeLabel stores no source snippets, sends no network requests, and assigns no score or grade.`;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new VibeLabelError('E_ARGUMENT', `${flag} requires a value.`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    mode: 'current',
    repository: process.cwd(),
    checks: [],
    checkTimeout: 120_000,
    open: false,
    printJson: false,
  };
  let scopeSeen = false;
  const setScope = (mode, baseRef) => {
    if (scopeSeen) throw new VibeLabelError('E_ARGUMENT', 'Choose only one scope option.');
    scopeSeen = true;
    options.mode = mode;
    options.baseRef = baseRef;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current') setScope('current');
    else if (arg === '--staged') setScope('staged');
    else if (arg === '--unstaged') setScope('unstaged');
    else if (arg === '--base') {
      const value = takeValue(argv, index, arg);
      setScope('base', value);
      index += 1;
    } else if (arg === '--repo') {
      options.repository = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--output') {
      options.output = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--check') {
      const value = takeValue(argv, index, arg);
      const separator = value.indexOf('=');
      if (separator < 1 || separator === value.length - 1) {
        throw new VibeLabelError('E_ARGUMENT', '--check must use LABEL=COMMAND, for example BUILD=npm run build.');
      }
      options.checks.push({
        label: value.slice(0, separator).trim().toUpperCase(),
        command: value.slice(separator + 1).trim(),
      });
      index += 1;
    } else if (arg === '--check-timeout') {
      const value = Number(takeValue(argv, index, arg));
      if (!Number.isFinite(value) || value < 1000 || value > 1_800_000) {
        throw new VibeLabelError('E_ARGUMENT', '--check-timeout must be between 1000 and 1800000 milliseconds.');
      }
      options.checkTimeout = value;
      index += 1;
    } else if (arg === '--open') options.open = true;
    else if (arg === '--json') options.printJson = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else throw new VibeLabelError('E_ARGUMENT', `Unknown option: ${arg}`);
  }
  return options;
}

function runChecks(root, checks, timeout, quiet = false) {
  return checks.map((check) => {
    const started = performance.now();
    const result = spawnSync(check.command, {
      cwd: root,
      env: { ...process.env, CI: process.env.CI ?? '1' },
      encoding: 'utf8',
      shell: true,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      timeout,
    });
    const durationMs = Math.round(performance.now() - started);
    const timedOut = result.signal === 'SIGTERM' && result.status === null;
    return {
      label: check.label,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      timedOut,
      durationMs,
    };
  });
}

function openFile(filePath) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function writeOutputs(root, report, requestedOutput) {
  const output = path.resolve(requestedOutput ?? path.join(os.tmpdir(), 'vibe-label', report.fingerprint.value.slice(0, 12)));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const reportPath = path.join(output, 'report.json');
  const htmlPath = path.join(output, 'index.html');
  const detailedHtmlPath = path.join(output, 'detailed.html');
  const writeOptions = { encoding: 'utf8', mode: 0o600 };
  const writePrivate = (filePath, content) => {
    writeFileSync(filePath, content, writeOptions);
    if (process.platform !== 'win32') chmodSync(filePath, 0o600);
  };
  writePrivate(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writePrivate(htmlPath, renderHtml(report, { mode: 'safe' }));
  writePrivate(detailedHtmlPath, renderHtml(report, { mode: 'detailed' }));
  return { output, reportPath, htmlPath, detailedHtmlPath, root };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }

  const root = findRepositoryRoot(path.resolve(options.repository));
  const verification = runChecks(root, options.checks, options.checkTimeout, options.printJson);
  const analyzed = analyzeRepository({ repository: root, mode: options.mode, baseRef: options.baseRef });
  analyzed.report.verification.results = verification;
  if (verification.length > 0) analyzed.report.tests.execution = verification.some((item) => item.label === 'TEST') ? 'run' : 'not-run';
  refreshFingerprint(analyzed.report);
  const output = writeOutputs(root, analyzed.report, options.output);

  if (options.printJson) console.log(JSON.stringify(analyzed.report, null, 2));
  else {
    console.log(`VibeLabel ${VERSION}`);
    console.log(`Scope:  ${analyzed.report.selection.mode}`);
    console.log(`Files:  ${analyzed.report.summary.files.total}`);
    console.log(`HTML:   ${output.htmlPath}`);
    console.log(`Detail: ${output.detailedHtmlPath}`);
    console.log(`Report: ${output.reportPath}`);
  }
  if (options.open) openFile(output.htmlPath);
  return verification.some((item) => item.status === 'failed') ? 2 : 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = main();
  } catch (error) {
    const code = error instanceof VibeLabelError ? error.code : 'E_UNEXPECTED';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`VibeLabel ${code}: ${message}`);
    if (process.env.VIBELABEL_DEBUG && error instanceof Error) console.error(error.stack);
    process.exitCode = 1;
  }
}
