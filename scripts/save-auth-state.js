const { chromium } = require('playwright');
const {
  AUTH_STATE_PATH,
  ensureDirs,
  prompt
} = require('./common');

(async () => {
  ensureDirs();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('\nCRAISEE manual login session capture');
  console.log('1. Log in manually.');
  console.log('2. Navigate until you can confirm you are logged in.');
  console.log('3. Return to this terminal and press Enter.\n');

  await page.goto('https://www.craisee.com/en/start', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await prompt('Press Enter after you have confirmed the browser is logged in...');
  await context.storageState({ path: AUTH_STATE_PATH });

  console.log(`\nSaved auth state: ${AUTH_STATE_PATH}`);
  console.log('WARNING: private/auth-state.json contains session cookies/localStorage. Do not share it.\n');

  await browser.close();
})().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
