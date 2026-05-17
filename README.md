# Messenger Recall Tool

Chrome extension (side panel) to read, search, export and bulk-recall Facebook Messenger E2EE messages — including history beyond the 100-message client cache.

**For your own account only. Personal research purposes.**

<p align="center">
  <img src="media/giaodien.jpg" alt="Panel UI" width="420">
</p>

## Demo

| Desktop | Mobile |
|---|---|
| [demopc.mp4](media/demopc.mp4) | [demomobile.mp4](media/demomobile.mp4) |

---

## Disclaimer

Independent project, not affiliated with Meta / Facebook.

- Use on your own account. You are solely responsible for any consequences (rate limits, account flags, suspension).
- Do not use to harass, stalk, or harm anyone.
- Provided AS-IS. See [LICENSE](LICENSE).

---

## Features

| Tab | Description |
|---|---|
| **Load** | Paginates `mpsLoadMessages` bridge API to fetch history beyond the 100-message cache. Configurable start date, batch size, and delay. |
| **View** | Full-text search, filter by date / sender / status (unsent, system messages). Shift-click range selection. |
| **Recall** | Bulk-recall selected messages via E2EE protocol. Random delay between requests to avoid rate-limiting. |
| **Export** | Export as PDF (chat-style with avatars and images) or raw JSON. Statistics by hour, month, sender, call duration. |
| **Chat** | Send messages directly from the side panel via bridge API. |
| **AI** | Auto-reply: uses an OpenAI-compatible API to automatically reply to incoming messages. Configurable system prompt, model, delay, context size. |

Additional:
- Inline image viewer and download (JPEG/PNG/GIF/WebP) + CDN `.enc` image decryption (HKDF-SHA256 + AES-256-CBC)
- Call event detection from protobuf payload: `[missed call 0:03]`, `[video call 1:23]`
- Per-thread extras cached in `chrome.storage.local` (7-day TTL)

---

## Install

1. `git clone https://github.com/quyanhfex/messenger-recall-tool.git`
2. Open `chrome://extensions/` → enable **Developer mode** (top right)
3. **Load unpacked** → select the cloned folder
4. Pin the extension → open Messenger → click the icon to open the side panel

Not available on the Chrome Web Store.

---

## How it works

```
Chrome Side Panel  ←  RPC  →  Content Script  ←  RPC  →
(panel.html/js)              (content_script.js)
                                    ↓ window.postMessage
                       MAIN world injector (injector.js)
                                    ↓
                  window.require('MAWBridgeSendAndReceive')
                                    ↓
                  MAW Worker  →  Facebook backend  →  E2EE peers
```

- `hook_injector.js` runs at `document_start` to install a fake `__REACT_DEVTOOLS_GLOBAL_HOOK__`, capturing React Fiber roots before React initializes.
- `injector.js` walks the Fiber tree to get the LSDatabase store; parses protobuf payloads without a `.proto` schema — decodes UTF-8 leaves heuristically.
- CDN image decryption uses WhatsApp media-key derivation: `HKDF(salt=zeros, info="WhatsApp Image Keys")` → AES-256-CBC.
- Bulk recall calls `sendRevokeMsg` directly via the bridge, bypassing the React UI.

---

## FAQ

**Q: Will my account get banned?**
Haven't been banned, but sample size is 1. Set a higher recall delay to be safe.

**Q: Why do some messages show `[không decode được]`?**
Attachment type not yet handled (stickers, location, reply quotes...). PRs welcome.

**Q: Can it recall call event messages?**
No. Facebook silently rejects revoke for call events server-side — the local DB marks them `isUnsent: true` but the peer never receives the revoke.

---

## License

[MIT](LICENSE) — Inspired by [shoot-the-messenger](https://github.com/theahura/shoot-the-messenger) (DOM-based approach).

---
---

# Messenger Recall Tool (Tiếng Việt)

Chrome extension (side panel) để đọc, tìm kiếm, xuất và thu hồi hàng loạt tin nhắn Messenger E2EE — kể cả tin vượt giới hạn 100 tin của cache client.

**Chỉ dùng cho tài khoản của chính bạn. Mục đích nghiên cứu cá nhân.**

---

## Disclaimer

Dự án độc lập, không liên kết với Meta / Facebook.

- Dùng trên tài khoản của bạn, tự chịu trách nhiệm nếu bị rate-limit hoặc khóa tài khoản.
- Không dùng để quấy rối, theo dõi, hay gây hại người khác.
- Provided AS-IS. See [LICENSE](LICENSE).

---

## Tính năng

| Tab | Mô tả |
|---|---|
| **Tải** | Phân trang qua bridge API (`mpsLoadMessages`) để tải lịch sử vượt cache 100 tin. Cấu hình ngày bắt đầu, kích thước batch, delay giữa các lượt. |
| **Xem** | Full-text search, lọc theo ngày / người gửi / trạng thái (đã thu hồi, tin hệ thống). Shift-click để chọn nhiều tin. |
| **Thu hồi** | Thu hồi hàng loạt tin đã chọn qua E2EE protocol. Delay ngẫu nhiên giữa các lần để tránh rate-limit. |
| **Xuất** | Xuất PDF (dạng chat có avatar, ảnh) hoặc JSON thô. Xem thống kê theo giờ, tháng, người gửi, thời lượng gọi. |
| **Chat** | Gửi tin nhắn trực tiếp từ side panel qua bridge API. |
| **AI** | Auto-reply: dùng AI (OpenAI-compatible API) tự động trả lời tin nhắn đến. Cấu hình system prompt, model, delay, context size. |

Tính năng thêm:
- Xem và tải ảnh inline (JPEG/PNG/GIF/WebP) + decrypt ảnh CDN `.enc` (HKDF-SHA256 + AES-256-CBC)
- Nhận diện cuộc gọi từ protobuf payload: `[cuộc gọi nhỡ 0:03]`, `[video call 1:23]`
- Cache extras per-thread vào `chrome.storage.local` (TTL 7 ngày)

---

## Cài đặt

1. `git clone https://github.com/quyanhfex/messenger-recall-tool.git`
2. Mở `chrome://extensions/` → bật **Developer mode** (góc trên phải)
3. **Load unpacked** → chọn thư mục vừa clone
4. Pin extension → mở Messenger → click icon để mở side panel

Không có trên Chrome Web Store.

---

## Cách hoạt động

```
Chrome Side Panel  ←  RPC  →  Content Script  ←  RPC  →
(panel.html/js)              (content_script.js)
                                    ↓ window.postMessage
                       MAIN world injector (injector.js)
                                    ↓
                  window.require('MAWBridgeSendAndReceive')
                                    ↓
                  MAW Worker  →  Facebook backend  →  E2EE peers
```

- `hook_injector.js` chạy ở `document_start` để cài fake `__REACT_DEVTOOLS_GLOBAL_HOOK__`, bắt React Fiber roots trước khi React khởi động.
- `injector.js` walk Fiber tree để lấy LSDatabase store; parse protobuf payload không cần `.proto` schema — decode UTF-8 leaves heuristically.
- CDN image decryption dùng WhatsApp media-key derivation: `HKDF(salt=zeros, info="WhatsApp Image Keys")` → AES-256-CBC.
- Bulk recall gọi thẳng `sendRevokeMsg` qua bridge, không qua React UI.

---

## FAQ

**Q: Có bị ban không?**
Chưa bị, nhưng sample size là 1. Đặt delay thu hồi cao một chút cho an toàn.

**Q: Một số tin hiện `[không decode được]` là sao?**
Attachment chưa được xử lý (sticker, location, reply quote...). PR welcome.

**Q: Thu hồi được tin nhắn cuộc gọi không?**
Không. Facebook từ chối revoke call events phía server — local DB sẽ mark `isUnsent: true` nhưng phía kia không nhận được revoke.

---

## License

[MIT](LICENSE) — Inspired by [shoot-the-messenger](https://github.com/theahura/shoot-the-messenger) (DOM-based approach).
