import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('admin page contains the protected dashboard, filters, and no embedded password', () => {
  const html = read('public/admin.html');
  const home = read('public/index.html');
  const script = read('public/admin.js');
  const styles = read('public/admin.css');

  assert.match(html, /id="adminPassword"/);
  assert.match(html, /id="resourceMetrics"/);
  assert.match(html, /id="registrationChart"/);
  assert.match(html, /id="worldMap"/);
  assert.match(html, /id="geographyPeriod"/);
  assert.match(html, /id="geoMetricSwitch"|class="geoMetricSwitch"/);
  assert.match(home, /Country-level visit and sign-up counts only; IP addresses are not included in analytics/);
  assert.match(html, /id="fromDate"/);
  assert.match(html, /id="toDate"/);
  assert.match(html, /id="playerRows"/);
  assert.match(html, /\/admin\.js/);
  assert.match(html, /\/admin\.css/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(script, /regionIdForOrigin\(location\.origin\)/);
  assert.match(script, /store\.get\(trustKey\(regionId,\s*name\)\)/);
  assert.doesNotMatch(script, /bv\.trust\.cobusvw/);
  assert.match(script, /bv\.adminKey/);
  assert.match(script, /\/admin\/api\/login/);
  assert.match(script, /\/admin\/api\/players/);
  assert.match(script, /\/admin\/api\/geography/);
  assert.match(script, /\/admin\/api\/worldmap/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /\$\('adminPassword'\)\.value/);
  assert.match(styles, /grid-template-columns/);
  assert.doesNotMatch(`${html}\n${script}\n${styles}`, /ADMIN_DASHBOARD_PASSWORD|adminDashboardPassword/);
});

test('desktop game side panel is widened by ten percent without changing its hide breakpoint', () => {
  const css = read('public/style.css');
  assert.match(css, /--side:\s*318px;/);
  assert.match(css, /@media\s*\(max-width:\s*1080px\)[\s\S]*?#side\s*\{\s*display:\s*none;/);
});

test('resource and registration charts clear their previous pixels before redrawing', () => {
  const script = read('public/admin.js');
  const sparkline = script.slice(
    script.indexOf('function drawSparkline'),
    script.indexOf('function drawRegistration'),
  );
  const registration = script.slice(
    script.indexOf('function drawRegistration'),
    script.indexOf('function canvasContext'),
  );

  assert.match(sparkline, /ctx\.clearRect\(0,\s*0,\s*width,\s*height\)/);
  assert.match(registration, /ctx\.clearRect\(0,\s*0,\s*width,\s*height\)/);
});

test('player registration dates display and filter in UTC', () => {
  const html = read('public/admin.html');
  const script = read('public/admin.js');

  assert.match(script, /const dateFormat = new Intl\.DateTimeFormat\(undefined,\s*\{[^}]*timeZone:\s*'UTC'/s);
  assert.match(html, /REGISTERED FROM \(UTC\)/);
  assert.match(html, /REGISTERED TO \(UTC\)/);
});
