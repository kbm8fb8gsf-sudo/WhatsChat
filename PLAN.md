# WhatsChat: plan

A SillyTavern add-on that lets approved WhatsApp contacts chat with SillyTavern characters. It has two parts in one repo: a Node server plugin, which owns WhatsApp and all the logic, and a thin browser extension, which drives SillyTavern's chat UI.

Verified against SillyTavern `release` @ 1.19.0 (commit 06bde93, 2026-09-14), the SillyTavern-Docs repo, and Baileys `7.0.0-rc14` (npm `latest`, 2026-07-29). `docs.sillytavern.app` didn't resolve from the build container, so I read the same pages from the docs' GitHub source.

## 1. Verified facts and where they differ from the brief

| Area | What the source actually says | Consequence |
|---|---|---|
| Server plugin | Needs `enableServerPlugins: true` in `config.yaml`. A plugin directory is loaded via its `package.json` `main`, else `index.js`/`.cjs`/`.mjs`. The file is loaded with `import()`. Exports are `info {id,name,description}`, `init(router)` and optionally `exit()`. Routes are mounted at `/api/plugins/<id>` **only if the router has routes when `init` resolves**. Mounting happens after login and CSRF middleware. `exit()` runs on SIGINT/SIGTERM **and on any uncaughtException**. | Ship as ESM (`"type":"module"`). Register routes synchronously and don't block `init` on WhatsApp connecting. Never let a Baileys error escape, because it would shut SillyTavern down. |
| Plugin deps | SillyTavern doesn't install plugin dependencies. With `enableServerPluginsAutoUpdate` on (the default), it runs `git pull` on plugin repos but never builds them. | Install is `git clone` into `plugins/` then `npm ci && npm run build`. The README will say to rebuild after updates. I'm not bundling Baileys, because it loads a WASM bridge from disk. |
| UI extension | `manifest.json` (`display_name`, `js`, `author` required) sits at the repo root. The built-in installer clones into `data/<user>/extensions/<repo>` (or global `public/scripts/extensions/third-party/`), served at `/scripts/extensions/third-party/<repo>/`. | The same repo is cloned twice: once into `plugins/`, once through "Install extension". The manifest points at `extension/index.js`. The folder name comes from `import.meta.url`. |
| **getContext() gap 1** | There's no function for adding a user message. `sendMessageAsUser` exists in `script.js` but isn't in `getContext()`. | **Proposal:** `st-bridge.js` loads `sendMessageAsUser` and `doNewChat` with `import('/script.js')`. This is the `importFromUrl` pattern the docs describe. Fallback: `ctx.chat.push` + `addOneMessage` + `saveChat` + emit `MESSAGE_SENT`/`USER_MESSAGE_RENDERED`, but that skips user-input regex scripts and persona avatar locking. |
| **getContext() gap 2** | There's no "is generating" flag. `selectCharacterById` silently does nothing while `is_send_press` is true. | The bridge reads the live `is_send_press`/`isChatSaving` exports from `/script.js` and waits until SillyTavern is idle before switching chats. |
| Generation | `ctx.generate('normal')` (= `Generate`) resolves after the reply is saved, both streaming and non-streaming. It returns early, adding no message, if the API is offline. | The bridge captures the reply as "the new last non-user message after `await generate()`", cross-checked with `MESSAGE_RECEIVED`. If no new message appears, the batch fails. |
| Chat switching | `selectCharacterById(index)` then `openCharacterChat(file)`. `openCharacterChat` also **saves that chat as the character's current chat**. Character indexes aren't stable. | Mappings store the character's **avatar filename** plus a chat file name. Restoring your previous chat is feasible: I record avatar/group + chat beforehand and switch back afterwards. |
| Prompt injection | `setExtensionPrompt(key, value, position, depth, scan, role, filter)`. Types: `IN_PROMPT 0`, `IN_CHAT 1`, `BEFORE_PROMPT 2`. Roles: `SYSTEM 0`. The injection is global and stays until it's overwritten. | The system note is injected `IN_CHAT` at depth 0 as `SYSTEM`, with a `filter` that's only true during a bridge generation. It's cleared in `finally`. |
| HTTP details | POSTs need `X-CSRF-Token`; `ctx.getRequestHeaders()` provides it. App-wide `compression()` would buffer SSE. | Extension POSTs use `getRequestHeaders()`. SSE responses send `Cache-Control: no-cache, no-transform` (compression skips those) plus a 15 s heartbeat. |
| **Baileys package** | The name is now `baileys` (`@whiskeysockets/baileys` mirrors it). It's ESM-only and needs Node ≥ 20. npm `latest` is **7.0.0-rc14, a release candidate**; 6.7.24 is tagged `legacy`. | Pin `baileys@7.0.0-rc14` exactly. |
| Baileys auth/QR | `useMultiFileAuthState(dir)` + `creds.update → saveCreds`, wrapped in `makeCacheableSignalKeyStore`. `printQRInTerminal` is **deprecated**: the QR string arrives in `connection.update.qr`. `DisconnectReason.loggedOut = 401`. `sock.logout()` unlinks the device. | The QR is rendered to a PNG data URL with `qrcode`. Any disconnect except `loggedOut` reconnects with backoff. |
| **Baileys LIDs (v7)** | `key.remoteJid` may be an `…@lid` id rather than a phone number. When known, the phone number is in `key.remoteJidAlt` or `sock.signalRepository.lidMapping.getPNForLID()`. Upstream says this can't always be resolved. | The transport resolves to a canonical phone number where possible. If it can't, the message is ignored and logged with its LID, and an allowlist entry may also be a raw LID. Replies always go to the JID the message came from. |
| Presence/receipts | `sendPresenceUpdate('composing'\|'paused'\|'available'\|'unavailable', jid)`. Presence **expires after ~10 s**. `readMessages(keys)` downgrades to `read-self` if the account has read receipts turned off. `markOnlineOnConnect` defaults to true, which silences notifications on your phone. | Typing is refreshed every 8 s. Default `markOnlineOnConnect: false`. |

## 2. Architecture

```
WhatsApp ⇄ WhatsAppTransport ─┐                         ┌─ SSE /events ──────────► extension: batch-processor
          (only Baileys code) │  BridgeService (core)   │                              │ st-bridge (only ST internals)
FakeTransport (tests) ────────┤  router → debouncer →   │                              ▼
future BlueBubbles ───────────┘  dispatcher ⇄ HTTP ─────┤◄─ POST /batches/:id/reply ── open chat, add msg, inject note,
                                 reply → cleaner →      │                              generate, capture, restore chat
                                 splitter → pacing →    │
                                 per-contact queue ─────┘──► transport.sendText / setTyping / markRead
```

### Transport interface (`server/src/transport/types.ts`)

```ts
interface MessagingTransport {
  readonly kind: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;                 // close socket, keep the session
  logout(): Promise<void>;                     // unlink the device and delete the session (added to the brief's list)
  onMessage(h: (m: InboundMessage) => void): () => void;     // returns unsubscribe
  onStatus(h: (s: TransportStatus) => void): () => void;     // added: drives the SSE status and the QR
  sendText(to: ReplyAddress, text: string): Promise<void>;
  setTyping(to: ReplyAddress, state: 'typing' | 'paused'): Promise<void>;
  markRead(refs: readonly MessageRef[]): Promise<void>;
  getStatus(): TransportStatus;
}
interface InboundMessage { id: string; contactId: string /* "+447700900123" or "lid:…" */;
  replyTo: ReplyAddress /* opaque */; ref: MessageRef /* opaque */; pushName?: string; text: string; timestamp: number }
type TransportStatus = { state: 'disabled'|'connecting'|'pairing'|'connected'|'reconnecting'|'logged_out'|'error';
  pairingCode?: string /* raw QR payload */; self?: string; attempt?: number; error?: string }
```

The transport only emits 1:1 text messages. It drops groups, broadcasts, status updates, newsletters and `fromMe`. Media becomes a `[sent a photo]`-style placeholder, which you can turn off.

### Core modules (`server/src/core/`). Pure unless noted.
- **contact-router**: normalises numbers to E.164 (handling `+`, `00`, spaces, LIDs), checks the allowlist, and returns `{ok, mapping}` or `{ignored, reason}`.
- **debouncer**: a per-contact state machine that closes a batch after `quietMs` without new messages, or at `maxWaitMs`/`maxMessages`. Timers go through an injected `Scheduler`.
- **reply-cleaner**: strips `<think>`/reasoning blocks, leading `Name:` prefixes, `*actions*` (remove, keep or unwrap), markdown/HTML, OOC `((…))`/`[OOC: …]`, wrapping quotes and a dangling unfinished sentence. Also normalises whitespace and caps length.
- **bubble-splitter**: splits on blank lines, then on sentence boundaries above `maxBubbleChars` (never inside URLs, numbers or abbreviations). Merges fragments under `minBubbleChars` and caps at `maxBubbles`.
- **pacing**: `planRead({readyAt, claimedAt, p, rng})` and `planDelivery({readAt, replyAt, bubbles, p, rng}) → Step[]`. A `Step` is `{at, kind:'typing'|'paused'|'send', bubble?}`. Typing time is `clamp(chars / cps × jitter)`. Time spent generating counts as typing for bubble 1. The RNG is seeded and injected.
- **contact-queue**: runs `Step[]` per contact in order. Different contacts run in parallel. Supports `cancelAll()` and `flush(timeoutMs)`. Not pure: it uses the injected Scheduler.
- **batch-dispatcher**: global single-flight, because SillyTavern has one active chat. It keeps pending batches in FIFO order and offers the next only when none is in flight. The first tab to `claim` gets the lease; other tabs ignore it. If the lease expires (default 5 min), the batch is re-offered once, then failed. Batches queue in memory while no tab is open.
- **bridge-service**: the composition logic. Messages are marked read **only once a batch is claimed**, so nothing reads "seen" while SillyTavern is closed.

### HTTP (`/api/plugins/whatschat`)
`GET /status`, `GET /qr` (PNG data URL), `GET|PUT /config`, `POST /connect|/disconnect|/logout`, `GET /events` (SSE: `status`, `batch`, `batch-cancelled`), `POST /batches/:id/claim|/reply|/fail`. **There's deliberately no endpoint that sends text to an arbitrary number.** A reply can only answer a batch the contact started, and only allowlisted contacts produce batches.

### Config (`server/src/config/`)
A zod schema with defaults and a `version` field. It's persisted atomically (temp file + rename) to `<plugin>/data/config.json`, and the Baileys session goes in `<plugin>/data/auth/`. Both are gitignored, and `WHATSCHAT_DATA_DIR` overrides the location. The server config is the **single source of truth**: the extension reads and writes it through `/config` and keeps no settings of its own beyond UI state. Sections are `enabled`, `contacts[] {id, label, enabled, characterAvatar, chatFile?, preset?}`, `realistic {preset, injectNote, note, overrides}`, `inbound {quietMs, maxWaitMs, maxMessages, mediaPlaceholders, neutraliseMacros}`, `cleaner`, `splitter`, `dispatch {leaseMs, maxAgeMs}`, `sillytavern {restorePreviousChat}` and `whatsapp {markOnlineOnConnect}`.

### Lifecycle
`init` registers routes, loads config and, if enabled, starts `connect()` **without awaiting it**. `exit()` stops the dispatcher and closes SSE clients. It then flushes queued bubbles immediately, with no pacing and a 5 s cap, and cancels whatever is left. Finally it clears every timer and calls `transport.disconnect()`. Everything is idempotent.

### Extension (`extension/`, plain ES modules, `// @ts-check`)
- `st-bridge.js`: **the only file that touches SillyTavern internals.** It wraps `getContext()` and `/script.js` imports: `getActiveChat`, `openMappedChat`, `addUserMessage`, `injectNote`/`clearNote`, `generateReply`, `waitUntilIdle`, `restoreChat`, `listCharacters`, `listChats`.
- `api-client.js`: fetch + EventSource with reconnect, using `getRequestHeaders()`.
- `batch-processor.js`: processes one batch at a time. The steps are claim, waitUntilIdle, remember the current chat, open the mapped chat, add the user message (joined with `\n`), inject the note, generate, capture, POST the reply (or `/fail`), clear the note and restore the chat.
- `settings-ui.js` + `settings.html`: the enable toggle, status, QR, contact→character/chat mappings, the preset picker and pacing overrides.
- `types/st.d.ts`: a minimal hand-written declaration of the SillyTavern surface we use, so type checks don't need a SillyTavern checkout.

## 3. Realistic text mode

These are the confirmed presets. Each contact can pick its own preset, and global overrides apply on top of it.

| Preset | Read delay | Think | Typing speed | Gap between bubbles | Split | Typing indicator |
|---|---|---|---|---|---|---|
| `off` | 0 | 0 | none | 0 | no (one message) | no |
| `quick` | 2–8 s | 1–3 s | 7 chars/s | 0.6–1.5 s | yes | yes |
| `natural` (default) | 5–40 s | 2–6 s | 4.5 chars/s | 1.2–3.5 s | yes | yes |
| `busy` | 1–8 min | 5–20 s | 3.5 chars/s | 2–6 s | yes | yes |

Typing time per bubble is clamped to 1.5–25 s with ±20 % jitter. The default injected note is: *"You're texting {{user}} on WhatsApp. Reply like a real person texting: short, casual, no actions or narration, no markdown. Separate messages with a blank line."*

## 4. Test strategy
- **Tooling:** TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint (flat config with typescript-eslint) and Vitest. The extension is type-checked with `tsc --noEmit` and `checkJs`. `npm run check` runs lint, both type checks and the tests, and every milestone must pass it.
- **Pure modules:** table-driven tests for router, cleaner and splitter, plus seeded-RNG tests that the pacing output stays within bounds.
- **Timers:** debouncer, queue, dispatcher leases and backoff run against a `FakeScheduler`/Vitest fake timers. Nothing sleeps for real.
- **Core end to end:** `BridgeService` + `FakeTransport` covers inbound → batch → claim → reply → paced sends, with assertions on the exact transport call log and times.
- **HTTP:** a real Express 4 app (devDependency) with FakeTransport covers routes, zod validation errors, SSE framing and heartbeat, the claim race and `exit()` cleanup (no open handles).
- **WhatsAppTransport:** an injected `makeSocket` factory with a fake Baileys event emitter covers message normalisation, LID resolution, reconnect/backoff, logout, typing refresh and error containment. No live WhatsApp runs in CI.
- **Extension:** `batch-processor` is tested with a mocked `st-bridge` and API client, covering ordering, restore-on-error, note always cleared and one-at-a-time processing.
- **Smoke:** if feasible in the container, I'll load the built plugin through a real SillyTavern install and hit `/status`. Pairing a phone and the full UI round trip are a **manual checklist for you**, since I can't scan a QR from here.

## 5. Milestones (one commit each, `npm run check` green)
1. **Scaffold:** repo layout, tooling, a plugin stub (`info`/`init`/`exit`, `/status`), a manifest and an extension stub, plus a plugin-contract test.
2. **Config + contact router:** zod schema, defaults, presets and the atomic JSON store.
3. **Text pipeline:** reply cleaner and bubble splitter.
4. **Timing:** Scheduler abstraction, pacing calculator, debouncer and per-contact queue.
5. **Core:** transport interface, FakeTransport, batch dispatcher and BridgeService.
6. **HTTP:** routes, SSE, QR and full `exit()` cleanup.
7. **WhatsAppTransport:** Baileys integration.
8. **Extension:** st-bridge, api-client, batch-processor and the settings panel.
9. **Docs + polish:** README (install both halves, `enableServerPlugins`, rebuild after updates, the dedicated-number advice) and the manual end-to-end checklist.

## 6. Decisions I need from you
1. ✅ **Decided:** the four presets in section 3 are confirmed as written.
2. ✅ **Decided:** option A. `st-bridge.js` imports `sendMessageAsUser`, `doNewChat` and the busy flags from `/script.js`. If an import is missing it fails loudly with an error in the panel.
3. ✅ **Decided:** pin `baileys@7.0.0-rc14`.
4. ✅ **Decided:** single characters only in v1. SillyTavern group chats can't be mapped.
5. ✅ **Decided:** neutralise `{{` in inbound text by default by inserting an invisible zero-width space, so it displays unchanged but isn't expanded. A config toggle (`inbound.neutraliseMacros`) turns this off.

## 7. Implementation notes

What changed from the plan while building, and how it was checked.

- **Transport interface:** as planned, plus `logout()` and `onStatus()`. The QR code is passed as `pairingCode` in the status and rendered to a PNG by the `/qr` route.
- **Tab identity:** each tab picks its own client id and sends it when opening `/events`. A tab that drops its stream has 10 s to reconnect before its claimed batch is offered again, so a network blip can't make SillyTavern answer the same messages twice. Claims are also leases (2 min), renewed every 30 s while generating.
- **Best-effort presence:** read receipts and "typing…" never cancel a reply if they fail. Only a failed message send drops the rest of that reply (after 3 retries).
- **Removed `whatsapp.browserName`:** Baileys doesn't support custom device names.
- **Startup:** the extension's `activate` hook mounts the panel, then waits for `APP_READY` without awaiting it, because SillyTavern awaits the hook while loading.
- **Verified in a real SillyTavern 1.19** (scratch install, headless Chromium):
  - The real plugin loads through the plugin loader, mounts at `/api/plugins/whatschat`, and exits within about 1.3 s on SIGINT while reconnecting.
  - With a stand-in transport and a mock OpenAI-compatible model, the full loop worked: two quick messages became one user message; they were marked read, "typing…" was shown, and the reply went out as two cleaned bubbles; a new chat was created and saved to the contact; the previous chat was restored; the note reached the model as a system message; a contact's `{{user}}` was not expanded; and streamed replies were captured in full.
  - The smoke test found two UI bugs: the QR box showed while connected, and the panel filled in before characters had loaded. Both are fixed.
- **Not verified here:** pairing and messaging against WhatsApp's real servers, which aren't reachable from the build container. See `docs/manual-test.md`.

## 8. Background replies (added after v1)

Requested so replies work with no browser tab open, on an Ubuntu server.

- **Design:** the server plugin runs a hidden SillyTavern page in headless Chromium (Playwright's `chromium-headless-shell`). The extension detects it from a flag set before the page loads and runs in worker mode. Replies therefore still go through SillyTavern's own prompt building, with no reimplementation.
- **Routing:** event-stream clients have a role. While background mode is starting or running, batches go only to the hidden page and tabs can't claim them. If it fails, the waiting batch is re-offered to tabs.
- **Stale data:** SillyTavern keeps settings, characters and chats in page memory and saves them whole, so a long-lived hidden copy could overwrite your edits. It is guarded four ways:
  - The hidden page's `/api/settings/save` requests are intercepted (and reported as successful).
  - The character card is re-read from disk before opening or creating a chat, because SillyTavern re-saves the card then.
  - The chat is re-read from disk before writing to it.
  - The page reloads before a batch when a tab reports a change (settings, character, lorebook or preset saved), or after 5 idle minutes.
- **Tabs:** they reload a chat on screen when the hidden page wrote to it (`chat-updated` event).
- **Logins:** SillyTavern's address comes from `process.serverEvents` `server-started` (switched to loopback), with a manual override. Basic auth uses HTTP credentials; user accounts log in through `/api/users/login` from the page. A rejected login is not retried, to avoid SillyTavern's failed-login limit.
- **Verified on Ubuntu 24.04 with real SillyTavern 1.19** (headless shell 141, playwright-core 1.64), with no tab open:
  - Replies arrived within about 5 s.
  - With a tab open, the tab never switched chats, and it refreshed the WhatsApp chat when that chat was on screen.
  - A settings change triggered a reload before the next reply. `settings.json` was never written by the hidden page.
  - Basic auth (`listen: true`) and user accounts both worked once the login was saved, with clear messages before.
  - Shutdown left no Chromium processes.
  - Memory was about 0.5 GB for the hidden Chromium.
- **AI connection:** SillyTavern only connects to the AI on page load if "Auto-connect to Last Server" is on, and it skips generating while disconnected. The hidden page therefore receives its settings with `auto_connect` forced on, in memory only. Before claiming a batch it waits up to 20 s for the connection, and it reloads to reconnect at most once a minute. It reports its connection to the panel. Verified end to end with auto-connect off: replies worked and `settings.json` kept `auto_connect: false`. For custom Chat Completion endpoints, SillyTavern skips the status check, so "connected" means what SillyTavern's own UI shows.
- **Not verified here:** the browser download itself (`npm run browser:install`), because Playwright's CDN is blocked from the build container. The command and its target were checked with `--dry-run`.
