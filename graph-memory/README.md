# Graph Memory

Long-term memory for your SillyTavern characters, kept as a knowledge graph by [graphify](https://github.com/safishamsi/graphify).

As a chat goes on, Graph Memory has the AI read it a few messages at a time and note who and what appeared, what they're like now, what happened, and how they're connected. graphify turns those notes into a graph. Before each reply, graphify searches the graph using the newest messages and follows the connections, and the relevant memories go into the prompt:

```
[Long-term memory: what the story has established so far. Use it for continuity; don't recite it.]
• Kai (person), also called the traveller: Recovering from a wolf bite; now trusts Seraphina. (Earlier: A wounded traveller from the north.)
• The Silver Amulet (item): Kai's mother's amulet; glows near danger.
   – Kai gave to Seraphina (the silver amulet)
• Shadow Wolves (creature): A pack that hunts at night.
   – Shadow Wolves attacked Kai
```

So the character still knows about the amulet 400 messages later, long after it scrolled out of the context window. It only brings up what's relevant to the moment.

## How it works

```
 chat ──every 8 messages──► the AI reads the new slice ──► entities + relations (JSON)
                                                                   │
                                     server plugin merges them by name (Kai = kai = "the traveller")
                                                                   │
                                     graphify: build_from_json → cluster → graph.json + graph.html
                                                                   │
 before each reply: newest messages ──► graphify's MCP server (query_graph) ──► relevant entities
                                                                   │
                                     written up as notes ──► inserted into the prompt
```

- **graphify does the graph work.** It builds and clusters the graph and, through its MCP server (`python -m graphify.serve`), decides what's relevant to a question: keyword matching on names, aliases and descriptions, then a walk through the connections. If graphify's MCP extra isn't installed, the plugin uses the `graphify query` command instead.
- **Your own AI does the reading.** By default, remembering uses the AI connection you chat with, so there's no extra API key. You can pick a separate connection profile instead, for example a cheaper model.
- **Memories follow edits.** If you edit, delete, swipe or hide a message that was already read, that slice is read again. The newest 2 messages are left alone until they settle.

## What you need

- SillyTavern 1.19 or newer.
- Node.js 20 or newer. SillyTavern already needs it.
- Python 3.10 or newer, with graphify and its MCP extra:

  ```sh
  uv tool install "graphifyy[mcp]"        # recommended
  # or: pipx install "graphifyy[mcp]"
  ```

  The package is `graphifyy`, with two y's. Graph Memory finds graphify's Python by itself if it was installed with uv or pipx, or if `graphify` is on the PATH of the user that runs SillyTavern.

## Install

Graph Memory has two halves: a **server plugin**, which runs graphify, and a **UI extension**, which works inside SillyTavern's page. Both are this `graph-memory` folder, copied into two places. The server plugin has no npm dependencies, so there's nothing to build.

```sh
git clone https://github.com/kbm8fb8gsf-sudo/WhatsChat ~/whatschat
cp -r ~/whatschat/graph-memory SillyTavern/plugins/graph-memory
cp -r ~/whatschat/graph-memory SillyTavern/data/default-user/extensions/graph-memory   # or your user's folder
```

Turn on server plugins in SillyTavern's `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart SillyTavern. The console should show:

```
[Graph Memory] Loaded.
[Graph Memory] Using graphify 0.9.108 (…/graphifyy/bin/python, MCP server available).
```

> SillyTavern's **Install extension** button needs `manifest.json` at the top of a repository. Here it sits inside `graph-memory/`, so copy the folder as shown. If you move `graph-memory` into a repository of its own, the button works.

**Updating:** pull, copy the new files over the old ones, and restart SillyTavern. Your memories live in `plugins/graph-memory/data/`, which this keeps:

```sh
cd ~/whatschat && git pull
cp -r ~/whatschat/graph-memory/. SillyTavern/plugins/graph-memory/
cp -r ~/whatschat/graph-memory/. SillyTavern/data/default-user/extensions/graph-memory/
```

### If graphify isn't found

The panel lists every Python it tried and why each one didn't work. To name the Python yourself, create `plugins/graph-memory/data/config.json`:

```json
{ "python": "/home/you/.local/share/uv/tools/graphifyy/bin/python" }
```

or set `GRAPH_MEMORY_PYTHON` in the environment that starts SillyTavern, then click **Check again**. Use the path to the virtualenv's `python` as it is. Don't resolve the symlink, because that would leave the virtualenv.

For security, this path can only be set on the server, never from the browser.

## Using it

Open **Extensions → Graph Memory**.

- **Memory belongs to**: *This chat only* (the default) keeps each chat's story separate. *The character* shares one memory across all of that character's chats, or a group's chats. That suits a long-running relationship across many chats.
- **Remember whole chat**: reads everything not yet remembered, including the newest messages. Use it once on an existing long chat. It shows progress and has a **Stop** button.
- **Preview recall**: shows exactly what would be added to the prompt for the next reply.
- **Open graph**: graphify's interactive picture of the memory. You can search it, filter by group and click a node to see its details.
- **Rebuild graph**, **Forget chat** (removes what was learned from this chat only) and **Delete memory**.

### Settings

| Setting | Default | What it does |
|---|---|---|
| Search with the last … messages | 3 | Which messages are used to search the memory before a reply. |
| Connection depth | 2 | How far graphify follows connections from what the messages mention (1–6). |
| Longest memory note | 2000 characters | Cap on what's inserted. The most relevant memories come first. |
| Insert | In the chat, 4 messages from the end, as System | Where the note goes. You can also put it before or after the story string. |
| Template | see above | Wording around the notes. Must contain `{{memory}}`. |
| Remember automatically | on | Read the chat as it goes. |
| After every … new messages | 8 | How often. Each read is one extra AI request. |
| Leave the newest … alone | 2 | Skip messages you might still swipe or edit. |
| Read at most … messages at once | 24 | Size of one slice. |
| AI used for remembering | current connection | Or a connection profile (needs SillyTavern's Connection Manager). |

### Cost

Remembering sends each slice of chat to the AI once, with a short instruction and the names already remembered. With the defaults that's one extra request per 8 messages, of roughly the size of those messages. Recall adds no AI requests: graphify searches locally and answers in a few milliseconds.

If remembering fails, for example because the model doesn't answer with valid JSON, it pauses for that chat and shows a warning rather than retrying and spending tokens on every message. Switching chats or clicking **Remember whole chat** tries again. Models that follow instructions well give the best memories.

## Your data

Everything is stored in `plugins/graph-memory/data/` (or the folder in `GRAPH_MEMORY_DATA_DIR`), separately for each SillyTavern user:

```
data/users/<user>/<memory>/
  segments/   what was learned from each slice of chat (JSON)
  corpus/     the text of each slice (graphify's source files)
  extraction.json, graphify-out/graph.json, graphify-out/graph.html
```

Files are readable only by the user that runs SillyTavern. Chat text is sent only to the AI you chose for remembering. graphify runs locally and is told not to log queries. The graph picture is graphify's page. It loads its drawing library (vis-network) from unpkg.com, so it needs internet access to draw. It's served in a sandbox, so nothing on it can reach your SillyTavern session.

## Troubleshooting

| What you see | What to do |
|---|---|
| "The Graph Memory server plugin isn't running" | Check that the folder is in `SillyTavern/plugins/` and `enableServerPlugins: true` is set, then restart SillyTavern. |
| "graphify was not found" | Install it with `uv tool install "graphifyy[mcp]"` as the user that runs SillyTavern, or name the Python (see above). Then click **Check again**. |
| "command line; install graphifyy[mcp] for faster recall" | It works, but each recall starts Python. Run `uv tool install --force "graphifyy[mcp]"`, then **Check again**. |
| "Remembering is paused for this chat: The AI's answer didn't contain the expected JSON." | The model wrote prose instead of JSON. Try a stronger model, or pick a connection profile for remembering. |
| Nothing is recalled | Click **Preview recall**. If the memory is empty, click **Remember whole chat**. Recall finds things by the names and words in the newest messages, so try raising **Search with the last … messages**. |
| The graph page is blank | It needs internet access for vis-network (see "Your data"). |

## Development

```sh
cd graph-memory
npm install            # dev tools only: eslint, typescript, vitest, jsdom
npm run check          # lint + typecheck + tests
GRAPH_MEMORY_TEST_PYTHON=~/.local/share/uv/tools/graphifyy/bin/python npm test   # also runs against real graphify
~/.local/share/uv/tools/graphifyy/bin/python -m unittest discover -s python -p 'test_*.py'
```

| Path | What it is |
|---|---|
| `server/index.js` | Plugin entry point: `info`, `init(router)`, `exit()`. |
| `server/routes.js` | HTTP API under `/api/plugins/graph-memory`. |
| `server/store.js`, `merge.js`, `normalize.js` | Memory folders, merging entities by name into graphify's extraction format, input validation. |
| `server/graphify.js`, `runtime.js`, `mcp-client.js` | Finding graphify's Python, debounced builds, and queries through graphify's MCP server or its CLI. |
| `server/render.js` | Turns graphify's answer into memory notes. |
| `python/gm_bridge.py` | Runs graphify's `build_from_json`, `cluster`, `to_json` and `to_html`. |
| `extension/` | The SillyTavern side. `st.js` is the only file that touches SillyTavern itself. |

See [docs/manual-test.md](docs/manual-test.md) for the end-to-end check in a real SillyTavern.
