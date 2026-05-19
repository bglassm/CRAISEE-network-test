const fs = require('fs');
const path = require('path');
const {
  DIRS,
  ensureDirs
} = require('./common');

const SENSITIVE_QUERY = /token|session|auth|jwt|code/i;
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

function redactValue(value = '[REDACTED]') {
  return '[REDACTED]';
}

function redactHeaders(headers = []) {
  let count = 0;
  const out = headers.map((header) => {
    const name = header.name || '';
    if (SENSITIVE_HEADER.test(name) || /^x-clerk/i.test(name) || /^sec-ch-ua/i.test(name)) {
      count += 1;
      return { ...header, value: redactValue(header.value) };
    }
    return header;
  });
  return { out, count };
}

function redactQueryString(queryString = []) {
  let count = 0;
  const out = queryString.map((item) => {
    if (SENSITIVE_QUERY.test(item.name || '')) {
      count += 1;
      return { ...item, value: '[REDACTED]' };
    }
    return item;
  });
  return { out, count };
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch (_) {
    return rawUrl;
  }
}

function redactHar(har, sourceFile) {
  const stats = {
    file: sourceFile,
    entries: 0,
    requestHeadersRedacted: 0,
    responseHeadersRedacted: 0,
    queryValuesRedacted: 0,
    postDataRedacted: 0,
    responseContentTextRedacted: 0,
    cookieArraysRedacted: 0
  };

  if (!har.log || !Array.isArray(har.log.entries)) return { har, stats };

  for (const entry of har.log.entries) {
    stats.entries += 1;
    if (entry.request) {
      entry.request.url = safeUrl(entry.request.url);
      const requestHeaders = redactHeaders(entry.request.headers || []);
      entry.request.headers = requestHeaders.out;
      stats.requestHeadersRedacted += requestHeaders.count;

      const queryString = redactQueryString(entry.request.queryString || []);
      entry.request.queryString = queryString.out;
      stats.queryValuesRedacted += queryString.count;

      if (entry.request.postData) {
        entry.request.postData = {
          mimeType: entry.request.postData.mimeType || '',
          text: '[REDACTED]'
        };
        stats.postDataRedacted += 1;
      }
      if (Array.isArray(entry.request.cookies) && entry.request.cookies.length) {
        entry.request.cookies = [];
        stats.cookieArraysRedacted += 1;
      }
    }

    if (entry.response) {
      const responseHeaders = redactHeaders(entry.response.headers || []);
      entry.response.headers = responseHeaders.out;
      stats.responseHeadersRedacted += responseHeaders.count;

      if (entry.response.content && typeof entry.response.content.text === 'string') {
        entry.response.content.text = '[REDACTED]';
        if (entry.response.content.encoding) delete entry.response.content.encoding;
        stats.responseContentTextRedacted += 1;
      }
      if (Array.isArray(entry.response.cookies) && entry.response.cookies.length) {
        entry.response.cookies = [];
        stats.cookieArraysRedacted += 1;
      }
    }
  }

  return { har, stats };
}

(async () => {
  ensureDirs();
  const files = fs.readdirSync(DIRS.raw)
    .filter((file) => file.endsWith('.har'))
    .map((file) => path.join(DIRS.raw, file));

  const log = [];
  for (const file of files) {
    const har = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { har: redacted, stats } = redactHar(har, path.basename(file));
    const outPath = path.join(DIRS.redacted, `${path.basename(file, '.har')}.redacted.har`);
    fs.writeFileSync(outPath, JSON.stringify(redacted, null, 2));
    stats.output = outPath;
    log.push(stats);
    console.log(`Redacted ${file} -> ${outPath}`);
  }

  const logPath = path.join(DIRS.redacted, 'redaction-log.json');
  fs.writeFileSync(logPath, JSON.stringify({ createdAt: new Date().toISOString(), files: log }, null, 2));
  console.log(`Redaction log: ${logPath}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
