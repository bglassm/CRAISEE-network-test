const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureDirs,
  resolveRunDirs,
  writeRunReadmes
} = require('./common');

function isSuspiciousName(filePath) {
  return /auth-state|token|session|authorization|raw-private|\.trace|\.zip$/i.test(filePath);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyMatchingFiles(srcDir, destDir, predicate) {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyMatchingFiles(srcPath, destPath, predicate);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(srcDir, srcPath);
    if (isSuspiciousName(srcPath)) continue;
    if (predicate(entry.name, relative, srcPath)) {
      copyFile(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

function zipDirectory(sourceDir, zipPath) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  const result = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: sourceDir,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`zip exited with status ${result.status}`);
}

(async () => {
  ensureDirs();
  const runDirs = resolveRunDirs(process.argv[2]);
  writeRunReadmes(runDirs);

  const runName = path.basename(runDirs.runDir);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `craisee-shareable-${runName}-`));
  const zipPath = path.join(runDirs.runDir, `craisee-performance-package-${runName}.zip`);

  const counts = {
    readmes: 0,
    reports: 0,
    redactedHar: 0,
    summaryJson: 0,
    csv: 0,
    screenshots: 0
  };

  try {
    const readmePath = path.join(runDirs.runDir, 'README_FOR_ALEXANDER.md');
    if (fs.existsSync(readmePath)) {
      copyFile(readmePath, path.join(stagingDir, 'README_FOR_ALEXANDER.md'));
      counts.readmes += 1;
    }

    counts.reports += copyMatchingFiles(
      runDirs.reportDir,
      path.join(stagingDir, 'report'),
      (name) => name === 'craisee-performance-report.md'
    );
    counts.redactedHar += copyMatchingFiles(
      runDirs.redactedHarDir,
      path.join(stagingDir, 'redacted-har'),
      (name) => name.endsWith('.redacted.har')
    );
    counts.summaryJson += copyMatchingFiles(
      runDirs.summariesDir,
      path.join(stagingDir, 'summaries'),
      (name) => name.endsWith('.summary.json') || name.endsWith('.performance-entries.json')
    );
    counts.csv += copyMatchingFiles(
      runDirs.summariesDir,
      path.join(stagingDir, 'summaries'),
      (name) => name.endsWith('.request-summary.csv')
    );
    counts.screenshots += copyMatchingFiles(
      runDirs.screenshotsDir,
      path.join(stagingDir, 'screenshots'),
      (name) => name.endsWith('.png')
    );

    zipDirectory(stagingDir, zipPath);

    console.log(`Run folder: ${runDirs.runDir}`);
    console.log(`Shareable package: ${zipPath}`);
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
