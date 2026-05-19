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

This runs automatic logged-out and logged-in scenarios. If `private/auth-state.json` is missing, logged-in scenarios are skipped and recorded as skipped.

## Step 3: Run Manual Collection

```bash
npm run collect:manual
```

Use this for SPA navigation, filters, scrolling, or any UI sequence where automatic selectors are unreliable. You choose whether to use saved auth state, enter a scenario name and starting URL, perform actions manually, then press Enter in the terminal to save logs.

## Step 4: Redact HAR Files

```bash
npm run redact
```

This creates redacted HAR files in:

```text
results/redacted/
```

The redactor removes cookies, Authorization headers, Clerk headers, sensitive query values, request post bodies, response content text, and cookie arrays.

## Step 5: Generate Report

```bash
npm run report
```

The final markdown report is written to:

```text
results/reports/craisee-performance-report.md
```

## NPM Scripts

- `npm run setup`: prints the Playwright Chromium install command
- `npm run save-auth`: opens headed Chromium so you can log in manually and save `private/auth-state.json`
- `npm run collect`: runs automatic performance scenarios
- `npm run collect:manual`: runs headed manual logging mode
- `npm run redact`: creates redacted HAR files from raw HAR files
- `npm run report`: generates a markdown report from scenario summaries

## Output Locations

- Raw HAR files: `results/raw/`
- Redacted HAR files: `results/redacted/`
- Screenshots: `results/screenshots/`
- JSON and CSV summaries: `results/summaries/`
- Markdown report: `results/reports/`

These folders are present in the repository through `.gitkeep` placeholders, but generated files inside them are ignored by default.

## Safe To Share After Review

- `results/reports/craisee-performance-report.md`
- `results/redacted/*.redacted.har`
- `results/summaries/*.json`
- `results/summaries/*.csv`
- `results/screenshots/*.png`

Screenshots and summaries can still reveal private information depending on the logged-in account and page content. Review them before sharing.

## Never Commit Or Share

- `private/auth-state.json`
- `private/*.json`
- raw logged-in HAR files
- raw traces
- cookies, tokens, Clerk session data, Authorization headers, or post bodies
- `node_modules/`

## Public Repository Hygiene

The `.gitignore` is intentionally conservative. It excludes generated performance outputs by default, including redacted HARs and generated reports, so publishing requires an explicit review decision instead of accidental commits.

Before committing, check what git would include:

```bash
git status --short
git check-ignore -v private/auth-state.json results/raw/example.har results/summaries/example.summary.json
```
