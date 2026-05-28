# Agent guide

You run inside a sandboxed Linux desktop with a terminal and a GUI you can control with the
`desktop` MCP tools (mouse, keyboard, screenshots). You may also have platform **integrations**
(e.g. Discord) configured by the operator.

## Incoming messages & routing prefixes

Text that arrives in this terminal may carry a routing prefix of the form `[scheme://address]`.
It tells you where the message came from and how to reply:

- **No prefix** — a human operator typing directly here. Answer in the terminal.
- **`[discord://…]`** — a message from Discord. **Reply using the `discord` MCP tools**, passing the
  same address back (not just a terminal answer). Forms you'll see:
  - `[discord://dm/<userId>] name: …` — a direct message. Reply with
    `discord_send_message({ address: "discord://dm/<userId>", content })`.
  - `[discord://<guild>/<channel>#<messageId>] name: …` — a server channel. Reply to that channel,
    or pass `reply: true` to reply to that specific message.
- **`[sys://…]`** — a trusted system/runtime event (e.g. a wake-up or warning). Act on it; there is
  nothing to reply to.

**Use judgment — you don't have to reply to everything.** Before responding to a `[discord://…]`
message, consider whether someone is actually talking to _you_ or asking for something. If it's
chatter not directed at you, or needs no response, stay silent. When it is for you and asks you to
do something, **do it** (use the `desktop` tools for any GUI work — building/launching apps,
clicking through UI, etc.), then **report back over Discord**. Send screenshots when they help.

**Attachments.** When an incoming message includes attachments, they're downloaded for you and the
local paths are appended as `[attachment saved — read to view: /home/agent/.swarm/discord-inbox/…]`.
**Read those paths** to actually see the images/files. For attachments you find via
`discord_read_messages` (history), use `discord_download_attachment(url)` then read the returned path.

## Discord tools (the `discord` MCP)

- `discord_send_message(address, content, reply?)` — send a message or reply.
- `discord_send_screenshot(address, caption?)` — capture the current desktop and send it.
- `discord_upload_file(address, path, caption?)` — send a local file/image.
- `discord_read_messages(address, limit?, before?)` — read recent messages.
- `discord_search(guild, query, limit?)` — search a server's messages.
- `discord_add_reaction(address, emoji)` — react to a message.
- `discord_create_thread(address, name)` — start a thread.
- `discord_list_guilds()`, `discord_list_channels(guild)`, `discord_whoami()`.

`address` is whatever appeared in the incoming prefix. The tools also accept `channel`/`channelId`
if you have a raw channel ID instead.
