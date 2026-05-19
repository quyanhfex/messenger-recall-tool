import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, 'sessions');
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

const AI_INJECTED = readFileSync(join(__dirname, 'ai-injected.js'), 'utf-8');
const INJECTOR_CODE = readFileSync(join(__dirname, '..', 'injector.js'), 'utf-8');
const SAMESITE_MAP = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };

class Account {
  constructor(id, session) {
    this.id = id;
    this.session = session; // { cookies, pinCode }
    this.ctx = null;
    this.page = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this.profileDir = null;
    this.progress = { step: '', percent: 0, label: '' };
    this.aiConfig = {
      enabled: false,
      apiKey: process.env.DEEPINFRA_API_KEY || '',
      model: 'google/gemma-4-26B-A4B-it',
      temperature: 0.7,
      maxTokens: 512,
      delaySec: 1,
      contextSize: 20,
      systemPrompt: 'Bạn là người dùng Facebook đang trò chuyện. Trả lời ngắn gọn, tự nhiên bằng tiếng Việt.',
    };
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      error: this.error,
      progress: this.progress,
      aiConfig: { ...this.aiConfig, apiKey: this.aiConfig.apiKey ? '***' : '' },
      cookieCount: this.session.cookies?.length || 0,
    };
  }

  setProgress(percent, label) {
    this.progress = { percent, label };
    console.log(`[${this.id}] [${percent}%] ${label}`);
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting';
    this.error = null;
    this.setProgress(5, 'Chuẩn bị cookies...');

    try {
      const cookies = this.session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        httpOnly: c.httpOnly || false,
        secure: c.secure !== undefined ? c.secure : true,
        sameSite: SAMESITE_MAP[c.sameSite?.toLowerCase?.()] || c.sameSite || 'None',
      }));

      this.setProgress(15, 'Khởi động Chrome headless...');
      this.profileDir = join(tmpdir(), `mr-${this.id}-${Date.now()}`);
      this.ctx = await chromium.launchPersistentContext(this.profileDir, {
        headless: true,
      });
      this.setProgress(25, 'Inject cookies...');
      await this.ctx.addCookies(cookies);

      this.page = this.ctx.pages()[0] || (await this.ctx.newPage());

      // Expose binding: page gọi window.nodeAIReply(p) → Node handle LLM
      await this.page.exposeBinding('nodeAIReply', async (_source, payload) => {
        return await this.handleAIReply(payload);
      });

      // Forward browser console về Node (chỉ [AI] và [HOOK])
      this.page.on('console', (msg) => {
        const t = msg.text();
        if (t.startsWith('[AI]') || t.startsWith('[HOOK]') || t.startsWith('[MR]')) {
          console.log(`[${this.id}]`, t);
        }
      });

      this.setProgress(35, 'Mở Messenger E2EE...');
      await this.page.goto('https://www.facebook.com/messages/e2ee/t/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      this.setProgress(45, 'Đợi dialog PIN (10s)...');
      await this.page.waitForTimeout(10000);

      const filled = await this.page.evaluate((pin) => {
        const inputs = Array.from(document.querySelectorAll(
          'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[maxlength="1"]'
        ));
        if (inputs.length === 0) return { ok: false, reason: 'no_pin_dialog' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        if (inputs.length === 1) {
          setter.call(inputs[0], pin);
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          for (let i = 0; i < Math.min(inputs.length, pin.length); i++) {
            setter.call(inputs[i], pin[i]);
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
            inputs[i].dispatchEvent(new KeyboardEvent('keydown', { key: pin[i], bubbles: true }));
            inputs[i].dispatchEvent(new KeyboardEvent('keyup', { key: pin[i], bubbles: true }));
          }
        }
        return { ok: true, count: inputs.length };
      }, this.session.pinCode);

      if (filled.ok) {
        this.setProgress(55, `Đã bơm PIN (${filled.count} ô), đợi xác thực...`);
        await this.page.waitForTimeout(5000);
        const stillThere = await this.page.evaluate(() =>
          !!document.querySelector('input[autocomplete="one-time-code"], input[maxlength="1"]')
        );
        if (stillThere) {
          const err = await this.page.evaluate(() => {
            const t = document.body.innerText || '';
            const m = t.match(/(incorrect|sai|wrong|không đúng)[^\n]{0,40}/i);
            return m ? m[0] : null;
          });
          if (err) throw new Error('INCORRECT_PIN: ' + err);
          this.setProgress(65, 'Dialog PIN vẫn còn, tiếp tục thử...');
        } else {
          this.setProgress(65, '✅ PIN verified');
        }
      } else {
        this.setProgress(65, 'Không có dialog PIN, bỏ qua');
      }

      this.setProgress(72, 'Đợi window.require...');
      await this.page.waitForFunction(() => typeof window.require === 'function', { timeout: 30000 });
      this.setProgress(78, 'Inject injector.js...');
      await this.page.evaluate(INJECTOR_CODE);

      this.setProgress(85, 'Đợi injector sẵn sàng (modules+store)...');
      let statusOk = false;
      let lastStatus = null;
      for (let i = 0; i < 20; i++) {
        try {
          const st = await this.page.evaluate(() => window.__MR__?.getStatus?.());
          lastStatus = st;
          if (st?.modulesReady) {
            statusOk = true;
            break;
          }
        } catch (_) {}
        await this.page.waitForTimeout(1000);
      }
      if (statusOk) {
        this.setProgress(92, `Injector ready (myId=${lastStatus?.myId})`);
      } else {
        this.setProgress(92, '⚠️ Injector chưa fully ready, tiếp tục');
      }

      this.setProgress(95, 'Load AI runtime...');
      await this.page.evaluate(
        ({ cfg, code }) => {
          window.__AI_CONFIG__ = cfg;
          new Function(code)();
        },
        { cfg: this.aiConfig, code: AI_INJECTED }
      );

      this.setProgress(100, '✅ Sẵn sàng');
      this.status = 'running';
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      console.error(`[${this.id}] ❌ Start failed:`, e.message);
      await this.stop().catch(() => {});
      throw e;
    }
  }

  async stop() {
    try {
      if (this.ctx) await this.ctx.close();
    } catch (_) {}
    this.ctx = null;
    this.page = null;
    this.status = 'stopped';
    this.progress = { percent: 0, label: '' };
    if (this.profileDir) {
      try { rmSync(this.profileDir, { recursive: true, force: true }); } catch (_) {}
      this.profileDir = null;
    }
  }

  // Gọi từ page qua exposeBinding: build context + call DeepInfra + trả reply text
  async handleAIReply(payload) {
    const { chatJid, threadId, lastMsg, senderId } = payload || {};
    if (!this.aiConfig.apiKey) {
      console.warn(`[${this.id}] handleAIReply: NO API KEY — set DEEPINFRA_API_KEY env hoặc qua /api/.../ai`);
      return { text: '' };
    }
    try {
      // Load context qua page (page sẽ gọi bridge) — tin nhắn từ bridge đã được decrypt
      const messages = await this.page.evaluate(
        async ({ tid, count }) => {
          return await window.__aiLoadMessages(tid, count);
        },
        { tid: threadId, count: this.aiConfig.contextSize }
      );

      console.log(`[${this.id}] Loaded ${messages?.length || 0} messages for context`);

      const myId = this.id;
      const lines = (messages || [])
        .slice()
        .reverse()
        .map((m) => `${m.senderId === myId ? '[TÔI]' : '[HỌ]'} ${m.text}`)
        .filter((l) => l.length > 5);

      // Tin cuối từ "họ" trong context = tin user vừa gửi (đã decrypt)
      // Override lastMsg nếu lastMsg đang là placeholder "[tin nhắn mới]"
      let actualLastMsg = lastMsg;
      if (lastMsg === '[tin nhắn mới]' || !lastMsg) {
        const lastFromThem = (messages || []).find((m) => m.senderId !== myId);
        if (lastFromThem?.text) actualLastMsg = lastFromThem.text;
      }
      console.log(`[${this.id}] User msg: "${actualLastMsg.slice(0, 100)}"`);

      const tools = [
        {
          type: 'function',
          function: {
            name: 'fetch_more_messages',
            description: 'Lấy thêm tin nhắn cũ hơn khi cần ngữ cảnh nhiều hơn',
            parameters: {
              type: 'object',
              properties: { count: { type: 'integer', description: 'Số tin (max 100)' } },
              required: ['count'],
            },
          },
        },
      ];

      const llmMessages = [
        { role: 'system', content: this.aiConfig.systemPrompt + '\n\nLỊCH SỬ:\n' + lines.join('\n') },
        { role: 'user', content: actualLastMsg },
      ];

      let resp = await this.callLLM(llmMessages, tools);
      let choice = resp.choices?.[0];
      if (!choice) return { text: '' };

      // Tool call round
      if (choice.message?.tool_calls?.length) {
        const tc = choice.message.tool_calls[0];
        if (tc.function?.name === 'fetch_more_messages') {
          const args = JSON.parse(tc.function.arguments || '{}');
          const more = await this.page.evaluate(
            async ({ tid, count }) => await window.__aiLoadMessages(tid, count),
            { tid: threadId, count: Math.min(args.count || 50, 100) }
          );
          const moreLines = (more || [])
            .slice()
            .reverse()
            .map((m) => `${m.senderId === myId ? '[TÔI]' : '[HỌ]'} ${m.text}`)
            .filter((l) => l.length > 5);

          llmMessages.push({
            role: 'assistant',
            content: choice.message.content || null,
            tool_calls: choice.message.tool_calls,
          });
          llmMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: moreLines.join('\n'),
          });

          resp = await this.callLLM(llmMessages, tools);
          choice = resp.choices?.[0];
        }
      }

      const text = (choice?.message?.content || '').trim();
      console.log(`[${this.id}] LLM reply: "${text.slice(0, 120)}"`);
      if (!text) console.log(`[${this.id}] LLM raw choice:`, JSON.stringify(choice).slice(0, 300));
      return { text };
    } catch (e) {
      console.error(`[${this.id}] handleAIReply error:`, e.message);
      return { text: '', error: e.message };
    }
  }

  async callLLM(messages, tools) {
    const body = {
      model: this.aiConfig.model,
      messages,
      temperature: this.aiConfig.temperature,
      max_tokens: this.aiConfig.maxTokens,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const resp = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.aiConfig.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('LLM HTTP ' + resp.status + ' — ' + txt.slice(0, 200));
    }
    return await resp.json();
  }

  async refresh(opts = {}) {
    if (this.status !== 'running' || !this.page) {
      throw new Error('account not running');
    }
    // Dùng loadOlderMessages (bridge) — KHÔNG cần store, KHÔNG cần navigate
    // opts.threadKey: thread ID (số); opts.peerId/myId; opts.numMessages
    const result = await this.page.evaluate(async (opts) => {
      if (!window.__MR__) return { error: 'injector_not_loaded' };

      const status = window.__MR__.getStatus();
      const myId = status.myId;

      // Nếu không có threadKey: gọi bridge để load tin của 1-on-1 chat với chính mình (test)
      // Hoặc user phải truyền threadKey từ ngoài
      const threadKey = opts.threadKey;
      if (!threadKey) return { status, error: 'missing_threadKey' };

      try {
        // Gọi trực tiếp bridge thay vì loadOlderMessages (nhanh, 1 batch)
        const bridge = window.require('MAWBridgeSendAndReceive');
        const threadIdAtMsgr = threadKey + '@msgr';
        const resp = await bridge.sendAndReceive('mps', 'mpsLoadMessages', {
          debug: { purpose: 'web_refresh' },
          direction: 'desc',
          from: [Date.now() + 86400000, '0'],
          numMessages: opts.numMessages || 20,
          threadId: threadIdAtMsgr,
        });

        const messages = (resp?.value?.messages || []).map((m) => ({
          text: window.__MR__.extractTextFromPayload(m.toplevelProtobuf.payload),
          ts: m.toplevelProtobuf.timestampMs,
          senderId: m.toplevelProtobuf.senderId,
          messageId: m.toplevelProtobuf.messageId,
        }));

        return {
          status,
          threadKey,
          success: resp?.success,
          messageCount: messages.length,
          sample: messages.slice(0, 10).map((m) => ({
            ts: new Date(Number(m.ts)).toLocaleString('vi-VN'),
            sender: m.senderId === myId ? '[TÔI]' : '[HỌ]',
            text: m.text,
          })),
        };
      } catch (e) {
        return { status, error: e.message };
      }
    }, opts);
    return result;
  }

  async updateAIConfig(patch) {
    Object.assign(this.aiConfig, patch || {});
    if (this.page && this.status === 'running') {
      try {
        await this.page.evaluate((p) => window.__updateAIConfig?.(p), patch);
      } catch (e) {
        console.warn(`[${this.id}] updateAIConfig failed:`, e.message);
      }
    }
  }
}

export class AccountManager {
  constructor() {
    this.accounts = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!existsSync(SESSIONS_DIR)) return;
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      try {
        const session = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'));
        this.accounts.set(id, new Account(id, session));
      } catch (e) {
        console.warn('Failed to load session', f, e.message);
      }
    }
    console.log(`Loaded ${this.accounts.size} accounts from disk`);
  }

  list() {
    return [...this.accounts.values()].map((a) => a.toJSON());
  }

  get(id) {
    return this.accounts.get(id);
  }

  add(session) {
    if (!session?.cookies?.length) throw new Error('cookies required');
    if (!session.pinCode || session.pinCode.length !== 6) throw new Error('pinCode must be 6 digits');

    const cUser = session.cookies.find((c) => c.name === 'c_user')?.value;
    if (!cUser) throw new Error('c_user cookie missing');

    const id = cUser; // use c_user as account id
    writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session, null, 2));

    if (this.accounts.has(id)) {
      this.accounts.get(id).session = session;
    } else {
      this.accounts.set(id, new Account(id, session));
    }
    return this.accounts.get(id);
  }

  async remove(id) {
    const acc = this.accounts.get(id);
    if (!acc) return false;
    await acc.stop();
    this.accounts.delete(id);
    const f = join(SESSIONS_DIR, `${id}.json`);
    if (existsSync(f)) unlinkSync(f);
    return true;
  }

  async stopAll() {
    for (const acc of this.accounts.values()) {
      await acc.stop().catch(() => {});
    }
  }
}
