import { chromium } from 'playwright';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Đọc session-input.json (paste từ extension cookie-injector)
const sessionPath = join(__dirname, 'session-input.json');
const sessionRaw = JSON.parse(readFileSync(sessionPath, 'utf-8'));

// Hỗ trợ cả format cũ (array cookies) lẫn format mới { cookies, pinCode }
const cookiesRaw = Array.isArray(sessionRaw) ? sessionRaw : sessionRaw.cookies;
const PIN_CODE = sessionRaw.pinCode;
if (!Array.isArray(cookiesRaw) || cookiesRaw.length === 0) throw new Error('cookies rỗng trong session-input.json');
if (!PIN_CODE || PIN_CODE.length !== 6) throw new Error('pinCode phải 6 chữ số');

// Normalize sang format Playwright
const SAMESITE_MAP = { 'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict' };
const cookies = cookiesRaw.map(c => ({
  name: c.name,
  value: c.value,
  domain: c.domain || '.facebook.com',
  path: c.path || '/',
  httpOnly: c.httpOnly || false,
  secure: c.secure !== undefined ? c.secure : true,
  sameSite: SAMESITE_MAP[c.sameSite?.toLowerCase()] || c.sameSite || 'None',
}));

const injectorCode = readFileSync(join(__dirname, '../injector.js'), 'utf-8');

const THREAD_ID = process.env.THREAD_ID || '<REPLACE_WITH_THREAD_ID>';
const threadIdAtMsgr = THREAD_ID + '@msgr';

// Profile trắng — mỗi run 1 dir tmp, xóa sau khi xong
const PROFILE_DIR = mkdtempSync(join(tmpdir(), 'mr-profile-'));
console.log(`Profile tạm: ${PROFILE_DIR}`);

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });

  console.log(`Inject ${cookies.length} cookies...`);
  await ctx.addCookies(cookies);

  const page = ctx.pages()[0] ?? await ctx.newPage();

  // Forward browser console về terminal (chỉ log có [HOOK] để giảm noise)
  page.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[HOOK]') || txt.includes('[MR]')) {
      console.log('[browser]', txt);
    }
  });

  console.log('Mở Messenger...');
  await page.goto(`https://www.facebook.com/messages/t/${THREAD_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // ===== Auto-fill PIN qua DOM (sau 10s để Messenger render dialog) =====
  console.log('Đợi 10s để Messenger load và render dialog PIN...');
  await page.waitForTimeout(5000);

  console.log(`🔐 Auto-fill PIN qua DOM...`);
  const filled = await page.evaluate((pin) => {
    const inputs = Array.from(document.querySelectorAll(
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[maxlength="1"]'
    ));
    if (inputs.length === 0) return { ok: false, reason: 'no_input' };

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (inputs.length === 1) {
      setter.call(inputs[0], pin);
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      for (let i = 0; i < Math.min(inputs.length, pin.length); i++) {
        setter.call(inputs[i], pin[i]);
        inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
        inputs[i].dispatchEvent(new KeyboardEvent('keydown', { key: pin[i], bubbles: true }));
        inputs[i].dispatchEvent(new KeyboardEvent('keyup', { key: pin[i], bubbles: true }));
      }
    }
    return { ok: true, inputCount: inputs.length };
  }, PIN_CODE);

  if (!filled.ok) {
    console.log(`ℹ️ Không có dialog PIN (${filled.reason}) — profile có thể đã verified, tiếp tục`);
  } else {
    console.log(`✅ PIN đã bơm vào ${filled.inputCount} input. Đợi 5s để FB verify...`);
    await page.waitForTimeout(5000);

    // Check kết quả — dialog PIN biến mất = success, còn = lỗi
    const stillVisible = await page.evaluate(() => {
      return !!document.querySelector('input[autocomplete="one-time-code"], input[maxlength="1"]');
    });
    if (stillVisible) {
      // Check thêm text báo lỗi
      const errorTxt = await page.evaluate(() => {
        const txt = document.body.innerText || '';
        const m = txt.match(/(incorrect|sai|wrong|không đúng)[^\n]*?(pin|mã)/i);
        return m ? m[0] : null;
      });
      if (errorTxt) {
        throw new Error('INCORRECT_PIN_CODE — ' + errorTxt + '. Export lại với PIN đúng.');
      }
      console.log('⚠️ Dialog PIN vẫn còn nhưng không có text báo sai — có thể đang verify, tiếp tục thử');
    } else {
      console.log('✅ Dialog PIN đã biến mất — verified');
    }
  }

  await page.evaluate(injectorCode);
  console.log('Injector loaded');

  const result = await page.evaluate(async (threadId) => {
    const bridge = window.require('MAWBridgeSendAndReceive');
    const resp = await bridge.sendAndReceive('mps', 'mpsLoadMessages', {
      debug: { purpose: 'load-more' },
      direction: 'desc',
      from: [Date.now() + 86400000, '0'],
      numMessages: 20,
      threadId,
    });
    return {
      success: resp.success,
      msgCount: resp.value?.messages?.length,
      messages: (resp.value?.messages || []).map((m) => ({
        text: window.__MR__.extractTextFromPayload(m.toplevelProtobuf.payload),
        ts: new Date(m.toplevelProtobuf.timestampMs).toLocaleString('vi-VN'),
        senderId: m.toplevelProtobuf.senderId,
      })),
    };
  }, threadIdAtMsgr);

  console.log('success:', result.success, 'msgCount:', result.msgCount);
  result.messages.forEach(m => console.log(`[${m.ts}] ${m.senderId}: ${m.text}`));

  await ctx.close();

  // Cleanup profile tạm
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    console.log(`Đã xóa profile tạm: ${PROFILE_DIR}`);
  } catch (e) {
    console.warn(`⚠️ Không xóa được profile tạm ${PROFILE_DIR}:`, e.message);
  }
})();
