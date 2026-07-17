import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  VibeLabelError,
  addedLinesForFile,
  codeUnitCompare,
  collectFiles,
  findRepositoryRoot,
  getDiffFingerprintInput,
  readScopedFile,
  resolveSelection,
} from './git.mjs';

export const ANALYZER_VERSION = '0.1.0';
export const RULESET_VERSION = '2026-07-17';

const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
]);

const LANGUAGE_BY_EXTENSION = new Map(Object.entries({
  '.astro': 'Astro', '.bash': 'Shell', '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.cs': 'C#',
  '.css': 'CSS', '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir', '.go': 'Go', '.h': 'C/C++',
  '.html': 'HTML', '.java': 'Java', '.js': 'JavaScript', '.jsx': 'JavaScript', '.json': 'JSON',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.lua': 'Lua', '.md': 'Markdown', '.mjs': 'JavaScript',
  '.php': 'PHP', '.ps1': 'PowerShell', '.py': 'Python', '.rb': 'Ruby', '.rs': 'Rust',
  '.scss': 'SCSS', '.sh': 'Shell', '.sql': 'SQL', '.svelte': 'Svelte', '.swift': 'Swift',
  '.toml': 'TOML', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue', '.xml': 'XML',
  '.yaml': 'YAML', '.yml': 'YAML', '.zig': 'Zig',
}));

const BASENAME_LANGUAGES = new Map([
  ['dockerfile', 'Dockerfile'], ['gemfile', 'Ruby'], ['makefile', 'Makefile'], ['procfile', 'Procfile'],
]);

const ATTENTION_RULES = [
  {
    id: 'authentication', label: 'AUTHENTICATION',
    path: /(^|[/_.-])(auth|authentication|login|logout|session|oauth|jwt|password)([/_.-]|$)/i,
    line: /\b(oauth|openid|jsonwebtoken|jwt|bcrypt|argon2|passport|session|set-cookie|password)\b/i,
  },
  {
    id: 'authorization', label: 'AUTHORIZATION',
    path: /(^|[/_.-])(authorization|permission|permissions|roles?|acl|rbac|policy|policies)([/_.-]|$)/i,
    line: /\b(authoriz(?:e|ation)|permissions?|rbac|acl|accessPolicy|canAccess|hasRole)\b/i,
  },
  {
    id: 'payments', label: 'PAYMENTS',
    path: /(^|[/_.-])(payment|payments|billing|checkout|invoice|stripe|paypal)([/_.-]|$)/i,
    line: /\b(stripe|paypal|checkout|paymentIntent|billing|invoice)\b/i,
  },
  {
    id: 'database-migrations', label: 'DATABASE / MIGRATIONS',
    path: /(^|[/_.-])(migrations?|schema|prisma|database|db)([/_.-]|$)|\.sql$/i,
    line: /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|DATABASE)\b|\b(prisma|migration|knex\.schema)\b/i,
  },
  {
    id: 'secrets-environment', label: 'SECRETS / ENV',
    path: /(^|[/_.-])(\.env|secrets?|credentials?|config)([/_.-]|$)/i,
    line: /\b(process\.env|Deno\.env|getenv|os\.environ|dotenv|secret|credential)\b/i,
  },
  {
    id: 'deployment-ci', label: 'DEPLOYMENT / CI',
    path: /(^|\/)(\.github\/workflows|\.gitlab-ci|dockerfile|compose\.ya?ml|terraform|k8s|kubernetes|deploy)(\/|$|\.)/i,
    line: null,
  },
];

const PATTERN_RULES = [
  { id: 'maintenance-marker', label: 'TODO / FIXME / HACK', regex: /(?:\/\/|\/\*|#|<!--|--)\s*(?:TODO|FIXME|HACK|XXX)\b/g },
  { id: 'type-lint-suppression', label: 'TYPE / LINT SUPPRESSION', regex: /(?:\/\/|\/\*|#)\s*(?:@ts-ignore|@ts-nocheck|eslint-disable|type:\s*ignore|noqa)\b/g },
  { id: 'verification-bypass', label: 'TLS / VERIFY BYPASS', regex: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|verify\s*=\s*False/g },
  { id: 'debug-eval', label: 'DEBUGGER / EVAL', regex: /\bdebugger\s*;|\beval\s*\(/g },
  { id: 'debug-output', label: 'DEBUG OUTPUT', regex: /\bconsole\.(?:debug|trace)\s*\(/g },
];

const TEST_CONTROL_RULE = {
  id: 'test-control', label: 'SKIPPED / FOCUSED TEST',
  regex: /\b(?:describe|it|test)\.(?:skip|only)\s*\(|pytest\.mark\.(?:skip|focus)|@Disabled\b/g,
};

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'][^"']{8,}["']/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
];

export function languageForPath(filePath) {
  const basename = path.posix.basename(filePath).toLowerCase();
  if (BASENAME_LANGUAGES.has(basename)) return BASENAME_LANGUAGES.get(basename);
  const lower = filePath.toLowerCase();
  const compound = ['.d.ts', '.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.js', '.spec.js']
    .find((suffix) => lower.endsWith(suffix));
  if (compound) return compound.includes('ts') ? 'TypeScript' : 'JavaScript';
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(lower)) ?? 'Other';
}

export function isTestPath(filePath) {
  const normalized = `/${filePath.toLowerCase().replaceAll('\\', '/')}`;
  const basename = path.posix.basename(normalized);
  return /\/(?:__tests__|tests?|specs?)\//.test(normalized)
    || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(basename)
    || /^test_.+\.py$/.test(basename)
    || /_test\.go$/.test(basename);
}

function matchCount(text, regex) {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.exec(text)) count += 1;
  regex.lastIndex = 0;
  return count;
}

function normalizeFile(file) {
  const beforePath = file.previousPath ?? file.path;
  return {
    ...file,
    languageBefore: languageForPath(beforePath),
    languageAfter: languageForPath(file.path),
    testRoleBefore: isTestPath(beforePath),
    testRoleAfter: isTestPath(file.path),
    attentionAreaIds: [],
  };
}

function addFinding(map, rule, filePath, matchBasis, line, occurrences = 1) {
  const key = `${rule.id}\0${filePath}\0${matchBasis}`;
  const existing = map.get(key) ?? {
    ruleId: rule.id,
    label: rule.label,
    path: filePath,
    matchBasis,
    occurrences: 0,
    lines: [],
  };
  existing.occurrences += occurrences;
  if (line && existing.lines.length < 8 && !existing.lines.includes(line)) existing.lines.push(line);
  map.set(key, existing);
}

function scanFiles(root, selection, files) {
  const attention = new Map();
  const patterns = new Map();
  const warnings = [];
  let scannedAddedLines = 0;
  let possibleSecrets = 0;
  let skippedFiles = 0;

  for (const file of files) {
    for (const rule of ATTENTION_RULES) {
      if (rule.path.test(file.path) || (file.previousPath && rule.path.test(file.previousPath))) {
        addFinding(attention, rule, file.path, 'path', null);
        file.attentionAreaIds.push(rule.id);
      }
    }

    let scan;
    try {
      scan = addedLinesForFile(root, selection, file);
    } catch {
      scan = { lines: [], complete: false, reason: 'scan-failed' };
    }
    if (!scan.complete) {
      skippedFiles += 1;
      warnings.push({ code: `W_CONTENT_${String(scan.reason ?? 'PARTIAL').toUpperCase().replaceAll('-', '_')}`, path: file.path });
    }
    scannedAddedLines += scan.lines.length;
    const scanContentRules = !['Markdown', 'Other'].includes(file.languageAfter);

    for (const item of scan.lines) {
      for (const regex of SECRET_PATTERNS) possibleSecrets += matchCount(item.text, regex);
      if (scanContentRules) {
        for (const rule of ATTENTION_RULES) {
          if (rule.line && rule.line.test(item.text)) {
            addFinding(attention, rule, file.path, 'added-line', item.line);
            if (!file.attentionAreaIds.includes(rule.id)) file.attentionAreaIds.push(rule.id);
          }
        }
        for (const rule of PATTERN_RULES) {
          const occurrences = matchCount(item.text, rule.regex);
          if (occurrences) addFinding(patterns, rule, file.path, 'added-line', item.line, occurrences);
        }
        if (file.testRoleAfter) {
          const occurrences = matchCount(item.text, TEST_CONTROL_RULE.regex);
          if (occurrences) addFinding(patterns, TEST_CONTROL_RULE, file.path, 'added-line', item.line, occurrences);
        }
      }
    }
    file.attentionAreaIds.sort(codeUnitCompare);
  }

  const sorted = (values) => [...values.values()].sort((a, b) => (
    codeUnitCompare(a.ruleId, b.ruleId) || codeUnitCompare(a.path, b.path) || codeUnitCompare(a.matchBasis, b.matchBasis)
  ));
  return {
    attentionAreas: sorted(attention),
    patternsOnAddedLines: sorted(patterns),
    warnings: warnings.sort((a, b) => codeUnitCompare(a.path, b.path) || codeUnitCompare(a.code, b.code)),
    coverage: {
      addedLineScan: skippedFiles === 0 ? 'complete' : 'partial',
      filesScanned: files.length - skippedFiles,
      filesSkipped: skippedFiles,
      addedLinesScanned: scannedAddedLines,
    },
    possibleSecrets,
  };
}

function statusSummary(files) {
  const result = {
    total: files.length, added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0,
    typeChanged: 0, unmerged: 0, binary: 0, untracked: 0,
  };
  const statusKeys = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typeChanged', U: 'unmerged' };
  for (const file of files) {
    const key = statusKeys[file.status];
    if (key) result[key] += 1;
    if (file.binary) result.binary += 1;
    if (file.origin === 'untracked') result.untracked += 1;
  }
  return result;
}

function lineSummary(files) {
  let additions = 0;
  let deletions = 0;
  let numeric = 0;
  let nonNumeric = 0;
  for (const file of files) {
    if (file.lines.additions === null || file.lines.deletions === null) {
      nonNumeric += 1;
    } else {
      numeric += 1;
      additions += file.lines.additions;
      deletions += file.lines.deletions;
    }
  }
  return {
    additions,
    deletions,
    churn: additions + deletions,
    net: additions - deletions,
    filesWithNumericStats: numeric,
    filesWithoutNumericStats: nonNumeric,
  };
}

function languageSummary(files) {
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, { name, additions: 0, deletions: 0, churn: 0, percent: 0 });
    return map.get(name);
  };
  for (const file of files) {
    if (file.lines.additions !== null) ensure(file.languageAfter).additions += file.lines.additions;
    if (file.lines.deletions !== null) ensure(file.languageBefore).deletions += file.lines.deletions;
  }
  const values = [...map.values()];
  const total = values.reduce((sum, item) => sum + item.additions + item.deletions, 0);
  for (const item of values) {
    item.churn = item.additions + item.deletions;
    item.percent = total === 0 ? 0 : Math.round((item.churn / total) * 1000) / 10;
  }
  return values
    .filter((item) => item.churn > 0)
    .sort((a, b) => b.churn - a.churn || codeUnitCompare(a.name, b.name));
}

function testSummary(files) {
  const testFiles = files.filter((file) => file.testRoleBefore || file.testRoleAfter);
  let additions = 0;
  let deletions = 0;
  for (const file of testFiles) {
    if (file.testRoleAfter && file.lines.additions !== null) additions += file.lines.additions;
    if (file.testRoleBefore && file.lines.deletions !== null) deletions += file.lines.deletions;
  }
  return {
    execution: 'not-run',
    files: testFiles.length,
    additions,
    deletions,
  };
}

function declarations(content) {
  if (content === null) return { ok: true, values: new Map() };
  try {
    const parsed = JSON.parse(content);
    const values = new Map();
    for (const section of PACKAGE_SECTIONS) {
      const group = parsed?.[section];
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      for (const [name, spec] of Object.entries(group)) {
        if (typeof spec !== 'string') continue;
        if (!values.has(name)) values.set(name, []);
        values.get(name).push({ section, spec: sanitizeDependencySpec(spec) });
      }
    }
    for (const value of values.values()) value.sort((a, b) => codeUnitCompare(a.section, b.section));
    return { ok: true, values };
  } catch {
    return { ok: false, values: new Map() };
  }
}

function sanitizeDependencySpec(spec) {
  if (/^(?:file|link|portal):/i.test(spec)) return '[local-path]';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)
    || /^(?:github|gitlab|bitbucket|gist):/i.test(spec)
    || /^[^@\s]+@[^:\s]+:.+/.test(spec)) {
    return '[remote-url]';
  }
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(spec)) return '[local-path]';
  return spec;
}

function dependencySummary(root, selection, files) {
  const manifests = [];
  const direct = { added: [], removed: [], changed: [] };
  const warnings = [];
  for (const file of files.filter((item) => path.posix.basename(item.path) === 'package.json')) {
    const beforePath = file.previousPath ?? file.path;
    const before = declarations(readScopedFile(root, selection, beforePath, 'before'));
    const after = declarations(readScopedFile(root, selection, file.path, 'after'));
    const manifest = { path: file.path, parsed: before.ok && after.ok };
    manifests.push(manifest);
    if (!manifest.parsed) {
      warnings.push({ code: 'W_PACKAGE_JSON_PARSE', path: file.path });
      continue;
    }
    const names = [...new Set([...before.values.keys(), ...after.values.keys()])].sort(codeUnitCompare);
    for (const name of names) {
      const beforeValue = before.values.get(name) ?? [];
      const afterValue = after.values.get(name) ?? [];
      const entry = { manifest: file.path, name, before: beforeValue, after: afterValue };
      if (beforeValue.length === 0) direct.added.push(entry);
      else if (afterValue.length === 0) direct.removed.push(entry);
      else if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) direct.changed.push(entry);
    }
  }
  for (const values of Object.values(direct)) values.sort((a, b) => codeUnitCompare(a.manifest, b.manifest) || codeUnitCompare(a.name, b.name));
  const lockfilesTouched = files
    .filter((file) => LOCKFILES.has(path.posix.basename(file.path)))
    .map((file) => file.path)
    .sort(codeUnitCompare);
  return {
    manifests: manifests.sort((a, b) => codeUnitCompare(a.path, b.path)),
    lockfilesTouched,
    direct,
    warnings,
  };
}

function verificationAvailability(root) {
  const packagePath = path.join(root, 'package.json');
  const available = { BUILD: false, TEST: false, TYPES: false };
  if (!existsSync(packagePath)) return available;
  try {
    const scripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts ?? {};
    available.BUILD = typeof scripts.build === 'string';
    available.TEST = typeof scripts.test === 'string';
    available.TYPES = typeof scripts.typecheck === 'string' || typeof scripts['type-check'] === 'string';
  } catch {
    // Availability is advisory; malformed project metadata is covered elsewhere.
  }
  return available;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(codeUnitCompare).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function fingerprintReport(report) {
  const clone = structuredClone(report);
  delete clone.fingerprint;
  if (clone.repository) {
    delete clone.repository.name;
    delete clone.repository.branch;
  }
  if (clone.verification) {
    for (const item of clone.verification.results ?? []) delete item.durationMs;
  }
  const serialized = JSON.stringify(canonicalize(clone));
  return createHash('sha256').update(serialized).digest('hex');
}

export function refreshFingerprint(report) {
  report.fingerprint = {
    algorithm: 'sha256',
    canonicalization: 'sorted-json-v1',
    value: fingerprintReport(report),
  };
  return report;
}

function analyzeOnce(root, selection) {
  const files = collectFiles(root, selection).map(normalizeFile);
  const scan = scanFiles(root, selection, files);
  const dependencies = dependencySummary(root, selection, files);
  const warnings = [...scan.warnings, ...dependencies.warnings]
    .sort((a, b) => codeUnitCompare(a.path ?? '', b.path ?? '') || codeUnitCompare(a.code, b.code));
  const report = {
    schemaVersion: '1.0',
    analyzer: { version: ANALYZER_VERSION, rulesetVersion: RULESET_VERSION },
    repository: selection.identity,
    selection: {
      mode: selection.mode,
      left: selection.left,
      right: selection.right,
      baseRef: selection.baseRef ?? null,
      includes: selection.includes,
    },
    summary: {
      files: statusSummary(files),
      lines: lineSummary(files),
      languages: languageSummary(files),
    },
    files,
    dependencies: {
      manifests: dependencies.manifests,
      lockfilesTouched: dependencies.lockfilesTouched,
      direct: dependencies.direct,
    },
    tests: testSummary(files),
    attentionAreas: scan.attentionAreas,
    patternsOnAddedLines: scan.patternsOnAddedLines,
    verification: {
      availability: verificationAvailability(root),
      results: [],
    },
    analysisCoverage: {
      status: warnings.length === 0 ? 'complete' : 'partial',
      ...scan.coverage,
      dependencyScan: dependencies.warnings.length === 0 ? 'complete' : 'partial',
    },
    privacy: {
      rawDiffStored: false,
      sourceSnippetsStored: false,
      possibleSecretsMatched: scan.possibleSecrets,
      absolutePathsStored: false,
    },
    warnings,
  };
  return refreshFingerprint(report);
}

function sourceDigest(root, selection) {
  return createHash('sha256').update(getDiffFingerprintInput(root, selection)).digest('hex');
}

export function analyzeRepository(options = {}) {
  const root = findRepositoryRoot(path.resolve(options.repository ?? process.cwd()));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const selection = resolveSelection(root, options.mode ?? 'current', options.baseRef);
    const before = sourceDigest(root, selection);
    const report = analyzeOnce(root, selection);
    const after = sourceDigest(root, selection);
    if (before === after) return { root, report };
  }
  throw new VibeLabelError('E_REPOSITORY_CHANGED', 'The repository changed during analysis. Run VibeLabel again.');
}
