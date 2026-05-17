import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(readFileSync(join(__dirname, 'cookies.json'), 'utf-8'));
const injectorCode = readFileSync(join(__dirname, '../injector.js'), 'utf-8');
const signalKeys = JSON.parse(readFileSync(join(__dirname, 'signal_keys_decrypted.json'), 'utf-8'));

const THREAD_ID = 'YOUR_THREAD_ID';
const threadIdAtMsgr = 'YOUR_USER_ID@msgr';
const DB_NAME = 'messenger_web_signal_v3_YOUR_FB_UID';
const PROFILE_DIR = join(__dirname, 'playwright-profile');
const isFirstRun = !existsSync(join(PROFILE_DIR, 'Default', 'IndexedDB'));

(async () => {
  const ctx = await chromium.launchPersistentContext(
    PROFILE_DIR,
    { headless: true }
  );

  if (isFirstRun) {
    console.log('Lần đầu chạy — inject cookies...');
    await ctx.addCookies(cookies);
  }

  // Inject decrypted signal keys trước khi Messenger load
  await ctx.addInitScript(({ dbName, keys }) => {
    const _open = indexedDB.open.bind(indexedDB);
    indexedDB.open = function(name, version) {
      const req = _open(name, version);
      if (name !== dbName) return req;
      req.addEventListener('success', async () => {
        const db = req.result;
        for (const [storeName, records] of Object.entries(keys)) {
          if (!records.length) continue;
          try {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const { key, value } of records) store.put(value, key);
          } catch(_) {}
        }
        console.log('[MR] decrypted signal keys injected');
      }, { once: true });
      return req;
    };
  }, { dbName: DB_NAME, keys: signalKeys });

  const page = ctx.pages()[0] ?? await ctx.newPage();

  console.log('Mở Messenger...');
  await page.goto(`https://www.facebook.com/messages/t/${THREAD_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('Đợi window.require...');
  await page.waitForFunction(() => typeof window.require === 'function', { timeout: 30000 });
  console.log('window.require OK');

  await page.evaluate(injectorCode);
  console.log('Injector loaded');

  if (isFirstRun) {
    console.log('Đợi 20s để nhập PIN...');
    await new Promise(r => setTimeout(r, 20000));
    console.log('Tiếp tục...');
  }

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

  // Export IndexedDB sau khi nhập PIN — keys đã decrypted
  console.log('Đang export signal keys...');
  const exported = await page.evaluate(async (dbName) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(dbName);
      r.onsuccess = e => res(e.target.result);
      r.onerror = rej;
    });
    const storeNames = ['session', 'identity', 'prekey', 'signedPrekey', 'meta', 'senderKeySessions', 'personalSenderKeyStatuses'];
    const out = {};
    for (const name of storeNames) {
      const [records, keys] = await Promise.all([
        new Promise(res => { const tx = db.transaction(name, 'readonly'); const r = tx.objectStore(name).getAll(); r.onsuccess = e => res(e.target.result); }),
        new Promise(res => { const tx = db.transaction(name, 'readonly'); const r = tx.objectStore(name).getAllKeys(); r.onsuccess = e => res(e.target.result); }),
      ]);
      out[name] = keys.map((k, i) => ({ key: k, value: records[i] }));
    }
    return out;
  }, DB_NAME);

  writeFileSync(join(__dirname, 'signal_keys_decrypted.json'), JSON.stringify(exported));
  console.log('Đã lưu signal_keys_decrypted.json');

  await ctx.close();
})();
