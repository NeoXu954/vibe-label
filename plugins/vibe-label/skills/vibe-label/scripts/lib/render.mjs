import { readFileSync } from 'node:fs';

const ASSET_ROOT = new URL('../../assets/', import.meta.url);

function readAsset(relativePath, encoding = 'utf8') {
  return readFileSync(new URL(relativePath, ASSET_ROOT), encoding);
}

function fontBundle() {
  const sans = readAsset('fonts/Geist-Variable.woff2', null).toString('base64');
  const mono = readAsset('fonts/GeistMono-Variable.woff2', null).toString('base64');
  return { sans, mono };
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
  if (text.length <= maxLength) return text;
  const side = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, side)}…${text.slice(-side)}`;
}

function scopeLabel(selection, detailed) {
  if (selection.mode === 'current') return 'CURRENT DIFF';
  if (selection.mode === 'staged') return 'STAGED DIFF';
  if (selection.mode === 'unstaged') return 'UNSTAGED DIFF';
  return detailed ? `BASE · ${selection.baseRef ?? 'REF'}` : 'BASE DIFF';
}

function verificationRows(report) {
  const resultByLabel = new Map(
    (report.verification.results ?? []).map((result) => [String(result.label).toUpperCase(), result]),
  );
  return ['BUILD', 'TEST', 'TYPES'].map((label) => {
    const result = resultByLabel.get(label);
    if (result) return { label, state: result.status === 'passed' ? 'PASS' : 'FAIL' };
    return { label, state: report.verification.availability?.[label] ? 'NOT RUN' : 'NOT FOUND' };
  });
}

function languageRows(report) {
  const source = report.summary.languages ?? [];
  const rows = source.slice(0, 3).map((item) => ({ name: item.name, percent: item.percent }));
  if (source.length > 3) {
    const other = source.slice(3).reduce((sum, item) => sum + item.percent, 0);
    rows.push({ name: 'Other', percent: Math.round(other * 10) / 10 });
  }
  return rows.length ? rows : [{ name: 'No text changes', percent: 0 }];
}

function aggregateByRule(findings, countMode) {
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
    .map((item) => ({ label: item.label, count: countMode === 'files' ? item.paths.size : item.count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

function buildView(report, detailed) {
  const dependencyChanges = ['added', 'removed', 'changed']
    .reduce((sum, key) => sum + (report.dependencies.direct?.[key]?.length ?? 0), 0);
  const head = report.repository.headOid ? report.repository.headOid.slice(0, 8) : 'UNBORN';
  const repository = detailed ? middleTruncate(report.repository.name, 28) : 'PRIVATE REPOSITORY';
  const branch = detailed ? middleTruncate(report.repository.branch ?? 'DETACHED', 28) : 'BRANCH HIDDEN';
  const attention = aggregateByRule(report.attentionAreas, 'files').slice(0, 4);
  const patterns = aggregateByRule(report.patternsOnAddedLines, 'occurrences').slice(0, 4);
  const checks = verificationRows(report);
  const coverage = report.analysisCoverage.status === 'complete' ? 'COMPLETE' : 'PARTIAL';
  const source = scopeLabel(report.selection, detailed);
  const view = {
    mode: detailed ? 'DETAILED' : 'SAFE',
    repository,
    branch,
    head,
    source,
    churn: report.summary.lines.churn,
    metrics: [
      { label: 'FILES', value: report.summary.files.total },
      { label: 'ADDED', value: formatDelta(report.summary.lines.additions, '+') },
      { label: 'REMOVED', value: formatDelta(report.summary.lines.deletions, '−') },
      { label: 'DEP CHANGES', value: dependencyChanges },
    ],
    languages: languageRows(report),
    checks,
    attention: attention.length ? attention : [{ label: 'NONE FOUND', count: 0 }],
    patterns: patterns.length ? patterns : [{ label: 'NONE FOUND', count: 0 }],
    tests: `TEST LINES ${formatDelta(report.tests.additions, '+')} / ${formatDelta(report.tests.deletions, '−')}`,
    coverage,
    secretNotice: report.privacy.possibleSecretsMatched > 0
      ? `POSSIBLE SECRET PATTERNS ${report.privacy.possibleSecretsMatched} · VALUES OMITTED`
      : 'NO SOURCE SNIPPETS STORED',
    fingerprint: report.fingerprint.value.slice(0, 12).toUpperCase(),
  };
  view.summary = [
    `VibeLabel · ${view.source}`,
    `${formatNumber(report.summary.files.total)} files · ${formatDelta(report.summary.lines.additions, '+')} / ${formatDelta(report.summary.lines.deletions, '-')}`,
    `${dependencyChanges} direct dependency changes · ${view.tests.toLowerCase()}`,
    checks.map((item) => `${item.label} ${item.state}`).join(' · '),
    `Sensitive areas: ${view.attention.map((item) => `${item.label} ${item.count}`).join(', ')}`,
    `Code additives: ${view.patterns.map((item) => `${item.label} ${item.count}`).join(', ')}`,
    `Local analysis · fingerprint ${view.fingerprint}`,
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
      <span class="verification__state" data-state="${escapeHtml(item.state)}">${escapeHtml(item.state)}</span>
    </li>`).join('');
}

function renderFacts(rows, unit) {
  return rows.map((item) => `
    <li class="fact-list__row"><span>${escapeHtml(item.label)}</span><span>${formatNumber(item.count)} ${escapeHtml(unit)}</span></li>`).join('');
}

function renderArticle(view, id, hidden) {
  return `
  <article class="label" id="${id}"${hidden ? ' hidden' : ''} aria-label="VibeLabel code change facts">
    <header class="label__header">
      <h1 class="label__brand">VIBELABEL</h1>
      <p class="label__subhead">CODE CHANGE FACTS · ${escapeHtml(view.mode)} MODE</p>
      <p class="label__source"><span>${escapeHtml(view.source)}</span><span>${escapeHtml(view.repository)} · ${escapeHtml(view.branch)}</span></p>
    </header>
    <section class="fact-section">
      <h2 class="fact-section__title">CHANGE SIZE</h2>
      <p class="change-total">${formatNumber(view.churn)} <span class="change-total__unit">CHANGED LINES</span></p>
      <div class="metrics">
        ${view.metrics.map((item) => `<div class="metric"><span class="metric__value">${escapeHtml(item.value)}</span><span class="metric__label">${escapeHtml(item.label)}</span></div>`).join('')}
      </div>
    </section>
    <section class="fact-section">
      <h2 class="fact-section__title">CHANGE COMPOSITION</h2>
      <ul class="composition">${renderLanguages(view.languages)}</ul>
    </section>
    <section class="fact-section">
      <h2 class="fact-section__title">VERIFICATION</h2>
      <ul class="verification">${renderChecks(view.checks)}</ul>
    </section>
    <div class="lower-facts">
      <section class="fact-section">
        <h2 class="fact-section__title">SENSITIVE AREAS</h2>
        <ul class="fact-list">${renderFacts(view.attention, 'FILE')}</ul>
      </section>
      <section class="fact-section">
        <h2 class="fact-section__title">CODE ADDITIVES</h2>
        <ul class="fact-list">${renderFacts(view.patterns, 'HIT')}</ul>
      </section>
    </div>
    <footer class="label__footer">
      <span>${escapeHtml(view.tests)} · ANALYSIS ${escapeHtml(view.coverage)}</span>
      <span>HEAD ${escapeHtml(view.head)} · LABEL ${escapeHtml(view.fingerprint)}</span>
      <span>${escapeHtml(view.secretNotice)}</span>
      <span>LOCAL ANALYSIS · NO SOURCE CODE UPLOADED</span>
    </footer>
  </article>`;
}

function svgStatus(item, y) {
  const stateClass = item.state === 'PASS' ? 'status pass' : item.state === 'FAIL' ? 'status fail' : 'status';
  return `
    <text x="92" y="${y}" class="row-label">${escapeXml(item.label)}</text>
    <rect x="788" y="${y - 27}" width="202" height="38" class="${stateClass}" />
    <text x="889" y="${y}" class="status-text ${item.state === 'PASS' ? 'pass-text' : ''}" text-anchor="middle">${escapeXml(item.state)}</text>`;
}

function svgFactRows(rows, x, y) {
  return rows.slice(0, 4).map((item, index) => `
    <text x="${x}" y="${y + index * 40}" class="small-row">${escapeXml(middleTruncate(item.label, 28))}</text>
    <text x="${x + 390}" y="${y + index * 40}" class="small-row mono" text-anchor="end">${formatNumber(item.count)}</text>`).join('');
}

export function renderSvg(view, fonts = fontBundle()) {
  const languageRows = view.languages.slice(0, 4);
  const barMax = 490;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350" role="img" aria-labelledby="title description">
  <title id="title">VibeLabel code change facts</title>
  <desc id="description">A factual summary of a Git diff with change size, composition, verification, sensitive areas, and code additives.</desc>
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
    text { fill: var(--ink); font-family: "Geist Sans"; letter-spacing: 0; }
    .mono { font-family: "Geist Mono"; font-variant-numeric: tabular-nums; }
    .paper { fill: var(--paper); }
    .frame { fill: none; stroke: var(--rule); stroke-width: 4; }
    .rule-heavy { stroke: var(--rule); stroke-width: 4; }
    .rule { stroke: var(--rule); stroke-width: 2; }
    .brand { font-size: 76px; font-weight: 800; }
    .meta { font-family: "Geist Mono"; font-size: 18px; font-weight: 500; }
    .section-title { font-size: 24px; font-weight: 750; }
    .total { font-family: "Geist Mono"; font-size: 104px; font-weight: 700; }
    .total-unit { font-size: 18px; font-weight: 700; }
    .metric-value { font-family: "Geist Mono"; font-size: 42px; font-weight: 700; }
    .metric-label { font-family: "Geist Mono"; font-size: 16px; fill: var(--muted); }
    .row-label, .small-row { font-family: "Geist Mono"; font-size: 21px; }
    .percent { font-family: "Geist Mono"; font-size: 19px; }
    .bar-track { fill: var(--paper-alt); }
    .bar-fill { fill: var(--ink); }
    .status { fill: none; stroke: var(--rule); stroke-width: 2; }
    .status.pass { fill: var(--ink); }
    .status.fail { fill: none; stroke: var(--signal); stroke-width: 6; }
    .status-text { font-family: "Geist Mono"; font-size: 17px; font-weight: 700; }
    .pass-text { fill: var(--paper); }
    .footer { font-family: "Geist Mono"; font-size: 17px; fill: var(--muted); }
  ]]></style>
  <rect width="1080" height="1350" class="paper" />
  <rect x="48" y="48" width="984" height="1254" class="frame" />
  <text x="88" y="133" class="brand">VIBELABEL</text>
  <text x="90" y="173" class="meta">CODE CHANGE FACTS · ${escapeXml(view.mode)} MODE</text>
  <text x="90" y="199" class="meta">${escapeXml(view.source)}</text>
  <text x="990" y="199" class="meta" text-anchor="end">${escapeXml(view.repository)} · ${escapeXml(view.branch)}</text>
  <line x1="88" y1="222" x2="992" y2="222" class="rule-heavy" />

  <text x="90" y="263" class="section-title">CHANGE SIZE</text>
  <text x="88" y="365" class="total">${formatNumber(view.churn)}</text>
  <text x="90" y="400" class="total-unit">CHANGED LINES</text>
  ${view.metrics.map((item, index) => {
    const x = 90 + index * 225;
    return `<text x="${x}" y="451" class="metric-value">${escapeXml(item.value)}</text><text x="${x}" y="478" class="metric-label">${escapeXml(item.label)}</text>`;
  }).join('')}
  <line x1="88" y1="505" x2="992" y2="505" class="rule" />

  <text x="90" y="545" class="section-title">CHANGE COMPOSITION</text>
  ${languageRows.map((item, index) => {
    const y = 584 + index * 42;
    const width = Math.round((Math.max(0, Math.min(100, item.percent)) / 100) * barMax);
    return `<text x="90" y="${y}" class="row-label">${escapeXml(middleTruncate(item.name, 18))}</text><rect x="315" y="${y - 18}" width="${barMax}" height="12" class="bar-track"/><rect x="315" y="${y - 18}" width="${width}" height="12" class="bar-fill"/><text x="990" y="${y}" class="percent" text-anchor="end">${escapeXml(item.percent)}%</text>`;
  }).join('')}
  <line x1="88" y1="750" x2="992" y2="750" class="rule" />

  <text x="90" y="790" class="section-title">VERIFICATION</text>
  ${view.checks.map((item, index) => svgStatus(item, 830 + index * 48)).join('')}
  <line x1="88" y1="955" x2="992" y2="955" class="rule" />

  <text x="90" y="995" class="section-title">SENSITIVE AREAS</text>
  <text x="570" y="995" class="section-title">CODE ADDITIVES</text>
  <line x1="540" y1="976" x2="540" y2="1158" class="rule" />
  ${svgFactRows(view.attention, 90, 1035)}
  ${svgFactRows(view.patterns, 570, 1035)}
  <line x1="88" y1="1172" x2="992" y2="1172" class="rule-heavy" />

  <text x="90" y="1210" class="footer">${escapeXml(view.tests)} · ANALYSIS ${escapeXml(view.coverage)}</text>
  <text x="90" y="1242" class="footer">HEAD ${escapeXml(view.head)} · LABEL ${escapeXml(view.fingerprint)}</text>
  <text x="90" y="1274" class="footer">${escapeXml(view.secretNotice)}</text>
  <text x="990" y="1274" class="footer" text-anchor="end">LOCAL · NO SOURCE UPLOADED</text>
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
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not render the label.')); };
    image.src = url;
  });

  download.addEventListener('click', async () => {
    download.dataset.state = 'loading';
    download.disabled = true;
    download.querySelector('.action__label').textContent = 'Generating';
    setStatus('Rendering a local 1080 × 1350 PNG…');
    try {
      const image = await imageFromSvg(data.svg);
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1350;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable in this browser.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed.')), 'image/png'));
      const date = new Date();
      const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('');
      const url = URL.createObjectURL(png);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'vibelabel-' + stamp + '.png';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      download.dataset.state = 'success';
      setStatus('PNG downloaded.');
    } catch (error) {
      download.dataset.state = 'error';
      setStatus(error instanceof Error ? error.message : 'PNG generation failed. Try another browser.', 'error');
    } finally {
      download.disabled = false;
      download.querySelector('.action__label').textContent = 'Download PNG';
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
      copy.querySelector('.action__label').textContent = 'Copied';
      setStatus('Summary copied using the current privacy mode.');
      setTimeout(() => {
        delete copy.dataset.state;
        copy.querySelector('.action__label').textContent = 'Copy summary';
      }, 1500);
    } catch {
      copy.dataset.state = 'error';
      setStatus('Clipboard access was blocked. Open this file in a browser with clipboard permission and try again.', 'error');
    }
  });
})();`;
}

export function renderHtml(report, options = {}) {
  const mode = options.mode === 'detailed' ? 'detailed' : 'safe';
  const fonts = fontBundle();
  const view = buildView(report, mode === 'detailed');
  const tokens = readAsset('tokens.css');
  const styles = readAsset('label.css');
  const payload = JSON.stringify({
    mode,
    svg: renderSvg(view, fonts),
    summary: view.summary,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="A local, factual label for a Git diff." />
  <title>VibeLabel · ${escapeHtml(view.source)}</title>
  <style>${tokens}\n${fontCss(fonts)}\n${styles}</style>
</head>
<body>
  <main class="app-shell">
    ${renderArticle(view, `label-${mode}`, false)}
    <aside class="tool-panel" aria-label="Label controls">
      <h2 class="tool-panel__heading">Share the facts, not the source.</h2>
      <p class="tool-panel__copy">Safe mode contains no repository or branch names. Detailed mode is a separate local file that reveals those labels, but never source snippets, secret values, absolute paths, remote URLs, or author details.</p>
      <fieldset class="segmented">
        <legend>Share mode</legend>
        <label><input type="radio" name="share-mode" value="safe"${mode === 'safe' ? ' checked' : ''} /> Safe</label>
        <label><input type="radio" name="share-mode" value="detailed"${mode === 'detailed' ? ' checked' : ''} /> Detailed</label>
      </fieldset>
      <div class="actions">
        <button class="action action--primary" id="download" type="button"><span class="action__icon" aria-hidden="true">↓</span><span class="action__label">Download PNG</span></button>
        <button class="action" id="copy" type="button"><span class="action__icon" aria-hidden="true">⧉</span><span class="action__label">Copy summary</span></button>
      </div>
      <p class="tool-status" id="tool-status" aria-live="polite">${mode === 'safe' ? 'Repository and branch names are not embedded in this file.' : 'Repository and branch names are visible in this local file.'}</p>
      <p class="tool-panel__privacy">LOCAL ANALYSIS · NO TELEMETRY · NO SOURCE UPLOAD</p>
    </aside>
  </main>
  <script id="vibelabel-data" type="application/json">${payload}</script>
  <script>${clientScript()}</script>
</body>
</html>`;
}

export function renderViews(report) {
  return { safe: buildView(report, false), detailed: buildView(report, true) };
}
