const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  ensureDirs,
  resolveRunDirs
} = require('./common');

function readSummaries(runDirs) {
  return fs.readdirSync(runDirs.summariesDir)
    .filter((file) => file.endsWith('.summary.json'))
    .map((file) => {
      const fullPath = path.join(runDirs.summariesDir, file);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const performancePath = path.join(runDirs.summariesDir, file.replace(/\.summary\.json$/, '.performance-entries.json'));
      if (fs.existsSync(performancePath)) {
        enrichTimingFromPerformanceEntries(data, JSON.parse(fs.readFileSync(performancePath, 'utf8')));
      }
      return { file, fullPath, data };
    })
    .sort((a, b) => String(a.data.scenario).localeCompare(String(b.data.scenario)));
}

function timingDelta(end, start) {
  if (!Number.isFinite(Number(end)) || !Number.isFinite(Number(start))) return null;
  const delta = Number(end) - Number(start);
  return delta >= 0 ? delta : null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  }
  return null;
}

function enrichTimingFromPerformanceEntries(data, performanceData) {
  const nav = performanceData.navigation && performanceData.navigation[0] ? performanceData.navigation[0] : {};
  const paintEntries = Array.isArray(performanceData.paint) ? performanceData.paint : [];
  const fcp = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
  if (data.documentTTFBFromRequestStartMs === undefined) {
    data.documentTTFBFromRequestStartMs = timingDelta(nav.responseStart, nav.requestStart);
  }
  if (data.documentTTFBFromNavigationStartMs === undefined) {
    data.documentTTFBFromNavigationStartMs = firstNumber(timingDelta(nav.responseStart, nav.startTime || 0), data.documentTtfb);
  }
  if (data.domContentLoadedMs === undefined) {
    data.domContentLoadedMs = firstNumber(timingDelta(nav.domContentLoadedEventEnd, nav.startTime || 0), data.domContentLoaded);
  }
  if (data.loadEventMs === undefined) {
    data.loadEventMs = firstNumber(timingDelta(nav.loadEventEnd, nav.startTime || 0), data.loadEventTiming);
  }
  if (data.lastRequestEndMs === undefined) {
    data.lastRequestEndMs = firstNumber(data.finishTimeLastRequestEndOffset);
  }
  if (data.firstContentfulPaintMs === undefined) {
    data.firstContentfulPaintMs = fcp ? fcp.startTime : null;
  }
  if (data.largestContentfulPaintMs === undefined) {
    data.largestContentfulPaintMs = performanceData.largestContentfulPaint?.startTime || null;
  }
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function fmt(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Number.isFinite(Number(value))) return String(Math.round(Number(value)));
  return String(value);
}

function fmtMs(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  if (Number.isFinite(Number(value))) return String(Math.round(Number(value)));
  return String(value);
}

function mb(bytes) {
  const value = num(bytes);
  if (!value) return '0';
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
  ].join('\n');
}

function findScenario(summaries, needle) {
  return summaries.find(({ data }) => String(data.scenario).includes(needle))?.data;
}

function evidence(summaries) {
  const explore = summaries.filter(({ data }) => String(data.scenario).includes('explore') && !data.skipped).map(({ data }) => data);
  const nonExplore = summaries.filter(({ data }) => !String(data.scenario).includes('explore') && !data.skipped).map(({ data }) => data);
  const avg = (items, field) => items.length ? items.reduce((sum, item) => sum + num(item[field]), 0) / items.length : 0;
  const exploreMain = explore.length && avg(explore, 'totalRequestCount') > avg(nonExplore, 'totalRequestCount');
  const loggedOutReaction401 = summaries.some(({ data }) => !data.loggedIn && num(data.reactionStatusBreakdown?.['401']) > 0);
  const loggedInReaction = summaries.filter(({ data }) => data.loggedIn && num(data.reactionRequestCount) > 0).map(({ data }) => data);
  const nPlusOne = loggedInReaction.some((item) => num(item.apiAssetsReactionRequestCount || item.reactionRequestCount) > 10);
  const mediaUpfront = summaries.some(({ data }) => /start|explore/.test(data.scenario) && num(data.mediaRequestCount) > 0);
  const cold = findScenario(summaries, 'mac_en-explore_logged-in_cold');
  const warm = findScenario(summaries, 'mac_en-explore_logged-in_warm');
  const warmCacheStatic = cold && warm && num(warm.jsBytes) + num(warm.imageBytes) < num(cold.jsBytes) + num(cold.imageBytes);
  const warmApiRemains = cold && warm && num(warm.fetchXhrCount) >= Math.max(1, num(cold.fetchXhrCount) * 0.6);
  return { exploreMain, loggedOutReaction401, nPlusOne, mediaUpfront, warmCacheStatic, warmApiRemains };
}

function topRequests(summaries, fieldName) {
  const key = fieldName === 'slow' ? 'top20SlowestRequests' : 'top20LargestRequests';
  return summaries
    .flatMap(({ data }) => (data[key] || []).map((request) => ({ scenario: data.scenario, ...request })))
    .sort((a, b) => num(fieldName === 'slow' ? b.durationMs : b.encodedBytes) - num(fieldName === 'slow' ? a.durationMs : a.encodedBytes))
    .slice(0, 20);
}

async function browserVersion() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return browser.version();
  } catch (_) {
    return 'Playwright Chromium installed locally';
  } finally {
    if (browser) await browser.close();
  }
}

(async () => {
  ensureDirs();
  const runDirs = resolveRunDirs(process.argv[2]);
  const summaries = readSummaries(runDirs);
  const facts = evidence(summaries);
  const version = await browserVersion();
  const generatedAt = new Date().toISOString();

  const scenarioRows = summaries.map(({ data }) => [
    data.scenario,
    data.url,
    data.skipped ? 'SKIPPED' : fmt(data.totalRequestCount),
    fmt(data.fetchXhrCount),
    fmt(data.reactionRequestCount),
    fmt(data.apiAssetsReactionRequestCount),
    fmt(data.reactionStatusBreakdown?.['401']),
    fmt(data.reactionStatusBreakdown?.['200']),
    fmt(data.mediaRequestCount),
    mb(data.jsBytes),
    mb(data.imageBytes),
    mb(data.totalEncodedDataLength),
    fmtMs(data.documentTTFBFromRequestStartMs),
    fmtMs(data.documentTTFBFromNavigationStartMs ?? data.documentTtfb),
    fmtMs(data.firstContentfulPaintMs),
    fmtMs(data.largestContentfulPaintMs),
    fmtMs(data.domContentLoadedMs ?? data.domContentLoaded),
    fmtMs(data.loadEventMs ?? data.loadEventTiming),
    fmtMs(data.lastRequestEndMs ?? data.finishTimeLastRequestEndOffset),
    fmtMs(data.visualCompleteApproxMs)
  ]);

  const slowRows = topRequests(summaries, 'slow').map((item) => [
    item.scenario,
    item.status,
    fmt(item.durationMs),
    mb(item.encodedBytes),
    item.resourceType,
    item.url
  ]);

  const largeRows = topRequests(summaries, 'large').map((item) => [
    item.scenario,
    item.status,
    fmt(item.durationMs),
    mb(item.encodedBytes),
    item.resourceType,
    item.url
  ]);

  const exploreNames = [
    'mac_en-explore_logged-out_cold_no-cookie',
    'mac_en-explore_logged-out_cold_accept-all',
    'mac_en-explore_logged-in_cold',
    'mac_en-explore_logged-in_warm',
    'mac_en-explore_logged-in_scroll',
    'mac_logged-in_spa-navigation',
    'mac_en-explore_logged-in_filter'
  ];
  const exploreRows = summaries
    .filter(({ data }) => exploreNames.includes(data.scenario))
    .map(({ data }) => [
      data.scenario,
      data.skipped ? 'SKIPPED' : fmt(data.totalRequestCount),
      fmt(data.fetchXhrCount),
      fmt(data.reactionRequestCount),
      fmt(data.apiAssetsReactionRequestCount),
      fmt(data.mediaRequestCount),
      data.notes ? data.notes.join('; ') : ''
    ]);

  const startMedia = summaries
    .filter(({ data }) => /start|explore/.test(data.scenario) && num(data.mediaRequestCount) > 0)
    .map(({ data }) => [data.scenario, fmt(data.mediaRequestCount), fmt(data.mp4RequestCount), fmt(data.webmRequestCount), mb(data.mediaBytes)]);

  const report = `# CRAISEE Local Performance Logging Report - Mac

Generated: ${generatedAt}

## Executive Summary

- Explore appears to be ${facts.exploreMain ? 'a primary bottleneck in the collected local runs' : 'not conclusively isolated as the main bottleneck from the available summaries'}.
- Reaction API N+1 pattern was ${facts.nPlusOne ? 'observed or strongly suggested by repeated reaction requests' : 'not confirmed in the available summaries'}.
- Logged-out reaction calls ${facts.loggedOutReaction401 ? 'returned 401 in at least one scenario' : 'did not show 401 in the available summaries'}.
- Logged-in reaction calls were ${facts.nPlusOne ? 'likely per-asset or repeated rather than clearly batched' : 'not conclusively per-asset from the available summaries'}.
- Media/video requests were ${facts.mediaUpfront ? 'initiated during initial page activity in at least one Start or Explore scenario' : 'not clearly initiated upfront in the available summaries'}.
- Warm cache ${facts.warmCacheStatic ? 'reduced static asset bytes' : 'did not clearly reduce static asset bytes'} and API congestion ${facts.warmApiRemains ? 'appears to remain' : 'was not confirmed from the warm/cold comparison'}.

## Environment

- OS: macOS
- Browser: Playwright Chromium ${version}
- Date/time: ${generatedAt}
- Network: local environment, no throttling unless specified
- Login states tested: logged-out plus logged-in when \`private/auth-state.json\` was present

## Timing Metrics

- TTFB: server/edge/backend first-byte response timing. \`TTFB reqStart\` is \`responseStart - requestStart\`; \`TTFB navStart\` is \`responseStart - navigation.startTime\`.
- DOMContentLoaded: HTML parsed and DOM ready, but not necessarily visually complete.
- Load: browser load event, which may not fire reliably or may be delayed when media/API activity continues.
- Last request: end of the latest captured network request. This is network activity duration, not visual render completion.
- FCP: first visible content.
- LCP: largest visible content, closer to perceived loading.
- Visual approx: screenshot time after the stabilization wait, not a formal Web Vital.

## Scenario Summary Table

${table([
  'Scenario',
  'URL',
  'Requests',
  'Fetch/XHR',
  'reaction requests',
  '/api/assets/reaction',
  'reaction 401',
  'reaction 200',
  'media requests',
  'JS bytes',
  'image bytes',
  'encoded bytes',
  'TTFB reqStart',
  'TTFB navStart',
  'FCP',
  'LCP',
  'DOMContentLoaded',
  'Load',
  'Last request',
  'Visual approx'
], scenarioRows)}

## Explore Deep Dive

${exploreRows.length ? table(['Scenario', 'Requests', 'Fetch/XHR', 'reaction', '/api/assets/reaction', 'media', 'Notes'], exploreRows) : 'No Explore summaries found.'}

## Media Findings

${startMedia.length ? table(['Scenario', 'Media requests', 'MP4', 'WebM', 'Media bytes'], startMedia) : 'No Start or Explore media requests were captured in the available summaries.'}

## Cache Findings

- Cold vs warm comparison should focus on \`mac_en-explore_logged-in_cold\`, \`mac_en-explore_logged-in_warm\`, and the logged-out warm Explore run.
- Warm cache static asset reduction: ${facts.warmCacheStatic ? 'observed' : 'not confirmed'}.
- API congestion remaining after warm cache: ${facts.warmApiRemains ? 'observed or suggested' : 'not confirmed'}.

## Top Requests

### Slowest Requests

${slowRows.length ? table(['Scenario', 'Status', 'Duration ms', 'Encoded bytes', 'Type', 'URL'], slowRows) : 'No request timing data available.'}

### Largest Requests

${largeRows.length ? table(['Scenario', 'Status', 'Duration ms', 'Encoded bytes', 'Type', 'URL'], largeRows) : 'No request size data available.'}

## Engineering Recommendations

### P0

- Bypass reaction API for logged-out users.
- Batch reaction data or include it in the asset list response.
- Reduce initial Explore asset count and use virtualization for offscreen content.

### P1

- Use video poster images.
- Set \`preload="none"\` for offscreen videos.
- Lazy-load media when items approach the viewport.
- Preserve Explore state during SPA navigation.

### P2

- Run bundle analysis for heavy client JavaScript.
- Defer Clerk/Auth and third-party scripts where possible.
`;

  const outPath = path.join(runDirs.reportDir, 'craisee-performance-report.md');
  fs.writeFileSync(outPath, report);
  console.log(`Run folder: ${runDirs.runDir}`);
  console.log(`Report written: ${outPath}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
