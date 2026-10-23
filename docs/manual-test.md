# Manual test checklist

The automated tests cover the logic, the HTTP API and the SillyTavern side, including a full run inside a real SillyTavern 1.19 with a stand-in for WhatsApp. They can't pair a real phone. This checklist covers what only a real phone can show. Use the spare number for WhatsChat, and a second phone (or a friend) as the "contact".

Before starting: SillyTavern is running with a working AI connection, WhatsChat is installed (see the README), and a SillyTavern tab is open.

## Pairing

- [ ] Tick **Connect to WhatsApp**. Within a few seconds the status says "Scan the QR code…" and a QR code appears.
- [ ] Wait about a minute without scanning. The code refreshes by itself.
- [ ] Scan it from the spare phone (**Linked devices → Link a device**). The QR disappears and the status shows "Connected as +<spare number>".
- [ ] The spare phone's Linked devices list shows the new device.
- [ ] Restart SillyTavern. It reconnects on its own, with no new QR code.

## Allowlist

- [ ] Add the contact's number with the **Off** style and **New chat on the first message**, then Save.
- [ ] From a number *not* on the list, send a message. Nothing happens: no reply, no blue ticks. The console logs "Ignored a message from +…: not on the allowlist".

## First conversation (Off style)

- [ ] From the contact, send "hi". Within a few seconds SillyTavern switches to the character, a new chat appears containing "hi" and the reply, then SillyTavern switches back to the chat you had open.
- [ ] The contact gets the reply as one message, without `Name:` prefixes or `*actions*`.
- [ ] In the panel, the contact's Chat now shows the new chat's name. (Re-open the panel if it was open.)
- [ ] Send two messages quickly ("are you there?", "hello?"). They arrive in SillyTavern as one user message with two lines, and get one reply.

## Realistic texting (Natural style)

- [ ] Change the contact's style to **Natural** and Save.
- [ ] Send a question that invites a longer answer. The blue ticks appear after a delay (5–40 s), then "typing…" shows. The reply arrives as two or three separate messages, with "typing…" before each.
- [ ] The phone shows "typing…" for the whole time it should (it's refreshed every 8 seconds), and it stops once the last message arrives.
- [ ] A little while after the reply, the spare number stops showing as "online".
- [ ] In SillyTavern, open the prompt inspector for that reply (or the console). The texting instruction was included. Then generate a normal reply in some other chat: the instruction is **not** there.

## Edge cases

- [ ] Close every SillyTavern tab and send a message. No blue ticks appear. Open SillyTavern: the message is then read and answered.
- [ ] Send a photo with a caption. The character receives `[sent a photo]` plus the caption.
- [ ] Send `{{user}}`. In SillyTavern the message shows `{{user}}` literally, not your name.
- [ ] Start generating something in another chat, and while it's writing, send a WhatsApp message. WhatsChat waits for your generation to finish, then handles the message.
- [ ] Disconnect the AI (e.g. stop the API), then send a message. A "Couldn't reply to …" pop-up appears and "typing…" doesn't stay on. With the Natural or Busy style, the message also stays unread if the failure came before its read delay was up.
- [ ] Turn off Wi-Fi on the computer for about a minute. The status shows "Reconnecting…"; when the network returns it says "Connected" again by itself.

## Logging out

- [ ] Click **Log out of WhatsApp** and confirm. The device disappears from the spare phone's Linked devices, the status says logged out, and `plugins/whatschat/data/auth/` is gone.
- [ ] Ticking **Connect** again shows a new QR code.

## Background replies (on the Ubuntu server)

- [ ] In `plugins/whatschat`, run `npm run browser:install` as the SillyTavern user, and `sudo env "PATH=$PATH" npm run browser:deps` once.
- [ ] Tick **Reply even when no SillyTavern tab is open** and Save. Within about 30 seconds it shows "Running".
- [ ] Close every SillyTavern tab. Send a WhatsApp message: it's read and answered as usual.
- [ ] Open SillyTavern on a different chat and send a WhatsApp message. Your tab doesn't move.
- [ ] Open the contact's chat in your tab and send a WhatsApp message. The new messages appear in your tab without you reloading.
- [ ] Change a setting (e.g. the response length) in your tab, then send a message. The console logs "Reloading to pick up changes before replying", and the reply uses the new setting.
- [ ] If SillyTavern has a login: before saving it, the panel says SillyTavern asks for one; after **Save login**, it runs.
- [ ] Stop SillyTavern. `ps aux | grep headless_shell` shows nothing left behind.

## Shutdown

- [ ] Send a message with the **Busy** style and stop SillyTavern (Ctrl-C) while the reply is waiting to be sent. SillyTavern exits within a few seconds, and the queued messages are sent before it exits.
