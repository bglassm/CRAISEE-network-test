const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const TARGET_ORIGIN = 'https://www.craisee.com';
const DIRS = {
  raw: path.join(ROOT, 'results', 'raw'),
  redacted: path.join(ROOT, 'results', 'redacted'),
  screenshots: path.join(ROOT, 'results', 'screenshots'),
  summaries: path.join(ROOT, 'results', 'summaries'),
  reports: path.join(ROOT, 'results', 'reports'),
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
  const startedAtMs = Date.now();

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
    reset() {
      records.length = 0;
      byRequest.clear();
    }
  };
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
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
  } catch (error) {
    notes.push(`DOMContentLoaded wait timed out: ${error.message}`);
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 12000 });
  } catch (_) {
    notes.push('networkidle not reached; continued after fixed wait');
  }
  await sleep(fixedWaitForUrl(url));
}

async function capturePerformance(page) {
  try {
    return await page.evaluate(() => ({
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON()),
      resource: performance.getEntriesByType('resource').map((entry) => entry.toJSON())
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
  const documentRecord = records.find((record) => record.classification === 'document' && record.status);
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
    domContentLoaded: nav.domContentLoadedEventEnd || null,
    loadEventTiming: nav.loadEventEnd || null,
    finishTimeLastRequestEndOffset: Math.max(0, ...records.map((record) => record.endOffsetMs || 0)),
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
    notes,
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

function writeScenarioArtifacts({ base, records, summary, performanceData }) {
  const requestLogPath = path.join(DIRS.summaries, `${base}.request-log.json`);
  const csvPath = path.join(DIRS.summaries, `${base}.request-summary.csv`);
  const summaryPath = path.join(DIRS.summaries, `${base}.summary.json`);
  const performancePath = path.join(DIRS.summaries, `${base}.performance-entries.json`);
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
  disableCache,
  acceptCookieBanner,
  stabilize,
  capturePerformance,
  summarizeRecords,
  writeScenarioArtifacts
};
