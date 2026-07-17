import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

const GIT_ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
};

const DIFF_OPTIONS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=none',
  '--find-renames=50%',
  '--diff-algorithm=histogram',
];

export class VibeLabelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VibeLabelError';
    this.code = code;
  }
}

function gitFailureMessage(code, status) {
  if (code === 'E_NOT_GIT_REPOSITORY') return 'The target directory is not a Git repository.';
  if (code === 'E_BASE_NOT_FOUND') return 'The requested base ref was not found.';
  if (code === 'E_NO_MERGE_BASE') return 'The requested base and HEAD do not have a merge base.';
  return `Git could not inspect the requested repository state (status ${status}).`;
}

export function runGit(cwd, args, options = {}) {
  const result = spawnSync(
    'git',
    ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'diff.renameLimit=32767', ...args],
    {
      cwd,
      env: GIT_ENV,
      encoding: options.encoding ?? 'utf8',
      input: options.input,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      shell: false,
    },
  );

  if (result.error) {
    throw new VibeLabelError('E_GIT_UNAVAILABLE', 'Git could not run. Confirm that Git is installed and available on PATH.');
  }

  const allowed = options.allowExitCodes ?? [0];
  if (!allowed.includes(result.status)) {
    const code = options.code ?? 'E_GIT_COMMAND';
    throw new VibeLabelError(
      code,
      gitFailureMessage(code, result.status),
    );
  }
  return result;
}

export function findRepositoryRoot(startPath) {
  const result = runGit(startPath, ['rev-parse', '--show-toplevel'], { code: 'E_NOT_GIT_REPOSITORY' });
  return path.resolve(String(result.stdout).trim());
}

export function getRepositoryIdentity(root) {
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowExitCodes: [0, 128] });
  const branch = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowExitCodes: [0, 1] });
  const objectFormat = runGit(root, ['rev-parse', '--show-object-format'], { allowExitCodes: [0, 128] });
  const headOid = head.status === 0 ? String(head.stdout).trim() : null;
  return {
    name: path.basename(root),
    branch: branch.status === 0 ? String(branch.stdout).trim() : null,
    headOid,
    objectFormat: objectFormat.status === 0 ? String(objectFormat.stdout).trim() : 'sha1',
    unborn: headOid === null,
  };
}

function emptyTreeOid(root) {
  return String(runGit(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).stdout).trim();
}

export function resolveSelection(root, mode, baseRef) {
  const identity = getRepositoryIdentity(root);
  if (mode === 'current') {
    const left = identity.headOid ?? emptyTreeOid(root);
    return {
      mode,
      diffArgs: [left],
      left,
      right: 'WORKTREE',
      includes: { committed: false, staged: true, unstaged: true, untracked: true },
      identity,
    };
  }
  if (mode === 'staged') {
    const left = identity.headOid ?? emptyTreeOid(root);
    return {
      mode,
      diffArgs: ['--cached', left],
      left,
      right: 'INDEX',
      includes: { committed: false, staged: true, unstaged: false, untracked: false },
      identity,
    };
  }
  if (mode === 'unstaged') {
    return {
      mode,
      diffArgs: [],
      left: 'INDEX',
      right: 'WORKTREE',
      includes: { committed: false, staged: false, unstaged: true, untracked: true },
      identity,
    };
  }
  if (mode === 'base') {
    if (!baseRef) throw new VibeLabelError('E_BASE_REQUIRED', 'Base mode requires --base <ref>.');
    if (!identity.headOid) throw new VibeLabelError('E_UNBORN_BASE', 'Base mode requires at least one commit.');
    const base = runGit(root, ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      code: 'E_BASE_NOT_FOUND',
    });
    const baseOid = String(base.stdout).trim();
    const mergeBase = runGit(root, ['merge-base', baseOid, identity.headOid], {
      code: 'E_NO_MERGE_BASE',
    });
    const left = String(mergeBase.stdout).trim();
    return {
      mode,
      diffArgs: [left, identity.headOid],
      left,
      right: identity.headOid,
      baseRef,
      includes: { committed: true, staged: false, unstaged: false, untracked: false },
      identity,
    };
  }
  throw new VibeLabelError('E_SCOPE', `Unknown scope: ${mode}`);
}

function diff(root, selection, formatArgs, pathspec) {
  const args = ['diff', ...DIFF_OPTIONS, ...formatArgs, ...selection.diffArgs];
  if (pathspec) args.push('--', pathspec);
  return runGit(root, args);
}

function nulFields(value) {
  const fields = String(value).split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

export function parseNameStatusZ(value) {
  const fields = nulFields(value);
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const raw = fields[index++];
    if (!raw) continue;
    let status = raw;
    let firstPath = null;
    if (raw.includes('\t')) {
      const tab = raw.indexOf('\t');
      status = raw.slice(0, tab);
      firstPath = raw.slice(tab + 1);
    }
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const previousPath = firstPath ?? fields[index++];
      const currentPath = fields[index++];
      if (previousPath !== undefined && currentPath !== undefined) {
        records.push({ status: code, score: Number(status.slice(1)) || null, previousPath, path: currentPath });
      }
    } else {
      const currentPath = firstPath ?? fields[index++];
      if (currentPath !== undefined) records.push({ status: code, path: currentPath });
    }
  }
  return records;
}

export function parseNumstatZ(value) {
  const fields = nulFields(value);
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const header = fields[index++];
    if (!header) continue;
    const parts = header.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? null : Number(parts[0]);
    const deletions = parts[1] === '-' ? null : Number(parts[1]);
    let currentPath = parts.slice(2).join('\t');
    let previousPath;
    if (currentPath === '') {
      previousPath = fields[index++];
      currentPath = fields[index++];
    }
    if (currentPath !== undefined) {
      records.push({
        path: currentPath,
        previousPath,
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      });
    }
  }
  return records;
}

function mergeTrackedRecords(statusRecords, statRecords) {
  const unusedStats = [...statRecords];
  return statusRecords.map((record) => {
    const statIndex = unusedStats.findIndex((item) => (
      item.path === record.path
      || (record.previousPath && item.previousPath === record.previousPath && item.path === record.path)
    ));
    const stat = statIndex >= 0 ? unusedStats.splice(statIndex, 1)[0] : null;
    return {
      ...record,
      origin: 'tracked',
      binary: stat ? stat.additions === null || stat.deletions === null : false,
      lines: stat
        ? {
            additions: stat.additions,
            deletions: stat.deletions,
            churn: stat.additions === null || stat.deletions === null ? null : stat.additions + stat.deletions,
          }
        : { additions: 0, deletions: 0, churn: 0 },
    };
  });
}

function untrackedStats(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const info = lstatSync(absolutePath);
  if (!info.isFile()) {
    return {
      status: 'A',
      path: relativePath,
      origin: 'untracked',
      binary: true,
      special: info.isSymbolicLink() ? 'symlink' : 'special',
      lines: { additions: null, deletions: null, churn: null },
    };
  }
  const sampleSize = Math.min(info.size, 8_000);
  if (sampleSize > 0) {
    const descriptor = openSync(absolutePath, 'r');
    const sample = Buffer.alloc(sampleSize);
    try {
      readSync(descriptor, sample, 0, sampleSize, 0);
    } finally {
      closeSync(descriptor);
    }
    if (sample.includes(0)) {
      return {
        status: 'A',
        path: relativePath,
        origin: 'untracked',
        binary: true,
        lines: { additions: null, deletions: null, churn: null },
      };
    }
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = runGit(root, ['diff', '--no-index', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--', nullDevice, relativePath], {
    allowExitCodes: [0, 1],
  });
  const stat = parseNumstatZ(result.stdout)[0];
  const additions = stat?.additions ?? 0;
  const deletions = stat?.deletions ?? 0;
  const binary = stat ? additions === null || deletions === null : false;
  return {
    status: 'A',
    path: relativePath,
    origin: 'untracked',
    binary,
    lines: {
      additions: binary ? null : additions,
      deletions: binary ? null : deletions,
      churn: binary ? null : additions + deletions,
    },
  };
}

export function collectFiles(root, selection) {
  const statuses = parseNameStatusZ(diff(root, selection, ['--name-status', '-z']).stdout);
  const stats = parseNumstatZ(diff(root, selection, ['--numstat', '-z']).stdout);
  const files = mergeTrackedRecords(statuses, stats);
  if (selection.mode === 'current' || selection.mode === 'unstaged') {
    const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const relativePath of nulFields(untracked.stdout)) {
      if (relativePath) files.push(untrackedStats(root, relativePath));
    }
  }
  return files.sort((a, b) => codeUnitCompare(a.path, b.path));
}

function parsePatchAddedLines(patch, maxLines) {
  const results = [];
  let newLine = null;
  for (const line of String(patch).split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      results.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith(' ')) {
      newLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      newLine = null;
    }
    if (results.length >= maxLines) break;
  }
  return results;
}

export function addedLinesForFile(root, selection, file, options = {}) {
  const maxLines = options.maxLines ?? 20_000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  if (file.status === 'D') return { lines: [], complete: true, reason: null };
  if (file.binary || file.special) return { lines: [], complete: false, reason: 'not-text' };
  if (file.origin === 'untracked') {
    const absolutePath = path.join(root, file.path);
    const info = lstatSync(absolutePath);
    if (!info.isFile()) return { lines: [], complete: false, reason: 'not-regular-file' };
    if (info.size > maxBytes) return { lines: [], complete: false, reason: 'size-cap' };
    const content = readFileSync(absolutePath);
    if (content.includes(0)) return { lines: [], complete: false, reason: 'binary' };
    const text = content.toString('utf8');
    const sourceLines = text === '' ? [] : text.split(/\r?\n/);
    const lines = sourceLines.slice(0, maxLines).map((value, index) => ({ line: index + 1, text: value }));
    return { lines, complete: sourceLines.length <= maxLines, reason: sourceLines.length > maxLines ? 'line-cap' : null };
  }
  const result = diff(root, selection, ['--unified=0'], file.path);
  if (Buffer.byteLength(String(result.stdout), 'utf8') > maxBytes * 4) {
    return { lines: [], complete: false, reason: 'patch-size-cap' };
  }
  const lines = parsePatchAddedLines(result.stdout, maxLines);
  return { lines, complete: lines.length < maxLines, reason: lines.length >= maxLines ? 'line-cap' : null };
}

export function readScopedFile(root, selection, filePath, side) {
  try {
    if (selection.mode === 'staged') {
      if (side === 'before') {
        if (selection.identity.unborn) return null;
        return String(runGit(root, ['show', `${selection.identity.headOid}:${filePath}`]).stdout);
      }
      return String(runGit(root, ['show', `:${filePath}`]).stdout);
    }
    if (selection.mode === 'current') {
      if (side === 'before') {
        if (selection.identity.unborn) return null;
        return String(runGit(root, ['show', `${selection.identity.headOid}:${filePath}`]).stdout);
      }
      const absolutePath = path.join(root, filePath);
      const info = lstatSync(absolutePath);
      return info.isFile() ? readFileSync(absolutePath, 'utf8') : null;
    }
    if (selection.mode === 'unstaged') {
      if (side === 'before') return String(runGit(root, ['show', `:${filePath}`]).stdout);
      const absolutePath = path.join(root, filePath);
      const info = lstatSync(absolutePath);
      return info.isFile() ? readFileSync(absolutePath, 'utf8') : null;
    }
    const revision = side === 'before' ? selection.left : selection.right;
    return String(runGit(root, ['show', `${revision}:${filePath}`]).stdout);
  } catch {
    return null;
  }
}

export function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function getDiffFingerprintInput(root, selection) {
  const result = diff(root, selection, ['--binary', '--full-index']);
  let untracked = '';
  if (selection.mode === 'current' || selection.mode === 'unstaged') {
    const paths = nulFields(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);
    for (const relativePath of paths.sort(codeUnitCompare)) {
      const absolutePath = path.join(root, relativePath);
      try {
        const info = lstatSync(absolutePath);
        if (info.isFile() && info.size <= 2_000_000) {
          untracked += `\0${relativePath}\0${readFileSync(absolutePath).toString('base64')}`;
        } else {
          untracked += `\0${relativePath}\0[unreadable]`;
        }
      } catch {
        untracked += `\0${relativePath}\0[missing]`;
      }
    }
  }
  return `${result.stdout}${untracked}`;
}
