# Scenario Clock

A SillyTavern extension that keeps the date and time *inside your story* and tells the AI on every reply. Models are bad at keeping track of story time over a long chat, and once older messages are summarised the time is usually lost completely. Scenario Clock works the time out from the chat itself and adds it to every prompt, e.g.:

> [Story clock: it is 9:42 PM on Thursday, 14 March 2024 (night), day 3 of the story. This is the correct current time and date; it overrides any other time or date in the chat history or its summaries.]

Each chat has its own clock. The AI moves it forward by adding short tags such as `[TIME: +3h]` to its replies. The extension does the calendar maths (weekdays, month ends, leap years), which models get wrong.

## Install

Needs SillyTavern 1.19 or newer.

Copy this folder into your SillyTavern user's extensions folder, then restart SillyTavern (or reload the page):

```sh
cp -r scenario-clock SillyTavern/data/default-user/extensions/scenario-clock
```

If you put the folder in a GitHub repository of its own, with `manifest.json` at the top level, you can install it from **Extensions → Install extension** instead.

The browser console shows `[Scenario Clock] Loaded.` and **Extensions** gets a **Scenario Clock** section.

## Using it

**New chats get a clock automatically.** By default it starts at the real date and time. You can choose a fixed start instead in the settings, or set the time in the panel. A character can set its own scene: put a tag like `[TIME: 1889-10-04 18:00]` in its greeting.

**Existing chats** start without a clock. Open **Extensions → Scenario Clock**, pick the story's current date and time, and click **Start clock**.

**Time moves in three ways:**

1. **The AI adds time tags.** It's told how to (you can turn this off). For example: *"[TIME: +8h] The morning sun spills through the curtains…"* Tags are hidden in the chat by default, but stay in the message text. Edit a message and you'll see them, and can change them.
2. **You add time tags** in your own messages the same way: *"[TIME: +1h] I wait outside the café."*
3. **You move it by hand** with the panel's buttons and box, the **Clock** entry in the wand (✨) menu, or `/clock`.

Any message without a tag adds 1 minute, so a long conversation slowly moves the clock. You can change this per chat, or set the default for new clocks.

Because the clock is worked out from the messages every time, it follows the chat. If you delete messages, the clock goes back. If you edit a tag or swipe to another reply, the clock changes with it. Branches keep the time they branched at. A change you make by hand belongs to the latest message. If you delete that message or swipe to a different reply, the change goes with it. New swipes keep it.

Each message's header shows the story time just after that message (🕒 *Thu 14 Mar, 9:42 PM*).

## Time changes

Tags, the panel's box and `/clock` all accept the same things, and you can combine them:

| Write | Meaning |
|---|---|
| `+20m` `+3h` `+2h30m` `+1.5h` `+2d` `+1w` `+1mo` `+1y` `-15m` | Move by that much |
| `3 hours`, `an hour later`, `half an hour`, `a few days later`, `next week` | The same, in words |
| `07:30` `7:30pm` `7pm` `noon` `midnight` | The next time the clock shows that time (07:30 at night means 7:30 tomorrow) |
| `morning` `afternoon` `evening` `tonight` `dawn` `dusk` | The next 08:00, 15:00, 18:00, 21:00, 06:00 or 19:00 |
| `tomorrow`, `tomorrow 9am`, `+2d 08:00` | Days ahead, at that time. After midnight, "tomorrow 9am" means the coming 9 AM |
| `friday`, `next monday 09:00` | The next such day |
| `2024-03-15`, `2024-03-15 18:00` | An exact date (and time) |

Tags whose contents can't be read are left visible in the chat, so you can spot them.

## Slash commands

- `/clock`: returns the story date and time. `format=time|date|weekday|timeofday|day|iso` returns one part.
- `/clock +2h` (or any change above): moves the clock, then returns the new time. Add `quiet=true` to skip the notice.
- `/clock-start 2024-03-14 21:42`: starts or restarts this chat's clock, as of the latest message. `/clock-start now` uses the real time.
- `/clock-undo`: takes back the last change you made by hand after the latest message.
- `/clock-stop`: removes the clock from this chat.

## Macros

These work anywhere SillyTavern reads macros: character cards, Author's Note, World Info, Quick Replies, and the Summarize prompt. They're empty in chats without a clock.

`{{scenario_time}}` `{{scenario_date}}` `{{scenario_weekday}}` `{{scenario_timeofday}}` `{{scenario_day}}` `{{scenario_datetime}}` `{{scenario_iso}}`

**With Summarize:** the clock is already in the prompt when a summary is written. To have summaries record times too, add something like this to the Summarize prompt: *"The story's current date and time is {{scenario_datetime}}. Mention when events happened."*

## Settings

- **Let the AI move the clock with time tags**: adds the tag instructions to the prompt. Turn it off if you'd rather move time yourself. Quiet background prompts (like summaries) never get the instructions.
- **Start a clock in new chats automatically**, starting at the real date and time or one you choose.
- **Each message without a tag adds N minutes**: the default for new clocks. Change an existing chat's value in its panel; the change only applies to later messages.
- **Time tags in the chat**: hide them, show a small 🕒 badge, or leave them as written.
- **Show the story time on each message**, **24-hour clock**, **date style**.
- **Prompt position**: in the chat at a depth (default 0: just after the latest message, where the AI is least likely to miss it), or before or after the main prompt. You can also choose the role.
- **Clock text** and **time tag instructions**: edit them freely. They use the macros above.

## Limits

- Gregorian calendar only, years 1 to 9999. There's no support for fantasy calendars.
- No time zones. The clock is a wall-clock reading, so daylight saving never moves it.
- The AI has to cooperate. Most models follow the tag instructions well, especially with the prompt at depth 0. If one doesn't, move the clock yourself, or raise the minutes per message.

## Checking it in SillyTavern

The automated tests (`npm test` in the WhatsChat repository) cover the time maths, the tag parser, the timeline, the panel and the SillyTavern wiring against a stand-in. A quick check in a real SillyTavern:

- [ ] Start a new chat. The panel shows a clock, and the wand menu shows **Clock: …**.
- [ ] Send a message, then open the prompt inspector for the reply (or the terminal log). The last system message is the story clock text, followed by the tag instructions.
- [ ] Ask the character to skip to the next morning. The reply's tag is hidden, the header shows the new time, and the panel agrees.
- [ ] Swipe that reply. The prompt for the new swipe has the time from *before* the old reply.
- [ ] Delete the reply. The clock goes back.
- [ ] Type `/clock +1h` and `/clock format=time`.
- [ ] Put `{{scenario_datetime}}` in the Author's Note and check it in the prompt.
