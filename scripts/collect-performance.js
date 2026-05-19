const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  AUTH_STATE_PATH,
  DIRS,
  ensureDirs,
  timestamp,
  fileBase,
  sleep,
  createNetworkLogger,
  disableCache,
  acceptCookieBanner,
  stabilize,
  capturePerformance,
  summarizeRecords,
  writeScenarioArtifacts
} = require('./common');

const scenarios = [
  { name: 'mac_en-explore_logged-out_cold_no-cookie', url: 'https://www.craisee.com/en/explore', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'none' },
  { name: 'mac_en-explore_logged-out_cold_accept-all', url: 'https://www.craisee.com/en/explore', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'accept-all' },
  { name: 'mac_en-explore_logged-out_warm_accept-all', url: 'https://www.craisee.com/en/explore', loggedIn: false, cache: 'warm', disableCache: false, cookieAction: 'accept-all', warmPass: true },
  { name: 'mac_en-explore_logged-in_cold', url: 'https://www.craisee.com/en/explore', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored' },
  { name: 'mac_en-explore_logged-in_warm', url: 'https://www.craisee.com/en/explore', loggedIn: true, cache: 'warm', disableCache: false, cookieAction: 'stored', warmPass: true },
  { name: 'mac_en-start_logged-out_cold_accept-all', url: 'https://www.craisee.com/en/start', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'accept-all' },
  { name: 'mac_en-start_logged-in_cold', url: 'https://www.craisee.com/en/start', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored' },
  { name: 'mac_en-create_logged-out_cold_accept-all', url: 'https://www.craisee.com/en/create', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'accept-all' },
  { name: 'mac_en-create_logged-in_cold', url: 'https://www.craisee.com/en/create', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored' },
  { name: 'mac_en-pricing_logged-out_cold_accept-all', url: 'https://www.craisee.com/en/pricing', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'accept-all' },
  { name: 'mac_ko-explore_logged-out_cold_accept-all', url: 'https://www.craisee.com/ko/explore', loggedIn: false, cache: 'cold', disableCache: true, cookieAction: 'accept-all' },
  { name: 'mac_ko-explore_logged-in_cold', url: 'https://www.craisee.com/ko/explore', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored' },
  { name: 'mac_en-explore_logged-in_scroll', url: 'https://www.craisee.com/en/explore', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored', kind: 'scroll' },
  { name: 'mac_logged-in_spa-navigation', url: 'https://www.craisee.com/en/start', startUrl: 'https://www.craisee.com/en/start', loggedIn: true, cache: 'warm', disableCache: false, cookieAction: 'stored', kind: 'spa' },
  { name: 'mac_en-explore_logged-in_filter', url: 'https://www.craisee.com/en/explore', loggedIn: true, cache: 'cold', disableCache: true, cookieAction: 'stored', kind: 'filter' }
];

async function clickNavOrGoto(page, targetText, fallbackUrl, notes) {
  try {
    const link = page.getByRole('link', { name: new RegExp(targetText, 'i') }).first();
    if (await link.isVisible({ timeout: 3000 })) {
      await link.click({ timeout: 8000 });
      return 'click';
    }
  } catch (error) {
    notes.push(`SPA nav click for ${targetText} failed: ${error.message}`);
  }
  notes.push(`SPA nav used page.goto fallback for ${fallbackUrl}`);
  await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return 'goto-fallback';
}

async function tryFilter(page, notes) {
  const beforeUrl = page.url();
  const candidates = [
    page.getByRole('button', { name: /filter|category|sort|latest|popular/i }).first(),
    page.getByRole('combobox').first(),
    page.locator('button').filter({ hasText: /all|latest|popular|category|filter/i }).first()
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 2500 })) {
        await locator.click({ timeout: 5000 });
        await sleep(2000);
        notes.push(`Filter interaction attempted from ${beforeUrl}`);
        return true;
      }
    } catch (error) {
      notes.push(`Filter candidate failed: ${error.message}`);
    }
  }
  notes.push('Filter interaction skipped: no reliable visible filter selector found');
  return false;
}

function skippedSummary(scenario, reason) {
  const startedAt = timestamp();
  const base = fileBase(scenario.name, startedAt);
  const summary = summarizeRecords({
    scenario,
    records: [],
    performanceData: { navigation: [], resource: [] },
    notes: [`Skipped: ${reason}`],
    extra: { skipped: true, skipReason: reason }
  });
  const paths = writeScenarioArtifacts({ base, records: [], summary, performanceData: { navigation: [], resource: [] } });
  return { scenario: scenario.name, skipped: true, paths };
}

async function runScenario(browser, scenario, hasAuth) {
  if (scenario.loggedIn && !hasAuth) {
    console.log(`Skipping ${scenario.name}: auth state missing.`);
    return skippedSummary(scenario, 'auth state missing');
  }

  const startedAt = timestamp();
  const base = fileBase(scenario.name, startedAt);
  const harPath = path.join(DIRS.raw, `${base}.har`);
  const screenshotPath = path.join(DIRS.screenshots, `${base}.png`);
  const notes = [];
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    recordHar: {
      path: harPath,
      content: 'embed',
      mode: 'full'
    }
  };
  if (scenario.loggedIn) contextOptions.storageState = AUTH_STATE_PATH;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const logger = createNetworkLogger(page, scenario.name, startedAt);
  let performanceData = { navigation: [], resource: [] };
  let extra = {};

  try {
    page.setDefaultTimeout(20000);
    if (scenario.disableCache) {
      const disabled = await disableCache(page);
      notes.push(disabled ? 'CDP cache disabled' : 'CDP cache disable failed');
    }

    if (scenario.warmPass) {
      notes.push('Warm scenario: HAR may include warm-up pass; JSON/CSV logger resets before measured pass.');
      await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (scenario.cookieAction === 'accept-all') notes.push(`Cookie banner warm pass: ${await acceptCookieBanner(page)}`);
      await stabilize(page, scenario.url, notes);
      logger.reset();
    }

    await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (scenario.cookieAction === 'accept-all') notes.push(`Cookie banner: ${await acceptCookieBanner(page)}`);
    await stabilize(page, scenario.url, notes);

    if (scenario.kind === 'scroll') {
      const preRecords = logger.records.slice();
      const prePerformanceData = await capturePerformance(page);
      const preSummary = summarizeRecords({ scenario, records: preRecords, performanceData: prePerformanceData, notes: notes.slice() });
      const preSummaryPath = path.join(DIRS.summaries, `${base}.pre-scroll.summary.json`);
      fs.writeFileSync(preSummaryPath, JSON.stringify(preSummary, null, 2));
      notes.push(`Pre-scroll summary saved: ${preSummaryPath}`);
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 900);
        await sleep(900);
      }
      await sleep(20000);
      const postRecords = logger.records.slice();
      const deltaRecords = postRecords.slice(preRecords.length);
      extra.scrollDelta = {
        additionalTotalRequests: deltaRecords.length,
        additionalReactionRequests: deltaRecords.filter((record) => record.url.toLowerCase().includes('reaction')).length,
        additionalMediaRequests: deltaRecords.filter((record) => record.classification === 'media/video/audio').length,
        additionalImageRequests: deltaRecords.filter((record) => record.classification === 'image').length,
        additionalAssetApiRequests: deltaRecords.filter((record) => record.url.includes('/api/assets') || /\/api\/.*assets?/i.test(record.url)).length
      };
    }

    if (scenario.kind === 'spa') {
      const navResults = [];
      const steps = [
        ['Explore', 'https://www.craisee.com/en/explore'],
        ['Create', 'https://www.craisee.com/en/create'],
        ['Pricing', 'https://www.craisee.com/en/pricing'],
        ['Explore', 'https://www.craisee.com/en/explore']
      ];
      for (const [label, url] of steps) {
        const method = await clickNavOrGoto(page, label, url, notes);
        navResults.push({ label, url, method });
        await stabilize(page, url, notes);
      }
      const exploreReturnRequests = logger.records.filter((record) => record.url.includes('/en/explore') || record.url.toLowerCase().includes('reaction') || record.url.toLowerCase().includes('media'));
      extra.spaNavigation = {
        navResults,
        fallbackUsed: navResults.some((item) => item.method !== 'click'),
        exploreRelatedRequestCount: exploreReturnRequests.length,
        reactionRequestsObserved: logger.records.filter((record) => record.url.toLowerCase().includes('reaction')).length,
        mediaRequestsObserved: logger.records.filter((record) => record.classification === 'media/video/audio').length,
        apiRequestsObserved: logger.records.filter((record) => /\/api\//i.test(record.url)).length
      };
    }

    if (scenario.kind === 'filter') {
      const beforeCount = logger.records.length;
      const interacted = await tryFilter(page, notes);
      if (interacted) await sleep(10000);
      const deltaRecords = logger.records.slice(beforeCount);
      extra.filter = {
        attempted: interacted,
        additionalRequests: deltaRecords.length,
        additionalReactionRequests: deltaRecords.filter((record) => record.url.toLowerCase().includes('reaction')).length,
        additionalAssetApiRequests: deltaRecords.filter((record) => record.url.includes('/api/assets') || /\/api\/.*assets?/i.test(record.url)).length
      };
    }

    performanceData = await capturePerformance(page);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    notes.push(`Scenario error: ${error.stack || error.message}`);
    try {
      performanceData = await capturePerformance(page);
    } catch (_) {
      // Already best effort.
    }
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (screenshotError) {
      notes.push(`Screenshot failed: ${screenshotError.message}`);
    }
  } finally {
    await context.close();
  }

  const summary = summarizeRecords({
    scenario,
    records: logger.records,
    performanceData,
    notes,
    extra: { ...extra, rawHarPath: harPath, screenshotPath }
  });
  const paths = writeScenarioArtifacts({ base, records: logger.records, summary, performanceData });
  return { scenario: scenario.name, skipped: false, paths: { ...paths, harPath, screenshotPath } };
}

(async () => {
  ensureDirs();
  const hasAuth = fs.existsSync(AUTH_STATE_PATH);
  if (!hasAuth) {
    console.log('private/auth-state.json not found. Logged-in scenarios will be skipped.');
  }

  const browser = await chromium.launch({ headless: true });
  const outputs = [];
  try {
    for (const scenario of scenarios) {
      console.log(`\nRunning ${scenario.name}`);
      const result = await runScenario(browser, scenario, hasAuth);
      outputs.push(result);
    }
  } finally {
    await browser.close();
  }

  console.log('\nCollection complete. Output paths:');
  for (const output of outputs) {
    console.log(`- ${output.scenario}${output.skipped ? ' (skipped)' : ''}`);
    for (const value of Object.values(output.paths || {})) {
      console.log(`  ${value}`);
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
