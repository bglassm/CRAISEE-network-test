# CRAISEE Network Test

This project collects local browser-level performance and network logs for `www.craisee.com` using Playwright Chromium.

It is intended to help compare:

- logged-out vs logged-in behavior
- cold cache vs warm cache
- `/en/explore` reaction API request patterns
- media/video request behavior
- SPA navigation behavior
- scroll/filter behavior

## Important

- Do not hardcode credentials.
- For logged-in testing, run `npm run save-auth` and log in manually.
- `private/auth-state.json` is sensitive and must not be shared.
- Raw logged-in HAR files may contain cookies/tokens and should not be committed or shared.
- Use `npm run redact` before sharing HAR files.
- This repository is public. Generated results are ignored by default.

## Setup

```bash
git clone https://github.com/bglassm/CRAISEE-network-test.git
cd CRAISEE-network-test
npm install
npx playwright install chromium
```

You can also print the Playwright install reminder with:

```bash
npm run setup
```

## Step 1: Save Login State

```bash
npm run save-auth
```

This opens a headed Chromium browser at `https://www.craisee.com/en/start`.

1. Log in manually.
2. Navigate until you can confirm you are logged in.
3. Return to the terminal and press Enter.

The session is saved locally to:

```text
private/auth-state.json
```

Do not share this file. It may contain session cookies, localStorage, Clerk session data, or other authentication material.

## Step 2: Run Automatic Collection

```bash
npm run collect
```

This runs automatic logged-out and logged-in scenarios. Each collection creates a timestamped run folder under `results/`, such as:

```text
results/260519_1500/
```

If `private/auth-state.json` is missing, logged-in scenarios are skipped and recorded as skipped.

## Step 3: Run Manual Collection

```bash
npm run collect:manual
```

Use this for SPA navigation, filters, scrolling, or any UI sequence where automatic selectors are unreliable. You choose whether to use saved auth state, enter a scenario name and starting URL, perform actions manually, then press Enter in the terminal to save logs.

## Step 4: Redact HAR Files

```bash
npm run redact
```

By default this redacts the latest run folder. To redact a specific run:

```bash
npm run redact -- 260519_1500
```

This reads raw HAR files from:

```text
results/<run>/raw-private/
```

and writes redacted HAR files to:

```text
results/<run>/redacted-har/
```

The redactor removes cookies, Authorization headers, Clerk headers, sensitive query values, request post bodies, response content text, and cookie arrays.

## Step 5: Generate Report

```bash
npm run report
```

By default this reports on the latest run folder. To report on a specific run:

```bash
npm run report -- 260519_1500
```

The final markdown report is written to:

```text
results/<run>/report/craisee-performance-report.md
```

## Step 6: Package Shareable Files

```bash
npm run package
```

By default this packages the latest run folder. To package a specific run:

```bash
npm run package -- 260519_1500
```

The zip is written to:

```text
results/<run>/craisee-performance-package-<run>.zip
```

## NPM Scripts

- `npm run setup`: prints the Playwright Chromium install command
- `npm run save-auth`: opens headed Chromium so you can log in manually and save `private/auth-state.json`
- `npm run collect`: runs automatic performance scenarios
- `npm run collect:manual`: runs headed manual logging mode
- `npm run redact`: creates redacted HAR files from raw HAR files
- `npm run report`: generates a markdown report from scenario summaries
- `npm run package`: creates a shareable zip without `raw-private/`

## Output Locations

- Run folder: `results/<YYMMDD_HHMM>/`
- Raw/private files: `results/<run>/raw-private/`
- Redacted HAR files: `results/<run>/redacted-har/`
- Screenshots: `results/<run>/screenshots/`
- JSON and CSV summaries: `results/<run>/summaries/`
- Markdown report: `results/<run>/report/`

Generated run folders are ignored by default.

## Safe To Share After Review

- `results/<run>/craisee-performance-package-<run>.zip`
- `results/<run>/report/craisee-performance-report.md`
- `results/<run>/redacted-har/*.redacted.har`
- `results/<run>/summaries/*.summary.json`
- `results/<run>/summaries/*.request-summary.csv`
- `results/<run>/summaries/*.performance-entries.json`
- `results/<run>/screenshots/*.png`

Screenshots and summaries can still reveal private information depending on the logged-in account and page content. Review them before sharing.

## Never Commit Or Share

- `private/auth-state.json`
- `private/*.json`
- raw logged-in HAR files
- raw traces
- `results/<run>/raw-private/`
- cookies, tokens, Clerk session data, Authorization headers, or post bodies
- `node_modules/`

## Public Repository Hygiene

The `.gitignore` is intentionally conservative. It excludes generated performance outputs by default, including redacted HARs and generated reports, so publishing requires an explicit review decision instead of accidental commits.

Before committing, check what git would include:

```bash
git status --short
git check-ignore -v private/auth-state.json results/260519_1500/raw-private/example.har results/260519_1500/summaries/example.summary.json
```
