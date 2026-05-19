const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  AUTH_STATE_PATH,
  createRunDirs,
  ensureDirs,
  latestRunDirs,
  timestamp,
  fileBase,
  prompt,
  createNetworkLogger,
  installLcpObserver,
  stabilize,
  capturePerformance,
  summarizeRecords,
  writeScenarioArtifacts
} = require('./common');

function yes(value) {
  return /^(y|yes|true|1)$/i.test(String(value).trim());
}

(async () => {
  ensureDirs();
  const latestRun = latestRunDirs();
  let runDirs = latestRun;
  if (latestRun) {
    const answer = await prompt(`Append to latest run folder ${path.basename(latestRun.runDir)}? (Y/n): `);
    if (/^(n|no)$/i.test(answer.trim())) {
      runDirs = createRunDirs();
    }
  } else {
    runDirs = createRunDirs();
  }
  console.log(`Using run folder: ${runDirs.runDir}`);

  const hasAuth = fs.existsSync(AUTH_STATE_PATH);
  const useAuthAnswer = hasAuth
    ? await prompt('Use logged-in state from private/auth-state.json? (y/N): ')
    : 'n';
  const useAuth = hasAuth && yes(useAuthAnswer);
  const scenarioNameAnswer = await prompt('Scenario name: ');
  const startUrlAnswer = await prompt('Starting URL [https://www.craisee.com/en/explore]: ');

  const scenario = {
    name: scenarioNameAnswer.trim() || 'manual-craisee-scenario',
    url: startUrlAnswer.trim() || 'https://www.craisee.com/en/explore',
    loggedIn: useAuth,
    cache: 'manual',
    cookieAction: 'manual'
  };

  const startedAt = timestamp();
  const base = fileBase(scenario.name, startedAt);
  const harPath = path.join(runDirs.rawPrivateDir, `${base}.har`);
  const screenshotPath = path.join(runDirs.screenshotsDir, `${base}.png`);
  const notes = ['Manual logging scenario'];

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    storageState: useAuth ? AUTH_STATE_PATH : undefined,
    recordHar: {
      path: harPath,
      content: 'embed',
      mode: 'full'
    }
  });
  const page = await context.newPage();
  await installLcpObserver(page);
  const logger = createNetworkLogger(page, scenario.name, startedAt);
  let performanceData = { navigation: [], resource: [] };
  let networkIdleReached = true;
  let screenshotCapturedAtMs = null;

  try {
    console.log('\nOpening browser for manual logging.');
    console.log('Perform the actions manually: navigate, scroll, filter, etc.');
    console.log('When done, return to terminal and press Enter.\n');

    await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    networkIdleReached = await stabilize(page, scenario.url, notes);
    await prompt('Press Enter when manual actions are complete...');

    performanceData = await capturePerformance(page);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshotCapturedAtMs = logger.elapsedMs();
  } catch (error) {
    notes.push(`Manual scenario error: ${error.stack || error.message}`);
    try {
      performanceData = await capturePerformance(page);
    } catch (_) {
      // Best effort.
    }
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshotCapturedAtMs = logger.elapsedMs();
    } catch (screenshotError) {
      notes.push(`Screenshot failed: ${screenshotError.message}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const summary = summarizeRecords({
    scenario,
    records: logger.records,
    performanceData,
    notes,
    extra: {
      networkIdleReached,
      screenshotCapturedAtMs,
      visualCompleteApproxMs: screenshotCapturedAtMs,
      rawHarPath: harPath,
      screenshotPath
    }
  });
  const paths = writeScenarioArtifacts({ base, records: logger.records, summary, performanceData, runDirs });

  console.log('\nManual collection complete. Output paths:');
  console.log(`HAR: ${harPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  for (const value of Object.values(paths)) console.log(value);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
