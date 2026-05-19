// ============================================================
// Stego — encode/decode hidden text via zero-width characters
// Base4 encoding + optional AES-GCM encryption with password
// ============================================================

(function (global) {
  // Base2: ZWSP (U+200B) = 0, ZWNJ (U+200C) = 1
  // Bỏ Word Joiner (U+2060) và BOM (U+FEFF) vì chúng có thể chiếm
  // không gian trên Messenger web với một số font.
  const ZW0 = '​'; // U+200B ZWSP
  const ZW1 = '‌'; // U+200C ZWNJ

  // Magic header: 4 ký tự xen kẽ ZWNJ ZWSP ZWNJ ZWSP
  // Pattern này không xuất hiện ngẫu nhiên trong payload (vì payload
  // mã hoá bytes ngẫu nhiên — xác suất pattern này ở đầu = 1/16)
  const MAGIC = '‌​‌​';

  // Flag byte: bit 0 = encrypted (1) hay plaintext (0)
  const FLAG_ENCRYPTED = 0x01;

  // ---- Bytes ↔ Base2 zero-width string ----
  function bytesToZw(bytes) {
    let out = '';
    for (const b of bytes) {
      // 1 byte = 8 ký tự (mỗi ký tự 1 bit, MSB trước)
      for (let i = 7; i >= 0; i--) {
        out += (b >> i) & 1 ? ZW1 : ZW0;
      }
    }
    return out;
  }

  function zwToBytes(zwStr) {
    // Chỉ giữ ZW0/ZW1, bỏ mọi thứ khác (kể cả MAGIC nếu còn lẫn)
    let clean = '';
    for (const c of zwStr) {
      if (c === ZW0 || c === ZW1) clean += c;
    }
    // Cắt phần dư cho bội số 8
    clean = clean.slice(0, clean.length - (clean.length % 8));
    const bytes = new Uint8Array(clean.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | (clean[i * 8 + j] === ZW1 ? 1 : 0);
      }
      bytes[i] = b;
    }
    return bytes;
  }

  // ---- Crypto helpers ----
  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(password),
      { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async function encryptText(plaintext, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
    );
    // Format: [salt 16B][iv 12B][ciphertext...]
    const out = new Uint8Array(16 + 12 + ciphertext.length);
    out.set(salt, 0);
    out.set(iv, 16);
    out.set(ciphertext, 28);
    return out;
  }

  async function decryptBytes(bytes, password) {
    if (bytes.length < 28) throw new Error('Payload quá ngắn');
    const salt = bytes.slice(0, 16);
    const iv = bytes.slice(16, 28);
    const ciphertext = bytes.slice(28);
    const key = await deriveKey(password, salt);
    try {
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(plainBuf);
    } catch (e) {
      throw new Error('Sai mật khẩu hoặc payload hỏng');
    }
  }

  // Ký tự visible fallback khi user không nhập text — tránh bubble trống
  // trên Messenger web (vốn sẽ có chiều cao 1 dòng dù không nhìn thấy gì).
  // '·' (middle dot) đủ kín đáo, render giống nhau mọi platform.
  const FALLBACK_VISIBLE = '·';

  // ---- High-level API ----
  // Encode: trả về visible + magic + flag byte + payload (zero-width)
  async function encode(visibleText, hiddenText, password) {
    if (!hiddenText) return visibleText;
    let payloadBytes;
    let flag = 0;
    if (password) {
      payloadBytes = await encryptText(hiddenText, password);
      flag = FLAG_ENCRYPTED;
    } else {
      payloadBytes = new TextEncoder().encode(hiddenText);
    }
    // Prepend flag byte
    const withFlag = new Uint8Array(1 + payloadBytes.length);
    withFlag[0] = flag;
    withFlag.set(payloadBytes, 1);
    // Nếu visible rỗng → dùng fallback để bubble không trống lệch trên web
    const carrier = visibleText && visibleText.length > 0 ? visibleText : FALLBACK_VISIBLE;
    return carrier + MAGIC + bytesToZw(withFlag);
  }

  // Detect: có chứa hidden payload không?
  function hasHidden(text) {
    if (!text) return false;
    return text.includes(MAGIC);
  }

  // Decode: trả về { visible, hidden, encrypted, error? }
  async function decode(fullText, password) {
    if (!fullText) return { visible: '', hidden: null };
    const magicIdx = fullText.indexOf(MAGIC);
    if (magicIdx < 0) {
      // Không có magic — kiểm tra raw zero-width (legacy / hỏng magic)
      if (!/[​‌]/.test(fullText)) {
        return { visible: fullText, hidden: null };
      }
      // Có ZW nhưng không có magic → strip ZW, không decode
      return { visible: fullText.replace(/[​‌]/g, ''), hidden: null };
    }

    let visible = fullText.slice(0, magicIdx);
    // Bỏ fallback dot nếu nó là visible duy nhất
    if (visible === FALLBACK_VISIBLE) visible = '';
    const zwPart = fullText.slice(magicIdx + MAGIC.length);
    const bytes = zwToBytes(zwPart);
    if (bytes.length < 1) {
      return { visible, hidden: null, error: 'Payload rỗng' };
    }
    const flag = bytes[0];
    const payload = bytes.slice(1);
    const encrypted = (flag & FLAG_ENCRYPTED) !== 0;

    if (encrypted) {
      if (!password) {
        return { visible, hidden: null, encrypted: true, error: 'Cần mật khẩu' };
      }
      try {
        const hidden = await decryptBytes(payload, password);
        return { visible, hidden, encrypted: true };
      } catch (e) {
        return { visible, hidden: null, encrypted: true, error: e.message };
      }
    } else {
      try {
        const hidden = new TextDecoder().decode(payload);
        return { visible, hidden, encrypted: false };
      } catch (e) {
        return { visible, hidden: null, error: 'Decode UTF-8 lỗi' };
      }
    }
  }

  global.Stego = { encode, decode, hasHidden };
})(window);
