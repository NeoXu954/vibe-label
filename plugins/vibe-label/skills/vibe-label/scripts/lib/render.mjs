import { readFileSync } from 'node:fs';
import { getCopy } from './i18n.mjs';

const ASSET_ROOT = new URL('../../assets/', import.meta.url);

function readAsset(relativePath, encoding = 'utf8') {
  return readFileSync(new URL(relativePath, ASSET_ROOT), encoding);
}

function fontBundle() {
  const sans = readAsset('fonts/Geist-Variable.woff2', null).toString('base64');
  const mono = readAsset('fonts/GeistMono-Variable.woff2', null).toString('base64');
  const cjk = readAsset('fonts/NotoSansSC-VibeLabel.woff2', null).toString('base64');
  return { sans, mono, cjk };
}

function fontCss(fonts) {
  return `
@font-face {
  font-family: "Geist Sans";
  src: url(data:font/woff2;base64,${fonts.sans}) format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url(data:font/woff2;base64,${fonts.mono}) format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "VibeLabel CJK";
  src: url(data:font/woff2;base64,${fonts.cjk}) format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function formatDelta(value, sign) {
  return value === 0 ? '0' : `${sign}${formatNumber(value)}`;
}

function middleTruncate(value, maxLength) {
  const text = String(value ?? '');
  const characters = Array.from(text);
  const width = (character) => (/\p{Script=Han}|\p{Extended_Pictographic}|[\uFF01-\uFF60]/u.test(character) ? 2 : 1);
  if (characters.reduce((sum, character) => sum + width(character), 0) <= maxLength) return text;
  const sideBudget = Math.floor((maxLength - 1) / 2);
  const take = (source) => {
    const result = [];
    let used = 0;
    for (const character of source) {
      const next = width(character);
      if (used + next > sideBudget) break;
      result.push(character);
      used += next;
    }
    return result;
  };
  const start = take(characters).join('');
  const end = take([...characters].reverse()).reverse().join('');
  return `${start}…${end}`;
}

function scopeLabel(selection, detailed, copy) {
  if (selection.mode === 'current') return copy.scopes.current;
  if (selection.mode === 'staged') return copy.scopes.staged;
  if (selection.mode === 'unstaged') return copy.scopes.unstaged;
  return detailed ? copy.scopes.baseWithRef(selection.baseRef ?? 'REF') : copy.scopes.base;
}

function verificationRows(report, copy) {
  const resultByLabel = new Map(
    (report.verification.results ?? []).map((result) => [String(result.label).toUpperCase(), result]),
  );
  return ['BUILD', 'TEST', 'TYPES'].map((key) => {
    const result = resultByLabel.get(key);
    const stateKey = result
      ? (result.status === 'passed' ? 'PASS' : 'FAIL')
      : (report.verification.availability?.[key] ? 'NOT_RUN' : 'NOT_FOUND');
    return { key, label: copy.checks[key], stateKey, state: copy.states[stateKey] };
  });
}

function languageRows(report, copy) {
  const source = report.summary.languages ?? [];
  const named = source.filter((item) => item.name !== 'Other');
  const rows = named.slice(0, 3).map((item) => ({ name: item.name, percent: item.percent }));
  const remainder = [...named.slice(3), ...source.filter((item) => item.name === 'Other')];
  if (remainder.length > 0) {
    const other = remainder.reduce((sum, item) => sum + item.percent, 0);
    rows.push({ name: copy.otherLanguage, percent: Math.round(other * 10) / 10 });
  }
  return rows.length ? rows : [{ name: copy.noTextChanges, percent: 0 }];
}

function aggregateByRule(findings, countMode, labels) {
  const map = new Map();
  for (const finding of findings ?? []) {
    const existing = map.get(finding.ruleId) ?? {
      id: finding.ruleId,
      label: finding.label,
      count: 0,
      paths: new Set(),
    };
    existing.count += finding.occurrences ?? 1;
    existing.paths.add(finding.path);
    map.set(finding.ruleId, existing);
  }
  return [...map.values()]
    .map((item) => ({
      id: item.id,
      label: labels[item.id] ?? item.label,
      count: countMode === 'files' ? item.paths.size : item.count,
    }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

function buildView(report, detailed, locale) {
  const copy = getCopy(locale);
  const dependencyChanges = ['added', 'removed', 'changed']
    .reduce((sum, key) => sum + (report.dependencies.direct?.[key]?.length ?? 0), 0);
  const head = report.repository.headOid ? report.repository.headOid.slice(0, 8) : copy.unborn;
  const repository = detailed ? middleTruncate(report.repository.name, 22) : copy.privateRepository;
  const branch = detailed ? middleTruncate(report.repository.branch ?? copy.detached, 22) : copy.branchHidden;
  const attention = aggregateByRule(report.attentionAreas, 'files', copy.attentionLabels).slice(0, 4);
  const patterns = aggregateByRule(report.patternsOnAddedLines, 'occurrences', copy.patternLabels).slice(0, 4);
  const checks = verificationRows(report, copy);
  const coverage = report.analysisCoverage.status === 'complete' ? copy.coverage.complete : copy.coverage.partial;
  const source = scopeLabel(report.selection, detailed, copy);
  const view = {
    copy,
    modeKey: detailed ? 'detailed' : 'safe',
    mode: detailed ? copy.modes.detailed : copy.modes.safe,
    repository,
    branch,
    head,
    source,
    churn: report.summary.lines.churn,
    metrics: [
      { label: copy.metrics.files, value: report.summary.files.total },
      { label: copy.metrics.added, value: formatDelta(report.summary.lines.additions, '+') },
      { label: copy.metrics.removed, value: formatDelta(report.summary.lines.deletions, '−') },
      { label: copy.metrics.dependencies, value: dependencyChanges },
    ],
    languages: languageRows(report, copy),
    checks,
    attention: attention.length ? attention : [{ id: 'none', label: copy.noneFound, count: 0 }],
    patterns: patterns.length ? patterns : [{ id: 'none', label: copy.noneFound, count: 0 }],
    tests: `${copy.testLines} ${formatDelta(report.tests.additions, '+')} / ${formatDelta(report.tests.deletions, '−')}`,
    coverage,
    secretNotice: report.privacy.possibleSecretsMatched > 0
      ? `${copy.possibleSecretPatterns} ${report.privacy.possibleSecretsMatched} · ${copy.valuesOmitted}`
      : copy.noSourceSnippets,
    fingerprint: report.fingerprint.value.slice(0, 12).toUpperCase(),
  };
  view.summary = [
    `VibeLabel · ${view.source}`,
    `${copy.summary.files(formatNumber(report.summary.files.total))} · ${formatDelta(report.summary.lines.additions, '+')} / ${formatDelta(report.summary.lines.deletions, '-')}`,
    `${copy.summary.dependencies(dependencyChanges)} · ${view.tests}`,
    checks.map((item) => `${item.label} ${item.state}`).join(' · '),
    `${copy.summary.sensitiveAreas}: ${view.attention.map((item) => `${item.label} ${item.count}`).join(', ')}`,
    `${copy.summary.codeAdditives}: ${view.patterns.map((item) => `${item.label} ${item.count}`).join(', ')}`,
    `${copy.localAnalysis} · ${copy.summary.fingerprint} ${view.fingerprint}`,
  ].join('\n');
  return view;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function renderLanguages(rows) {
  return rows.map((item) => `
    <li class="composition__row">
      <span>${escapeHtml(item.name)}</span>
      <span class="composition__bar" aria-hidden="true"><span class="composition__fill" style="width: ${Math.max(0, Math.min(100, item.percent))}%"></span></span>
      <span>${escapeHtml(item.percent)}%</span>
    </li>`).join('');
}

function renderChecks(rows) {
  return rows.map((item) => `
    <li class="verification__row">
      <span>${escapeHtml(item.label)}</span>
      <span class="verification__state" data-state="${escapeHtml(item.stateKey)}">${escapeHtml(item.state)}</span>
    </li>`).join('');
}

function renderFacts(rows, unit) {
  return rows.map((item) => `
    <li class="fact-list__row"><span>${escapeHtml(item.label)}</span><span>${formatNumber(item.count)} ${escapeHtml(unit)}</span></li>`).join('');
}

function renderArticle(view, id, hidden) {
  const { copy } = view;
  return `
  <article class="label" id="${id}"${hidden ? ' hidden' : ''} aria-label="${escapeHtml(copy.ariaLabel)}">
    <header class="label__header">
      <h1 class="label__brand">VIBELABEL</h1>
      <p class="label__subhead">${escapeHtml(copy.subhead)} · ${escapeHtml(view.mode)} ${escapeHtml(copy.modeSuffix)}</p>
      <p class="label__source"><span>${escapeHtml(view.source)}</span><span>${escapeHtml(view.repository)} · ${escapeHtml(view.branch)}</span></p>
    </header>
    <section class="fact-section">
      <h2 class="fact-section__title">${escapeHtml(copy.sections.changeSize)}</h2>
      <p class="change-total">${formatNumber(view.churn)} <span class="change-total__unit">${escapeHtml(copy.changedLines)}</span></p>
      <div class="metrics">
        ${view.metrics.map((item) => `<div class="metric"><span class="metric__value">${escapeHtml(item.value)}</span><span class="metric__label">${escapeHtml(item.label)}</span></div>`).join('')}
      </div>
    </section>
    <section class="fact-section">
      <h2 class="fact-section__title">${escapeHtml(copy.sections.composition)}</h2>
      <ul class="composition">${renderLanguages(view.languages)}</ul>
    </section>
    <section class="fact-section">
      <h2 class="fact-section__title">${escapeHtml(copy.sections.verification)}</h2>
      <ul class="verification">${renderChecks(view.checks)}</ul>
    </section>
    <div class="lower-facts">
      <section class="fact-section">
        <h2 class="fact-section__title">${escapeHtml(copy.sections.attention)}</h2>
        <ul class="fact-list">${renderFacts(view.attention, copy.fileUnit)}</ul>
      </section>
      <section class="fact-section">
        <h2 class="fact-section__title">${escapeHtml(copy.sections.patterns)}</h2>
        <ul class="fact-list">${renderFacts(view.patterns, copy.hitUnit)}</ul>
      </section>
    </div>
    <footer class="label__footer">
      <span>${escapeHtml(view.tests)} · ${escapeHtml(copy.analysis)} ${escapeHtml(view.coverage)}</span>
      <span>${escapeHtml(copy.head)} ${escapeHtml(view.head)} · ${escapeHtml(copy.label)} ${escapeHtml(view.fingerprint)}</span>
      <span>${escapeHtml(view.secretNotice)}</span>
      <span>${escapeHtml(copy.localAnalysis)} · ${escapeHtml(copy.noSourceCodeUploaded)}</span>
    </footer>
  </article>`;
}

function svgStatus(item, y) {
  const stateClass = item.stateKey === 'PASS' ? 'status pass' : item.stateKey === 'FAIL' ? 'status fail' : 'status';
  return `
    <text x="92" y="${y}" class="row-label">${escapeXml(item.label)}</text>
    <rect x="788" y="${y - 27}" width="202" height="38" class="${stateClass}" />
    <text x="889" y="${y}" class="status-text ${item.stateKey === 'PASS' ? 'pass-text' : ''}" text-anchor="middle">${escapeXml(item.state)}</text>`;
}

function svgFactRows(rows, x, y) {
  return rows.slice(0, 4).map((item, index) => `
    <text x="${x}" y="${y + index * 40}" class="small-row">${escapeXml(middleTruncate(item.label, 28))}</text>
    <text x="${x + 390}" y="${y + index * 40}" class="small-row mono" text-anchor="end">${formatNumber(item.count)}</text>`).join('');
}

export function renderSvg(view, fonts = fontBundle()) {
  const { copy } = view;
  const languageRows = view.languages.slice(0, 4);
  const barMax = 490;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(copy.svgTitle)}</title>
  <desc id="description">${escapeXml(copy.svgDescription)}</desc>
  <style><![CDATA[
    ${fontCss(fonts)}
    :root {
      --paper: oklch(97% 0.006 85);
      --paper-alt: oklch(90% 0.010 85);
      --ink: oklch(18% 0.008 70);
      --muted: oklch(45% 0.010 70);
      --rule: oklch(24% 0.008 70);
      --signal: oklch(62% 0.175 42);
    }
    text { fill: var(--ink); font-family: "Geist Sans", "VibeLabel CJK", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif; letter-spacing: 0; }
    .mono { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-variant-numeric: tabular-nums; }
    .paper { fill: var(--paper); }
    .frame { fill: none; stroke: var(--rule); stroke-width: 4; }
    .rule-heavy { stroke: var(--rule); stroke-width: 4; }
    .rule { stroke: var(--rule); stroke-width: 2; }
    .brand { font-size: 76px; font-weight: 800; }
    .meta { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 18px; font-weight: 500; }
    .section-title { font-size: 24px; font-weight: 750; }
    .total { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 104px; font-weight: 700; }
    .total-unit { font-size: 18px; font-weight: 700; }
    .metric-value { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 42px; font-weight: 700; }
    .metric-label { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 16px; fill: var(--muted); }
    .row-label, .small-row { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 21px; }
    .percent { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 19px; }
    .bar-track { fill: var(--paper-alt); }
    .bar-fill { fill: var(--ink); }
    .status { fill: none; stroke: var(--rule); stroke-width: 2; }
    .status.pass { fill: var(--ink); }
    .status.fail { fill: none; stroke: var(--signal); stroke-width: 6; }
    .status-text { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 17px; font-weight: 700; }
    .pass-text { fill: var(--paper); }
    .footer { font-family: "Geist Mono", "VibeLabel CJK", "SFMono-Regular", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: 17px; fill: var(--muted); }
  ]]></style>
  <rect width="1080" height="1350" class="paper" />
  <rect x="48" y="48" width="984" height="1254" class="frame" />
  <text x="88" y="133" class="brand">VIBELABEL</text>
  <text x="90" y="173" class="meta">${escapeXml(copy.subhead)} · ${escapeXml(view.mode)} ${escapeXml(copy.modeSuffix)}</text>
  <text x="90" y="199" class="meta">${escapeXml(view.source)}</text>
  <text x="990" y="199" class="meta" text-anchor="end">${escapeXml(view.repository)} · ${escapeXml(view.branch)}</text>
  <line x1="88" y1="222" x2="992" y2="222" class="rule-heavy" />

  <text x="90" y="263" class="section-title">${escapeXml(copy.sections.changeSize)}</text>
  <text x="88" y="365" class="total">${formatNumber(view.churn)}</text>
  <text x="90" y="400" class="total-unit">${escapeXml(copy.changedLines)}</text>
  ${view.metrics.map((item, index) => {
    const x = 90 + index * 225;
    return `<text x="${x}" y="451" class="metric-value">${escapeXml(item.value)}</text><text x="${x}" y="478" class="metric-label">${escapeXml(item.label)}</text>`;
  }).join('')}
  <line x1="88" y1="505" x2="992" y2="505" class="rule" />

  <text x="90" y="545" class="section-title">${escapeXml(copy.sections.composition)}</text>
  ${languageRows.map((item, index) => {
    const y = 584 + index * 42;
    const width = Math.round((Math.max(0, Math.min(100, item.percent)) / 100) * barMax);
    return `<text x="90" y="${y}" class="row-label">${escapeXml(middleTruncate(item.name, 18))}</text><rect x="315" y="${y - 18}" width="${barMax}" height="12" class="bar-track"/><rect x="315" y="${y - 18}" width="${width}" height="12" class="bar-fill"/><text x="990" y="${y}" class="percent" text-anchor="end">${escapeXml(item.percent)}%</text>`;
  }).join('')}
  <line x1="88" y1="750" x2="992" y2="750" class="rule" />

  <text x="90" y="790" class="section-title">${escapeXml(copy.sections.verification)}</text>
  ${view.checks.map((item, index) => svgStatus(item, 830 + index * 48)).join('')}
  <line x1="88" y1="955" x2="992" y2="955" class="rule" />

  <text x="90" y="995" class="section-title">${escapeXml(copy.sections.attention)}</text>
  <text x="570" y="995" class="section-title">${escapeXml(copy.sections.patterns)}</text>
  <line x1="540" y1="976" x2="540" y2="1158" class="rule" />
  ${svgFactRows(view.attention, 90, 1035)}
  ${svgFactRows(view.patterns, 570, 1035)}
  <line x1="88" y1="1172" x2="992" y2="1172" class="rule-heavy" />

  <text x="90" y="1210" class="footer">${escapeXml(view.tests)} · ${escapeXml(copy.analysis)} ${escapeXml(view.coverage)}</text>
  <text x="90" y="1242" class="footer">${escapeXml(copy.head)} ${escapeXml(view.head)} · ${escapeXml(copy.label)} ${escapeXml(view.fingerprint)}</text>
  <text x="90" y="1274" class="footer">${escapeXml(view.secretNotice)}</text>
  <text x="990" y="1274" class="footer" text-anchor="end">${escapeXml(copy.local)} · ${escapeXml(copy.noSourceUploaded)}</text>
</svg>`;
}

function clientScript() {
  return `
(() => {
  const data = JSON.parse(document.getElementById('vibelabel-data').textContent);
  const download = document.getElementById('download');
  const copy = document.getElementById('copy');
  const status = document.getElementById('tool-status');
  const mode = data.mode;
  const ui = data.ui;

  const setStatus = (message, tone = 'neutral') => {
    status.textContent = message;
    status.dataset.tone = tone;
  };

  document.querySelectorAll('input[name="share-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.value === mode) return;
      window.location.href = input.value === 'safe' ? 'index.html' : 'detailed.html';
    });
  });

  const imageFromSvg = (svg) => new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(ui.imageError)); };
    image.src = url;
  });

  download.addEventListener('click', async () => {
    download.dataset.state = 'loading';
    download.disabled = true;
    download.querySelector('.action__label').textContent = ui.generating;
    setStatus(ui.rendering);
    try {
      const image = await imageFromSvg(data.svg);
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1350;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(ui.canvasError);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(ui.encodingError)), 'image/png'));
      const date = new Date();
      const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('');
      const url = URL.createObjectURL(png);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'vibelabel-' + stamp + '.png';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      download.dataset.state = 'success';
      setStatus(ui.downloaded);
    } catch (error) {
      download.dataset.state = 'error';
      setStatus(error instanceof Error ? error.message : ui.generationError, 'error');
    } finally {
      download.disabled = false;
      download.querySelector('.action__label').textContent = ui.download;
      setTimeout(() => { if (download.dataset.state === 'success') delete download.dataset.state; }, 1500);
    }
  });

  copy.addEventListener('click', async () => {
    try {
      const value = data.summary;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const textarea = document.createElement('textarea');
          textarea.value = value;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          if (!document.execCommand('copy')) throw new Error('Copy command failed.');
          textarea.remove();
        }
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('Copy command failed.');
        textarea.remove();
      }
      copy.dataset.state = 'success';
      copy.querySelector('.action__label').textContent = ui.copied;
      setStatus(ui.copiedStatus);
      setTimeout(() => {
        delete copy.dataset.state;
        copy.querySelector('.action__label').textContent = ui.copySummary;
      }, 1500);
    } catch {
      copy.dataset.state = 'error';
      setStatus(ui.copyError, 'error');
    }
  });
})();`;
}

export function renderHtml(report, options = {}) {
  const mode = options.mode === 'detailed' ? 'detailed' : 'safe';
  const fonts = fontBundle();
  const view = buildView(report, mode === 'detailed', options.locale);
  const { copy } = view;
  const tokens = readAsset('tokens.css');
  const styles = readAsset('label.css');
  const payload = JSON.stringify({
    mode,
    svg: renderSvg(view, fonts),
    summary: view.summary,
    ui: copy.ui,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="${escapeHtml(copy.htmlDescription)}" />
  <title>VibeLabel · ${escapeHtml(view.source)}</title>
  <style>${tokens}\n${fontCss(fonts)}\n${styles}</style>
</head>
<body>
  <main class="app-shell">
    ${renderArticle(view, `label-${mode}`, false)}
    <aside class="tool-panel" aria-label="${escapeHtml(copy.ui.controlsAriaLabel)}">
      <h2 class="tool-panel__heading">${escapeHtml(copy.ui.heading)}</h2>
      <p class="tool-panel__copy">${escapeHtml(copy.ui.copy)}</p>
      <fieldset class="segmented">
        <legend>${escapeHtml(copy.ui.shareMode)}</legend>
        <label><input type="radio" name="share-mode" value="safe"${mode === 'safe' ? ' checked' : ''} /> ${escapeHtml(copy.ui.safe)}</label>
        <label><input type="radio" name="share-mode" value="detailed"${mode === 'detailed' ? ' checked' : ''} /> ${escapeHtml(copy.ui.detailed)}</label>
      </fieldset>
      <div class="actions">
        <button class="action action--primary" id="download" type="button"><span class="action__icon" aria-hidden="true">↓</span><span class="action__label">${escapeHtml(copy.ui.download)}</span></button>
        <button class="action" id="copy" type="button"><span class="action__icon" aria-hidden="true">⧉</span><span class="action__label">${escapeHtml(copy.ui.copySummary)}</span></button>
      </div>
      <p class="tool-status" id="tool-status" aria-live="polite">${escapeHtml(mode === 'safe' ? copy.ui.safeStatus : copy.ui.detailedStatus)}</p>
      <p class="tool-panel__privacy">${escapeHtml(copy.ui.privacy)}</p>
    </aside>
  </main>
  <script id="vibelabel-data" type="application/json">${payload}</script>
  <script>${clientScript()}</script>
</body>
</html>`;
}

export function renderViews(report, options = {}) {
  return {
    safe: buildView(report, false, options.locale),
    detailed: buildView(report, true, options.locale),
  };
}
