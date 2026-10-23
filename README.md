# WhatsChat

Chat with your SillyTavern characters over WhatsApp. When someone on your approved list messages your spare WhatsApp number, their messages go into the SillyTavern chat you've mapped to them, and the character's reply goes back over WhatsApp. An optional "realistic texting" mode makes replies read and arrive like texts from a real person: short messages, read receipts, "typing…", and natural pauses.

It's built for personal use on a spare number. It only ever replies to people on your list who messaged first. There is no way to message anyone else, and nothing for bulk messaging.

> WhatsChat uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. Using unofficial clients is against WhatsApp's terms and can get a number banned. Use a spare number you can afford to lose.

## What you need

- SillyTavern 1.19 or newer, with an AI connection that works for normal chatting.
- Git and Node.js 20 or newer. SillyTavern already needs both.
- A phone with WhatsApp on the spare number, to scan a QR code once.
- Either a SillyTavern tab left open in a browser, or **background replies** turned on (see below). Replies are written by SillyTavern's page, so one of the two has to be running.

## Install

WhatsChat has two halves that live in the same repository: a **server plugin**, which talks to WhatsApp, and a **UI extension**, which drives SillyTavern.

### 1. Server plugin

```sh
cd SillyTavern/plugins
git clone https://github.com/kbm8fb8gsf-sudo/WhatsChat whatschat
cd whatschat
npm ci
npm run build
```

Then edit SillyTavern's `config.yaml`:

```yaml
enableServerPlugins: true
# Recommended: SillyTavern's auto-update pulls new code but doesn't rebuild it.
enableServerPluginsAutoUpdate: false
```

### 2. UI extension

In SillyTavern, open **Extensions → Install extension** and paste `https://github.com/kbm8fb8gsf-sudo/WhatsChat`.

If the repository is private, the installer can't fetch it. Clone it yourself instead:

```sh
cd SillyTavern/data/default-user/extensions   # or your user's folder
git clone https://github.com/kbm8fb8gsf-sudo/WhatsChat WhatsChat
```

### 3. Restart SillyTavern

The console should show `[WhatsChat] Loaded.`

### Updating

Pull and rebuild both copies, then restart SillyTavern:

```sh
cd SillyTavern/plugins/whatschat && git pull && npm ci && npm run build
cd SillyTavern/data/default-user/extensions/WhatsChat && git pull   # or use the Extensions menu's update button
```

If you use background replies, also run `npm run browser:install` again in `plugins/whatschat`. An update may need a newer browser, and the panel will tell you if it does.

## Setting up

1. Open **Extensions** (the cubes icon) and expand **WhatsChat**.
2. Tick **Connect to WhatsApp**. A QR code appears.
3. On the phone with the spare number, open **WhatsApp → Settings → Linked devices → Link a device** and scan the code. The status changes to **Connected as +…**.
4. Under **Contacts**, click **Add contact** and fill in:
   - **Phone number** with the country code, e.g. `+44 7700 900123`.
   - **Name**: optional, just for you.
   - **Character** to talk to.
   - **Chat** to use. "New chat on the first message" creates a fresh chat for this person, and WhatsChat remembers it.
   - **Style**: the texting style for this person, or the default.
5. Click **Save**.

That's it. When that person messages the spare number, SillyTavern switches to their chat, writes the reply, sends it, and switches back to whatever you were doing.

## Background replies: no tab needed

Normally a SillyTavern tab has to be open somewhere, because SillyTavern's page is what writes the replies. With **background replies** on, WhatsChat runs its own hidden copy of that page on the server in a headless browser, so replies keep working with every tab closed. Your prompts, presets, lorebooks and extensions are used exactly as in a normal tab.

### Setting it up on an Ubuntu server

Install a headless Chrome for WhatsChat. This is a one-time download of about 100 MB:

```sh
cd SillyTavern/plugins/whatschat
npm run browser:install                     # as the user that runs SillyTavern
sudo env "PATH=$PATH" npm run browser:deps  # once: installs the system libraries it needs (apt)
```

- Run `browser:install` **as the same user that runs SillyTavern**, because the browser is saved in that user's home folder (`~/.cache/ms-playwright`). If SillyTavern runs as a service under its own user, use e.g. `sudo -u sillytavern npm run browser:install`.
- The `env "PATH=$PATH"` part lets `sudo` find Node when it was installed with nvm.
- It works on Ubuntu 22.04 and 24.04, on both x86-64 and ARM64 servers.

Then in the WhatsChat panel, tick **Reply even when no SillyTavern tab is open** and click **Save**. Within a few seconds the status shows **Running: replies no longer need a tab open**.

**If SillyTavern asks for a login** (user accounts, or the username and password prompt it uses with `listen: true`), open **SillyTavern login and advanced options**, enter the username and password, and click **Save login**. The password is stored in `data/background-login.json`, readable only by your user, and is never shown again.

### Which AI it uses

The hidden copy is SillyTavern itself, logged in as the same SillyTavern user, so it uses exactly what that user has selected. That covers the API type (Chat Completion, Text Completion and so on), the provider and model, and the connection profile. Your API keys stay where SillyTavern keeps them, in its own `secrets.json` on the server, and the hidden page never sees them: it asks the SillyTavern server to make the request, just like your tab does. To change the AI, change it in your own tab. The hidden copy picks it up before its next reply.

The hidden copy connects to the AI by itself when it starts, even if **Auto-connect to Last Server** is off. That box stays as you set it. The panel shows whether it's connected.

### What changes when it's on

- **Your tabs stop switching chats.** The hidden copy does that work, so a tab you're using stays where you left it.
- **Open chats stay current.** If you have a contact's chat open in a tab, it refreshes itself when a WhatsApp message comes in.
- **Your changes are picked up.** When you change settings, a character or a lorebook in your tab, the hidden copy reloads before its next reply, which takes a few seconds. It also reloads after 5 quiet minutes, in case something changed elsewhere. It never saves SillyTavern's settings itself, so it can't undo yours.
- **Memory:** it uses about 0.5 GB of RAM. On a 1 GB server that may be too much.
- **If something goes wrong**, the panel says what in plain words, and any open tab handles replies in the meantime. **Try again** restarts it once you've fixed the problem.

## How it behaves

- **Quick messages are grouped.** People often send a thought as several quick messages. WhatsChat waits until they stop for a few seconds (6 by default), then hands them to the character as one message.
- **One conversation at a time.** SillyTavern has a single open chat, so if several people write at once they're answered in turn.
- **Your chat comes back.** After replying, WhatsChat returns SillyTavern to the chat you were on. You can turn this off. If you're in the middle of generating something yourself, it waits for you to finish first.
- **Nothing is "seen" until SillyTavern picks it up.** If no SillyTavern tab is open, messages wait unread. When you open a tab they're answered, unless they're over 12 hours old.
- **Replies are tidied for texting.** WhatsChat removes things like `Seraphina:` prefixes, `*smiles*` actions, `<think>` reasoning, OOC notes and markdown before sending. Your SillyTavern chat keeps the original.
- **Photos, voice notes and stickers** arrive as text such as `[sent a photo]` so the character knows. You can turn this off.
- **Contacts can't use `{{shortcodes}}`.** Text a contact types is passed on as-is, so they can't read your persona or system prompt or change your variables. You can turn this off.

### Texting styles

| Style | Seen after | "Typing…" | Long replies |
|---|---|---|---|
| **Off** | instantly | not shown | one message, sent straight away |
| **Quick** | 2–8 s | about 7 letters a second | split into a few messages, short pauses |
| **Natural** (default) | 5–40 s | about 4.5 letters a second | split, 1–3 s pauses |
| **Busy** | 1–8 minutes | about 3.5 letters a second | split, 2–6 s pauses |

The time the AI spends writing counts towards the "typing…", so a slow model doesn't add delay on top. Under **Fine-tune timing** you can override the read delay, typing speed and pauses. Each contact can have its own style.

When the style isn't Off, the character also gets a short instruction while writing a WhatsApp reply: text like a real person, keep it short, no narration, and separate messages with a blank line. You can edit or disable it. It's only added to WhatsApp replies, never to your normal chats.

## Your data

Everything WhatsChat stores is in `plugins/whatschat/data/` (or the folder named by the `WHATSCHAT_DATA_DIR` environment variable). It's ignored by git.

- `config.json` holds your settings and contacts.
- `auth/` is the WhatsApp session, effectively the key to the account. It's only readable by your user. Don't share it.
- `background-login.json` holds the SillyTavern login for background replies, if you saved one. It's only readable by your user.

**Log out of WhatsApp** in the panel unlinks this computer from the phone and deletes `auth/`.

## Troubleshooting

| What you see | What to do |
|---|---|
| "The WhatsChat server plugin isn't running" | Check `enableServerPlugins: true`, that you ran `npm ci && npm run build` in `plugins/whatschat`, and look for `[WhatsChat]` lines in SillyTavern's console. |
| "Reconnecting… Last error: …" | Usually a network problem. WhatsChat keeps retrying, waiting a little longer each time (up to 5 minutes). |
| "WhatsApp unlinked this device" | The phone removed the link. Tick **Connect** again and scan a new code. |
| "Another session … took over" | The same WhatsApp link is in use elsewhere (e.g. a second SillyTavern). Stop the other one, then tick **Connect** again. |
| A contact's messages are ignored | Check the number has the right country code. SillyTavern's console logs `Ignored a message from …: not on the allowlist`. If that shows `lid:12345…` instead of a phone number, WhatsApp hid the number: add a contact with exactly that `lid:…` text as the number. |
| "Couldn't reply to …" pop-up | SillyTavern couldn't generate. Usually the AI connection is down, or the mapped chat or character was deleted. The message is skipped. |
| "The reply … wasn't sent (it was empty …)" | After removing narration and formatting, nothing was left. Try the instruction note, or a different style. |
| Background: "Chromium is not installed" | In `plugins/whatschat`, run `npm run browser:install` as the user that runs SillyTavern, then click **Try again**. |
| Background: "Chromium is missing system libraries" | Run `sudo env "PATH=$PATH" npm run browser:deps` once in `plugins/whatschat`, then **Try again**. |
| Background: "SillyTavern asks for a username and password" / "didn't accept the login" | Enter or fix the login under **SillyTavern login and advanced options**. WhatsChat doesn't keep retrying a wrong password, so SillyTavern won't lock this machine out. |
| Background: "the WhatsChat extension didn't start" | The extension must be installed for the SillyTavern user the hidden copy logs in as. If you installed it for one user only, either install it for that user too, or use "Install for all users". |
| Background: "Running, but not connected to the AI" | SillyTavern couldn't reach the AI: check the API settings and key in your own tab, and that a local model server is running. The hidden copy retries the connection before its next reply. |
| Background: "Could not open SillyTavern at …" | SillyTavern's address couldn't be worked out, e.g. behind a reverse proxy. Enter it (as seen from the server, e.g. `http://127.0.0.1:8000/`) under advanced options. |

To see more detail in the console, start SillyTavern with `WHATSCHAT_DEBUG=1`.

## Development

```sh
npm ci
npm run check   # lint, type checks (server and extension), tests
npm run build   # compiles the server plugin to dist/
```

- `server/src`: the plugin, in TypeScript (strict). `transport/` is the only code that knows about WhatsApp; `core/` holds the pure logic (allowlist, grouping, cleaning, splitting, pacing, queues).
- `extension/`: the UI extension, in plain ES modules type-checked with JSDoc. `st-bridge.js` is the only file that touches SillyTavern internals.
- [`PLAN.md`](PLAN.md) has the architecture and decisions, and [`docs/manual-test.md`](docs/manual-test.md) is the hands-on checklist for a real phone.
