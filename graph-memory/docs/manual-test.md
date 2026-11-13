# Manual test in a real SillyTavern

This is the end-to-end check run before release, against SillyTavern 1.19.0 (`release` @ 06bde93) and graphify 0.9.108. It used a stand-in OpenAI-compatible AI that logs every request, so the prompts can be inspected.

## Setup

1. Install graphify: `uv tool install "graphifyy[mcp]"`.
2. Copy `graph-memory/` into `SillyTavern/plugins/` and `SillyTavern/data/default-user/extensions/`. Set `enableServerPlugins: true`.
3. Start SillyTavern. The console shows `[Graph Memory] Loaded.` and `Using graphify … MCP server available`.
4. Connect to a Chat Completion API and open Seraphina.

## Checks

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | Open **Extensions → Graph Memory** | "graphify 0.9.108 is connected through its MCP server." "Nothing remembered yet." | ✅ |
| 2 | Send 5 messages that mention a silver amulet and shadow wolves | After the 8th message, one extra AI request whose system prompt starts "You are the memory keeper…" and whose user message holds `[#0] Seraphina: …` lines in `<story>` | ✅ |
| 3 | Wait a few seconds | Panel: "4 things remembered, 2 connections, 2 groups." "messages #0–#10 of 15 remembered" (newest 2 held back) | ✅ |
| 4 | Send "Do you still have the amulet I gave you? I hear wolves again." | The AI request contains a system message 4 messages from the end with "[Long-term memory…]", the amulet, the wolves, and "Kai gave to Seraphina (the silver amulet)" | ✅ |
| 5 | Open **Last recall** | "4 things recalled in 5 ms via mcp" (the first recall after start-up takes about 0.5 s while graphify's MCP server starts) | ✅ |
| 6 | Click **Remember whole chat** | Progress shows, **Stop** appears, then "messages #0–#26 of 27 remembered" | ✅ |
| 7 | Click **Preview recall** | The exact note for the next reply, inside the template | ✅ |
| 8 | Click **Open graph** | graphify's graph page draws the 4 entities in 2 groups ("Kai & Seraphina", "Silver Amulet"). It runs sandboxed: `window.origin` is `null` and `document.cookie` throws. vis-network was served locally because the test sandbox blocks unpkg.com. | ✅ |
| 9 | Edit message #3, send 2 more messages | That slice is forgotten and read again | covered by unit tests |
| 10 | Switch **Memory belongs to** to *The character* | A new, empty memory shared by Seraphina's chats | covered by unit tests |
| 11 | Pick a connection profile for remembering | Remembering requests go to that profile's API | not run (needs a second API) |

No errors from Graph Memory appeared in the browser console. The only errors came from SillyTavern trying to reach AI Horde and unpkg.com, which the sandbox blocks.
