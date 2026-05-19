const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const TARGET_ORIGIN = 'https://www.craisee.com';
const DIRS = {
  results: path.join(ROOT, 'results'),
  private: path.join(ROOT, 'private')
};
const AUTH_STATE_PATH = path.join(DIRS.private, 'auth-state.json');

const KEYWORDS = [
  'reaction',
  '/api/assets/reaction',
  'asset',
  'assets',
  'like',
  'favorite',
  'bookmark',
  'vote',
  '_rsc',
  'clerk',
  'google-analytics',
  'googletagmanager',
  'mp4',
  'webm'
];

function ensureDirs() {
  Object.values(DIRS).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function runFolderBase(date = new Date()) {
  return `${pad2(date.getFullYear() % 100)}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function isRunFolderName(name) {
  return /^\d{6}_\d{4}(?:_\d+)?$/.test(name);
}

function runPaths(runDir) {
  return {
    runDir,
    reportDir: path.join(runDir, 'report'),
    redactedHarDir: path.join(runDir, 'redacted-har'),
    summariesDir: path.join(runDir, 'summaries'),
    screenshotsDir: path.join(runDir, 'screenshots'),
    rawPrivateDir: path.join(runDir, 'raw-private')
  };
}

function ensureRunSubdirs(paths) {
  for (const dir of [
    paths.runDir,
    paths.reportDir,
    paths.redactedHarDir,
    paths.summariesDir,
    paths.screenshotsDir,
    paths.rawPrivateDir
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeRunReadmes(paths);
}

function createRunDirs(baseName = runFolderBase()) {
  ensureDirs();
  let name = baseName;
  let suffix = 2;
  while (fs.existsSync(path.join(DIRS.results, name))) {
    name = `${baseName}_${suffix}`;
    suffix += 1;
  }
  const paths = runPaths(path.join(DIRS.results, name));
  ensureRunSubdirs(paths);
  return paths;
}

function listRunDirs() {
  ensureDirs();
  return fs.readdirSync(DIRS.results, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRunFolderName(entry.name))
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(DIRS.results, entry.name),
      mtimeMs: fs.statSync(path.join(DIRS.results, entry.name)).mtimeMs
    }))
    .sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name, undefined, { numeric: true });
      return nameCompare || (a.mtimeMs - b.mtimeMs);
    });
}

function latestRunDirs() {
  const runs = listRunDirs();
  if (!runs.length) return null;
  const latest = runs[runs.length - 1];
  const paths = runPaths(latest.fullPath);
  ensureRunSubdirs(paths);
  return paths;
}

function resolveRunDirs(runArg, { createIfMissing = false, defaultToLatest = true } = {}) {
  if (runArg) {
    const runName = path.basename(runArg);
    if (!isRunFolderName(runName)) {
      throw new Error(`Invalid run folder name: ${runArg}`);
    }
    const paths = runPaths(path.join(DIRS.results, runName));
    if (!fs.existsSync(paths.runDir) && !createIfMissing) {
      throw new Error(`Run folder not found: ${paths.runDir}`);
    }
    ensureRunSubdirs(paths);
    return paths;
  }
  if (defaultToLatest) {
    const latest = latestRunDirs();
    if (latest) return latest;
  }
  return createRunDirs();
}

function writeRunReadmes(paths) {
  const readmePath = path.join(paths.runDir, 'README_FOR_ALEXANDER.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# CRAISEE Performance Logging Results

This package contains local CRAISEE performance logging results.

It includes:
- a markdown report
- redacted HAR files
- JSON/CSV summaries
- screenshots

Raw private files are intentionally excluded from the shareable package. Non-redacted HAR files, richer request logs, and other private diagnostics stay in \`raw-private/\` for local review only.

\`Last request\` is network activity duration, not visual render completion. TTFB/FCP/LCP fields are included when available. FCP/LCP require newly collected runs after the timing update.

## Key Finding Template

- Explore reaction API count:
- reaction 401/200 count:
- media request count:
- warm cache behavior:
- SPA navigation behavior:

## Do Not Share

Do not share \`raw-private/\`, \`private/auth-state.json\`, raw traces, non-redacted HAR files, cookies, tokens, Clerk session data, Authorization headers, or post bodies.
`);
  }

  const rawReadmePath = path.join(paths.rawPrivateDir, 'DO_NOT_SHARE_README.md');
  if (!fs.existsSync(rawReadmePath)) {
    fs.writeFileSync(rawReadmePath, `# Do Not Share

This folder is for private local diagnostics only.

It may contain raw HAR files, richer request logs, traces, URLs, headers, or other data that needs manual review before sharing. Do not include this folder in public packages or commits.
`);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeFilename(value) {
  return String(value || 'scenario')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function fileBase(scenarioName, startedAt = timestamp()) {
  return `${startedAt}_${sanitizeFilename(scenarioName)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function isSensitiveHeader(name) {
  const lower = String(name).toLowerCase();
  return lower === 'cookie' ||
    lower === 'set-cookie' ||
    lower === 'authorization' ||
    lower === 'proxy-authorization' ||
    lower.startsWith('x-clerk');
}

function safeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = isSensitiveHeader(name) ? '[REDACTED]' : value;
  }
  return out;
}

function classifyRequest(resourceType, url = '') {
  const lower = url.toLowerCase();
  if (resourceType === 'document') return 'document';
  if (resourceType === 'xhr' || resourceType === 'fetch') return 'fetch/xhr';
  if (resourceType === 'script' || lower.endsWith('.js')) return 'script/js';
  if (resourceType === 'stylesheet' || lower.endsWith('.css')) return 'stylesheet/css';
  if (resourceType === 'image' || /\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(lower)) return 'image';
  if (resourceType === 'media' || /\.(mp4|webm|mov|m4v|mp3|wav|ogg)(\?|$)/i.test(lower)) return 'media/video/audio';
  if (resourceType === 'font' || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(lower)) return 'font';
  return 'other';
}

function getKeywordFlags(url = '') {
  const lower = url.toLowerCase();
  return KEYWORDS.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

function contentLength(headers = {}) {
  const raw = headers['content-length'] || headers['Content-Length'];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function createNetworkLogger(page, scenarioName, startedAtIso) {
  const records = [];
  const byRequest = new Map();
  let startedAtMs = Date.now();

  page.on('request', (request) => {
    const now = Date.now();
    const record = {
      scenario: scenarioName,
      startedAt: startedAtIso,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      classification: classifyRequest(request.resourceType(), request.url()),
      requestHeadersSafe: safeHeaders(request.headers()),
      responseHeadersSafe: null,
      status: null,
      statusText: '',
      contentType: '',
      startTime: new Date(now).toISOString(),
      endTime: null,
      startOffsetMs: now - startedAtMs,
      endOffsetMs: null,
      durationMs: null,
      encodedBytes: 0,
      transferBytes: 0,
      fromCache: 'unknown',
      failed: false,
      failureText: '',
      initiator: null,
      keywordFlags: getKeywordFlags(request.url())
    };
    byRequest.set(request, record);
    records.push(record);
  });

  page.on('response', async (response) => {
    const request = response.request();
    const record = byRequest.get(request);
    if (!record) return;
    const now = Date.now();
    const headers = response.headers();
    record.status = response.status();
    record.statusText = response.statusText();
    record.responseHeadersSafe = safeHeaders(headers);
    record.contentType = headers['content-type'] || '';
    record.endTime = new Date(now).toISOString();
    record.endOffsetMs = now - startedAtMs;
    record.durationMs = record.endOffsetMs - record.startOffsetMs;
    record.encodedBytes = contentLength(headers);
    record.transferBytes = record.encodedBytes;
    record.fromCache = response.fromServiceWorker() ? 'service-worker' : 'unknown';
    try {
      const sizes = await request.sizes();
      if (sizes) {
        record.encodedBytes = sizes.responseBodySize || record.encodedBytes || 0;
        record.transferBytes = (sizes.responseHeadersSize || 0) + (sizes.responseBodySize || 0);
      }
    } catch (_) {
      // Size data is best effort.
    }
  });

  page.on('requestfailed', (request) => {
    const record = byRequest.get(request);
    if (!record) return;
    const now = Date.now();
    const failure = request.failure();
    record.failed = true;
    record.failureText = failure ? failure.errorText : 'unknown failure';
    record.endTime = new Date(now).toISOString();
    record.endOffsetMs = now - startedAtMs;
    record.durationMs = record.endOffsetMs - record.startOffsetMs;
  });

  return {
    records,
    elapsedMs() {
      return Date.now() - startedAtMs;
    },
    reset() {
      records.length = 0;
      byRequest.clear();
      startedAtMs = Date.now();
    }
  };
}

async function installLcpObserver(page) {
  try {
    await page.addInitScript(() => {
      window.__craiseePerf = window.__craiseePerf || {};
      window.__craiseePerf.largestContentfulPaint = null;
      window.__craiseePerf.lcpSupported = false;
      try {
        const observer = new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          const lastEntry = entries[entries.length - 1];
          if (lastEntry) {
            window.__craiseePerf.largestContentfulPaint = {
              startTime: lastEntry.startTime,
              renderTime: lastEntry.renderTime,
              loadTime: lastEntry.loadTime,
              size: lastEntry.size,
              element: lastEntry.element ? lastEntry.element.tagName : null,
              url: lastEntry.url || ''
            };
          }
        });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
        window.__craiseePerf.lcpSupported = true;
      } catch (error) {
        window.__craiseePerf.lcpError = error.message;
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function disableCache(page) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function acceptCookieBanner(page) {
  const labels = ['Accept All', 'Accept all', 'Accept', 'Reject All', 'Reject all'];
  for (const label of labels) {
    try {
      const button = page.getByRole('button', { name: label, exact: true }).first();
      if (await button.isVisible({ timeout: 1500 })) {
        await button.click({ timeout: 3000 });
        return `clicked "${label}"`;
      }
    } catch (_) {
      // Try the next common label.
    }
  }
  for (const label of labels) {
    try {
      const text = page.getByText(label, { exact: true }).first();
      if (await text.isVisible({ timeout: 1000 })) {
        await text.click({ timeout: 3000 });
        return `clicked text "${label}"`;
      }
    } catch (_) {
      // Banner may not be present.
    }
  }
  return 'not found';
}

function fixedWaitForUrl(url) {
  if (/\/(en|ko)\/explore/.test(url)) return 12000;
  if (/\/en\/start/.test(url)) return 10000;
  if (/\/en\/(create|pricing)/.test(url)) return 8000;
  return 10000;
}

async function stabilize(page, url, notes) {
  let networkIdleReached = true;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
  } catch (error) {
    notes.push(`DOMContentLoaded wait timed out: ${error.message}`);
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 });
  } catch (_) {
    networkIdleReached = false;
    notes.push('networkidle not reached; continued after fixed wait');
  }
  await sleep(fixedWaitForUrl(url));
  return networkIdleReached;
}

async function capturePerformance(page) {
  try {
    return await page.evaluate(() => ({
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      resource: performance.getEntriesByType('resource').map((entry) => entry.toJSON()),
      paint: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
      largestContentfulPaint: window.__craiseePerf?.largestContentfulPaint || null,
      largestContentfulPaintSupported: Boolean(window.__craiseePerf?.lcpSupported),
      largestContentfulPaintError: window.__craiseePerf?.lcpError || null
    }));
  } catch (error) {
    return { navigation: [], resource: [], error: error.message };
  }
}

function statusBreakdown(records, predicate) {
  const out = { '200': 0, '204': 0, '304': 0, '401': 0, '403': 0, '404': 0, '500': 0, other: 0 };
  for (const record of records.filter(predicate)) {
    const key = String(record.status || 'other');
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] += 1;
    else out.other += 1;
  }
  return out;
}

function summarizeRecords({ scenario, records, performanceData, notes, extra = {} }) {
  const byClass = (classification) => records.filter((record) => record.classification === classification);
  const bytesByClass = (classification) => byClass(classification).reduce((sum, record) => sum + (record.encodedBytes || 0), 0);
  const countWhere = (predicate) => records.filter(predicate).length;
  const urlHas = (keyword) => (record) => record.url.toLowerCase().includes(keyword.toLowerCase());
  const nav = performanceData.navigation && performanceData.navigation[0] ? performanceData.navigation[0] : {};
  const paintEntries = Array.isArray(performanceData.paint) ? performanceData.paint : [];
  const firstContentfulPaint = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
  const lcpEntry = performanceData.largestContentfulPaint || null;
  const documentRecord = records.find((record) => record.classification === 'document' && record.status);
  const timingValue = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const timingDelta = (end, start) => {
    if (!Number.isFinite(Number(end)) || !Number.isFinite(Number(start))) return null;
    const delta = Number(end) - Number(start);
    return delta >= 0 ? delta : null;
  };
  const lastRequestEndMs = Math.max(0, ...records.map((record) => record.endOffsetMs || 0));
  const derivedNotes = [...notes];
  if (!lcpEntry && performanceData.largestContentfulPaintSupported === false) {
    derivedNotes.push('largestContentfulPaintMs unavailable: PerformanceObserver was not installed or supported');
  }
  if (Number.isFinite(Number(extra.visualCompleteApproxMs))) {
    derivedNotes.push('visualCompleteApproxMs is screenshot time after stabilization wait, not a formal Web Vital');
  }
  const topBy = (field) => records
    .filter((record) => Number.isFinite(record[field]) && record[field] > 0)
    .sort((a, b) => b[field] - a[field])
    .slice(0, 20)
    .map((record) => ({
      url: record.url,
      method: record.method,
      resourceType: record.resourceType,
      status: record.status,
      durationMs: record.durationMs,
      encodedBytes: record.encodedBytes,
      contentType: record.contentType
    }));

  return {
    scenario: scenario.name,
    url: scenario.url || scenario.startUrl || '',
    timestamp: new Date().toISOString(),
    loggedIn: Boolean(scenario.loggedIn),
    cacheMode: scenario.cache || 'unknown',
    cookieAction: scenario.cookieAction || 'none',
    totalRequestCount: records.length,
    totalTransferSize: records.reduce((sum, record) => sum + (record.transferBytes || 0), 0),
    totalEncodedDataLength: records.reduce((sum, record) => sum + (record.encodedBytes || 0), 0),
    fetchXhrCount: countWhere((record) => record.classification === 'fetch/xhr'),
    jsCount: byClass('script/js').length,
    jsBytes: bytesByClass('script/js'),
    cssCount: byClass('stylesheet/css').length,
    cssBytes: bytesByClass('stylesheet/css'),
    imageCount: byClass('image').length,
    imageBytes: bytesByClass('image'),
    mediaCount: byClass('media/video/audio').length,
    mediaBytes: bytesByClass('media/video/audio'),
    fontCount: byClass('font').length,
    fontBytes: bytesByClass('font'),
    documentTtfb: nav.responseStart || (documentRecord ? documentRecord.durationMs : null),
    documentTTFBFromRequestStartMs: timingDelta(nav.responseStart, nav.requestStart),
    documentTTFBFromNavigationStartMs: timingDelta(nav.responseStart, nav.startTime || 0),
    domContentLoaded: nav.domContentLoadedEventEnd || null,
    domContentLoadedMs: timingDelta(nav.domContentLoadedEventEnd, nav.startTime || 0),
    loadEventTiming: nav.loadEventEnd || null,
    loadEventMs: timingValue(nav.loadEventEnd) === null ? null : timingDelta(nav.loadEventEnd, nav.startTime || 0),
    finishTimeLastRequestEndOffset: lastRequestEndMs,
    lastRequestEndMs,
    firstContentfulPaintMs: firstContentfulPaint ? firstContentfulPaint.startTime : null,
    largestContentfulPaintMs: lcpEntry ? lcpEntry.startTime : null,
    largestContentfulPaintEntry: lcpEntry,
    networkIdleReached: Object.prototype.hasOwnProperty.call(extra, 'networkIdleReached') ? extra.networkIdleReached : null,
    screenshotCapturedAtMs: Object.prototype.hasOwnProperty.call(extra, 'screenshotCapturedAtMs') ? extra.screenshotCapturedAtMs : null,
    visualCompleteApproxMs: Object.prototype.hasOwnProperty.call(extra, 'visualCompleteApproxMs') ? extra.visualCompleteApproxMs : null,
    reactionRequestCount: countWhere(urlHas('reaction')),
    apiAssetsReactionRequestCount: countWhere(urlHas('/api/assets/reaction')),
    reactionStatusBreakdown: statusBreakdown(records, urlHas('reaction')),
    assetApiRequestCount: countWhere((record) => /\/api\/.*assets?|assets?\/api/i.test(record.url) || record.url.includes('/api/assets')),
    rscRequestCount: countWhere(urlHas('_rsc')),
    mediaRequestCount: countWhere((record) => record.classification === 'media/video/audio'),
    mp4RequestCount: countWhere(urlHas('mp4')),
    webmRequestCount: countWhere(urlHas('webm')),
    clerkRequestCount: countWhere(urlHas('clerk')),
    gaGtmRequestCount: countWhere((record) => urlHas('google-analytics')(record) || urlHas('googletagmanager')(record)),
    failedRequestCount: countWhere((record) => record.failed),
    top20SlowestRequests: topBy('durationMs'),
    top20LargestRequests: topBy('encodedBytes'),
    notes: derivedNotes,
    ...extra
  };
}

function csvRows(records) {
  return records.map((record) => ({
    scenario: record.scenario,
    startedAt: record.startedAt,
    method: record.method,
    url: record.url,
    resourceType: record.resourceType,
    status: record.status,
    statusText: record.statusText,
    durationMs: record.durationMs,
    encodedBytes: record.encodedBytes,
    contentType: record.contentType,
    fromCache: record.fromCache,
    failed: record.failed,
    failureText: record.failureText,
    keywordFlags: record.keywordFlags
  }));
}

function writeScenarioArtifacts({ base, records, summary, performanceData, runDirs }) {
  const dirs = runDirs || resolveRunDirs(null);
  const requestLogPath = path.join(dirs.rawPrivateDir, `${base}.request-log.json`);
  const csvPath = path.join(dirs.summariesDir, `${base}.request-summary.csv`);
  const summaryPath = path.join(dirs.summariesDir, `${base}.summary.json`);
  const performancePath = path.join(dirs.summariesDir, `${base}.performance-entries.json`);
  fs.writeFileSync(requestLogPath, JSON.stringify(records, null, 2));
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(performancePath, JSON.stringify(performanceData, null, 2));
  writeCsv(csvPath, csvRows(records), [
    'scenario',
    'startedAt',
    'method',
    'url',
    'resourceType',
    'status',
    'statusText',
    'durationMs',
    'encodedBytes',
    'contentType',
    'fromCache',
    'failed',
    'failureText',
    'keywordFlags'
  ]);
  return { requestLogPath, csvPath, summaryPath, performancePath };
}

module.exports = {
  ROOT,
  TARGET_ORIGIN,
  DIRS,
  AUTH_STATE_PATH,
  KEYWORDS,
  ensureDirs,
  runFolderBase,
  isRunFolderName,
  createRunDirs,
  latestRunDirs,
  resolveRunDirs,
  writeRunReadmes,
  timestamp,
  sanitizeFilename,
  fileBase,
  sleep,
  prompt,
  safeHeaders,
  classifyRequest,
  getKeywordFlags,
  writeCsv,
  createNetworkLogger,
  installLcpObserver,
  disableCache,
  acceptCookieBanner,
  stabilize,
  capturePerformance,
  summarizeRecords,
  writeScenarioArtifacts
};
