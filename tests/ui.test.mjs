// Phone-size browser walkthrough with a fake microphone (Chrome) and screenshots.
// Usage: BASE_URL=https://kawancakap.pages.dev INVITE=... AUDIO=16k.wav PW=/path/to/playwright node tests/ui.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8977';
const SHOTS = process.env.SHOTS || 'tests/ui-shots';
mkdirSync(SHOTS, { recursive: true });

const r = await fetch(BASE + '/api/teacher/create', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ name: '5 Bestari (demo)', invite: process.env.INVITE }) });
const cls = await r.json();
assert.ok(cls.code, JSON.stringify(cls));

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.env.AUDIO}`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/cloudflareinsights/.test(m.text())) errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

await page.goto(`${BASE}/?c=${cls.code}`);
await page.waitForSelector('#setup');
await page.fill('[name=name]', 'Aina');
await page.waitForFunction(() => /✓/.test(document.querySelector('#classMsg').textContent));
await shot('01-home');
await page.locator('details.more summary').click();
await page.selectOption('[name=topicId]', 'onlineshop');
await page.selectOption('[name=persona]', 'challenger');
await shot('02-options');
await page.click('button[type=submit]');
await page.waitForSelector('.session');
await shot('03-reading');
assert.equal(await page.isDisabled('#mic'), true);
await page.click('#next'); // skip reading time
await page.waitForFunction(() => !document.querySelector('#mic').disabled);

// partner opens
await page.click('#nudge');
await page.waitForSelector('.msg.partner:not(.thinking)', { timeout: 30000 });
await shot('04-partner-opens');

// voice turn: tap, speak (fake mic loops the wav), tap
await page.click('#mic');
await page.waitForTimeout(9500);
await page.click('#mic');
await page.waitForFunction(() => document.querySelectorAll('.msg.student').length === 1 && document.querySelectorAll('.msg.partner:not(.thinking)').length === 2, null, { timeout: 40000 });
const heard = await page.locator('.msg.student p').first().textContent();
console.log('  heard:', heard);
assert.match(heard, /location/i);
await shot('05-voice-turn');

// decision phase, typed turn
await page.click('#next');
await page.click('#typeBtn');
await page.fill('#typeForm input', 'I think saves time is the most important reason because people nowadays very busy with work.');
await page.click('#typeForm button');
await page.waitForFunction(() => document.querySelectorAll('.msg.partner:not(.thinking)').length === 3, null, { timeout: 30000 });
await shot('06-decision');

// further question
await page.click('#next');
await page.fill('#typeForm input', 'Yes, I agree advertising influence teenagers a lot, for example TikTok shop make them buy things they dont need.');
await page.click('#typeForm button');
await page.waitForFunction(() => document.querySelectorAll('.msg.partner:not(.thinking)').length === 4, null, { timeout: 30000 });
await shot('07-further');

await page.click('#next'); // end & feedback
await page.waitForSelector('.big-score', { timeout: 60000 });
await shot('08-feedback-top');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2.2));
await shot('09-feedback-fixes');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow');

// history
await page.goto(`${BASE}/#/history`);
await page.waitForSelector('.hist li');

// teacher dashboard
await page.goto(`${BASE}/teacher.html#k=${cls.code}.${cls.teacherKey}`);
await page.waitForSelector('.share .code');
await shot('10-teacher-class');
await page.locator('.hist li a').first().click();
await page.waitForSelector('.tline');
await shot('11-teacher-session');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'teacher no overflow');

assert.deepEqual(errors, [], 'no JS errors: ' + errors.join(' | '));
await browser.close();

// clean up demo data
const T = { authorization: 'Bearer ' + cls.teacherKey, 'x-class-code': cls.code, origin: BASE };
const list = await (await fetch(BASE + '/api/teacher/class', { headers: T })).json();
if (!process.env.KEEP) {
  for (const s of list.sessions) await fetch(BASE + '/api/teacher/delete', { method: 'POST', headers: { ...T, 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) });
}
console.log(`UI walkthrough OK (class ${cls.code}, ${list.sessions.length} session${KEEPMSG()})`);
function KEEPMSG() { return process.env.KEEP ? ', kept' : ', deleted'; }
