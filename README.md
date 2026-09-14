# Minecraft bot fleet

A local web control room for a team of [Mineflayer](https://github.com/PrismarineJS/mineflayer) bots in **Minecraft Java Edition 1.21.1**.

Open a singleplayer world to LAN, connect the bots from your browser, and send them to farm, mine, terraform, craft, and talk. Each bot is an independent Minecraft player with its own inventory, logs, and default job. Skills are rule-based routines — not an open-ended AI that invents new behavior.

The controller runs on your machine and listens only on localhost. Optional OpenAI chat and optional Supabase storage can be added later.

Want to change the code? Start with the [architecture walkthrough](docs/CODE-GUIDE.md).

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer
- Minecraft Java Edition **1.21.1** (the version Mineflayer joins)
- A singleplayer world opened to LAN
- Commands enabled in that world (`/gamemode`, `/tp`)
- A normal terrain world for gathering and farming. Superflat Creative voids will not supply trees, stone, or food.

The bots join as offline LAN players. They do not use your Minecraft account unless you later connect them to an online server.

## Quick start

```sh
npm install
npm run web
```

On macOS you can also double-click **Start Web App.command**. Keep that Terminal window open.

1. Open **http://127.0.0.1:4317**.
2. In Minecraft: **Esc → Open to LAN**. Prefer **Survival** as the joining game mode so the bots do not reset to Creative on reconnect. Leave **Allow Commands** on.
3. In the control room, pick a bot tab, keep a stable **world label** for that save, and click **Connect bot**. Leave the LAN port blank to read it from the latest game log, or type the port Minecraft shows.
4. Put the bot in Survival if needed: `/gamemode survival Marc` (or that bot’s name). You can stay in Creative yourself.
5. Press **Start** for the bot’s default skill, or choose another skill and start it.

Refreshing the page keeps the same bot sessions. Use the same world label when you reopen the same save, and a different label for a new world — saved places, unfinished jobs, and shared storage are grouped by that label.

`/tp Marc @s` brings a bot to you without hunting coordinates. The bot can only see chunks it has loaded.

## The control room

**Your bots** lists everyone in the fleet. The sticky bar shows who you are controlling. Start, Stop, Connect, the map, inventory, and commands apply only to that bot. **Emergency: stop all bots** cancels every running task.

### Live map

The main view is a **33 × 33** image of loaded blocks. It follows the selected bot by default; **Follow** can lock onto a tracked player. Distant players the bot has not loaded will not appear in the image.

| Action | What happens |
| --- | --- |
| Click a tile | Inspect the block and height, then **Walk near selection** |
| Drag a rectangle | Choose **1–4 layers** and **Mine selection** (at most 512 blocks) |
| − / + | Look four blocks lower or higher. This is a cutaway, not a satellite photo |
| Arrow keys | Inspect tiles. Enter selects, Shift+arrows extend a rectangle, Escape clears |

Selecting freezes the image. Selections expire after 30 seconds. **Refresh / clear selection** reloads it. **Save image** downloads a PNG. Mining starts at the highest displayed block and cuts downward; lower terrain may need another pass. The server refuses stale snapshots, far-away selections, and terrain that changed after you selected it.

Health, hunger, inventory, nearby resources, and observed hostiles sit beside the map. Inventory icons come from your installed Minecraft 1.21.1 client jar the first time `npm run web` runs. Nothing is downloaded. Rebuild them with `npm run textures`, or set `MINECRAFT_JAR` if the game lives somewhere other than the default launcher folder. Without a jar, the app still runs and shows lettered tiles.

### Activity

The **Bot activity** panel is always above the map. It shows Idle / Running / Stopping, game mode, and why Survive is unavailable. While a task runs you see the current action, elapsed time, timeout, and last position change. Standing still is normal while crafting, digging, or waiting for the server.

The expandable **Live activity log** records commands, tools, paths, starts, results, obstacles, and rejected requests. Filter to warnings and errors, follow new events, or **Download log**. File logs live under each bot’s `data/` directory, rotate at 2 MB, and survive restarts. The browser shows the latest events for the current controller session.

Follow the log from another Terminal:

```sh
npm run logs
```

## The fleet

Nine bots share one controller. Each has a Minecraft username, its own data directory, and a default skill. You can start a different skill on any of them.

| Bot | Default skill | Start command |
| --- | --- | --- |
| Marc | Continuous wheat farm | `farmer` |
| Jerry | Tree farmer | `farm trees` |
| Barneett | Practice movement | `practice-movement` |
| Sam | Storage and crafting | `storage and crafting` |
| Orin | Ore finder | `find ores` |
| Cane | Sugarcane farmer | `farm sugarcane` |
| Knight | Mob killer | `hunt mobs` |
| Terra | Terraformer | `terraform` |
| Forge | Smelter | `smelt` |

Connect them with the same LAN settings and the same world label. Stopping or disconnecting one bot does not stop the others.

## Skills

Skills need **Survival mode** and a connected bot. Start them from the skill selector, the Start button, the web conversation, or Minecraft chat (`Marc, start farmer`). `skills` lists what is available. `switch to <skill>` cancels the current job, waits for it to settle, then starts the replacement. `stop` cancels the running skill. `turn on` resumes the last skill requested this session, or that bot’s default.

| Skill | What it does |
| --- | --- |
| **Survive** | Starter routine: wood, tools, exposed iron (no smelting), food, and a small irrigated farm. About 20 minutes, resources within 80 blocks. It does not hunt, fish, fight, or build shelter. |
| **FARMER** | Continuous wheat: harvest, replant, expand irrigated plots, light the area, and store surplus in chests. Runs until Stop. |
| **Tree farmer** | Cuts whole trees (oak, birch, spruce, jungle, acacia, dark oak, cherry), climbs with dirt, recovers the supports, and replants matching saplings. Unfinished trees are saved across Stop. |
| **Get torches** | Crafts 16 torches from coal, charcoal, or a furnace run. FARMER also stocks and places a few lights on its own. |
| **Sugarcane farmer** | Harvests grown cane above the base, replants along water, expands the patch, and stores surplus. |
| **Ore finder** | Scans loaded terrain for exposed ore, mines reachable veins, and stores raw ore. Does not tunnel or dig straight down. |
| **Terraformer** | Levels a bounded rectangle: cuts above the target height, fills below. Select on the map or `flatten x1 z1 to x2 z2 at y`. Stop keeps the job so a later start resumes. |
| **Smelter** | Pulls raw materials and fuel from shared storage, runs nearby furnaces, and stores the output. `smelt raw_iron 16` does one batch. |
| **Storage and crafting** | Inspects and enrolls chests, stores surplus, organizes categories, and fulfills craft jobs. Needs [Supabase setup](docs/STORAGE-SETUP.md). |
| **Mob killer** | Patrols from its start post, fights hostiles (not creepers in melee, never players or animals), retreats and eats when hurt, and stores drops. |
| **Practice movement** | Walks to the nearest sponge. Move the sponge to send the bot somewhere else. |
| **Exchange** | One meeting with a nearby idle bot: a gift or a two-way trade of surplus supplies. |

Each production skill has a longer guide under [`docs/skills/`](docs/skills/).

**Stop** cancels further work. An action already sent to Minecraft (a dig, a placement, a tossed item) may still finish. Wait for the activity panel to settle before starting the next job. If a hung action cannot be released, disconnect that bot and connect again.

## Chat and commands

Address a bot by name in Minecraft chat or whisper, or type in the web conversation (unnamed web commands go to the selected bot):

```
Marc, start farmer
Jerry, switch to practice movement
Sam, start storage and crafting
Jerry, turn on
Marc, stop
Marc, skills
```

Skill commands work with no API key. Public in-game commands must start with the bot’s name so other players cannot steer them.

### Everyday commands

| Command | Result |
| --- | --- |
| `look around` | Refresh nearby resources and threats |
| `where are you` | Current coordinates |
| `go to -31 38 -26` | Walk near that block |
| `find oak logs` | Up to 24 matches within 32 blocks |
| `find stone 64` | Search within a radius (max 64) |
| `save base` / `go to base` / `forget base` | Saved places for this world label |
| `help` | Supported command list |
| `stop` | Cancel movement and the running skill |

The map, search form, saved-place buttons, and Stop button issue the same commands.

### Mining and farming

| Command | Result |
| --- | --- |
| `mine stone 16 within 32` | Mine up to 16 stone in loaded terrain |
| `mine oak logs 8` | Nearby oak logs (default radius 32) |
| `mine area 10 64 10 to 12 66 12` | Clear the inclusive box (max 512 blocks) |
| `farm wheat 16` | One pass on existing farmland |
| `farm carrots 16` / `farm potatoes 16` / `farm beetroot 16` | Harvest ripe crops and replant |
| `farm all 16` | Tend all four crops |

Type mining defaults to 16 blocks (max 128) and a radius of 64. The bot picks the fastest suitable tool it already has. Give it tools first — individual mine/farm commands do not craft them. Survive and the production skills can make or fetch their own.

Area corners can be in either order, both within 64 blocks of the bot. Unbreakable blocks, liquids, unloaded cells, and unreachable targets are reported, not marked cleared. The bot will not dig access tunnels outside your selection.

Farming is **one pass**, not a background loop. It only harvests fully grown wheat, carrots, potatoes, and beetroot on existing irrigated farmland. It does not till, place water, use bone meal, or wait for growth. Use **FARMER** or **Tend crops** when you want ongoing wheat production.

### Exchange

Start **Exchange** on **one** idle bot. Automatic sharing looks at dirt, bread, torches, logs, saplings, and role supplies, and leaves tools and modified items alone. For a specific partner or items:

| Command | Result |
| --- | --- |
| `Marc, exchange with Jerry` | Choose a useful gift or trade |
| `Marc, give Jerry 16 dirt` | One-way gift |
| `Marc, trade Jerry 16 wheat for 8 oak_log` | Give, then receive |

Use Minecraft item IDs with underscores. Quantities are 1–64 each way. Both bots must be on the same world and dimension, in Survival, and within 32 blocks. A busy partner is left alone — stop that bot first. Minecraft transfers by dropping items, so a two-way trade is not atomic; already-delivered items stay with the recipient.

### Skill-specific commands

| Command | Result |
| --- | --- |
| `find ores` / `find ores iron within 48` | Ore finder (coal, iron, copper, gold, redstone, lapis, diamond, emerald) |
| `farm sugarcane` | Continuous sugar cane |
| `hunt mobs` / `hunt mobs within 16` | Guard from the start post (radius 8–48) |
| `flatten 10 20 to 25 40 at 64` | Level that rectangle to Y=64 |
| `smelt` / `smelt raw_iron 16` | Continuous smelting, or one batch |
| `scan storage` / `store surplus` / `organize storage` | Shared chests |
| `create storage wood` / `manage storage 10 64 -5 wood` | Enroll a chest category |
| `craft stone_pickaxe 2` | Queue a craft job |

## How the bots move

Travel is shared by the map, mining, farming, and every skill. Bots can swim, climb low banks, jump a one-block gap, open wooden doors and fence gates, and walk along fence tops from a raised approach. They may place short stairs or bridges from ordinary blocks already in inventory (at most 16 blocks per route): stairs up to five blocks onto a shore, bridges across up to eight missing blocks.

They will not dig a path to the destination, sprint-jump, use iron doors, or walk into lava or farmland as a route. Destinations are capped at 256 blocks; navigation times out after 60 seconds. If progress stalls for a few seconds, the route is cleared and retried a couple of times.

Close hostiles, critical health, or low air pause most skills so you can help. Knight is the exception: it fights inside its patrol, then retreats and eats. None of the skills are a guarantee the bot stays alive.

## Optional: talk to the bots

Copy `.env.example` to `.env` and set `OPENAI_API_KEY`. Restart `npm run web`. The key stays on the server; the browser never sees it. Usage is billed to your OpenAI account. The **API costs** panel estimates spend from recorded tokens.

With chat enabled, `Marc, what are you doing?` in Minecraft chat or a whisper gets a reply about the current task, inventory, and nearby observations. Replies are informational only: the model cannot move the bot or run commands. Mentions and whispers still work. Every 30 seconds the bot can also post a short `[Update]` while it is working.

Turn replies on or off per bot in the **LLM chat** card. Per-bot `llm.json` files store that preference, never the key. Skill commands work with chat disabled.

## Optional: shared storage

With [Supabase configured](docs/STORAGE-SETUP.md), Sam and the production skills share inspected chests and a crafting queue. Farmers deposit surplus; Orin stores ore; Forge smelts hub materials; Terra and Knight can fetch tools. Without configuration, standalone skills still run using only what they carry.

Use the same world label for the whole fleet. Apply the SQL in `supabase/migrations/` in filename order, then fill `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`. The browser never receives those credentials.

## Online servers

After the local LAN demo works, you can point a bot at a server you have permission to use. Put `host`, `port`, your account email as `username`, `auth: "microsoft"`, and `version: false` in `config.json`, then run `node bot.cjs` and complete Microsoft device sign-in. The account must own Java Edition. Disconnect your regular client first if it is the same account. Never put a password in the file.

`config.json` and `.auth/` are gitignored. Do not share the authentication cache. The Terminal movement demo (`npm start`) is separate from the web control room.

## Limits worth knowing

- Bots only see **loaded chunks**. Finding ore on the map is not proof it is reachable.
- Resource surveys cap category totals; searches return at most 24 listed blocks.
- Creative mining does not drop Survival items. Nearby drops are collected when reachable; a removed-block count is not a guarantee every item reached inventory.
- Tree farmer does not auto-store logs in chests unless shared storage is set up. Empty a full inventory yourself if you are running it standalone.
- Exchange, mining, and farming are bounded jobs. They are not a world-wide planner.
- The web app binds to this computer only. Saved places live in gitignored `data/waypoints.json`.

## Develop

```sh
npm run check   # syntax
npm test        # simulated movement, skills, and API tests
```

These tests do not open a live Minecraft connection.

| Doc | Contents |
| --- | --- |
| [docs/CODE-GUIDE.md](docs/CODE-GUIDE.md) | How a click becomes a bot action, and which file to read |
| [skill.md](skill.md) | How to add a skill or a new bot |
| [docs/STORAGE-SETUP.md](docs/STORAGE-SETUP.md) | Shared chests and crafting |
| [docs/skills/](docs/skills/) | Per-skill commands and cycles |

Try one bot live without the rest of the control room:

```sh
node --env-file-if-exists=.env scripts/live-skill.cjs --bot orin --command "find ores" --seconds 180
```

`--pre "/give @s stone_pickaxe"` sends chat lines first. The harness prints the activity log, position, inventory, and a JSON summary, then disconnects.

The browser UI is static files in `public/`. No frontend build step.

### Project and per-agent API costs

The **API costs** panel above the bot controls tracks the whole project or a named bot.
Choose today, this month, the last seven days, all tracked history, or custom UTC dates.
Expand the panel for agent/model breakdowns, daily trends, the last 50 requests, and
optional daily/monthly budget alerts. **Download CSV** exports the entire filtered history.
The panel refreshes every ten seconds while in use, including when bots are disconnected.

OpenAI estimates use the response's actual model, service tier, input/cache-read/cache-write
and output usage. Reasoning tokens are already included in output, so they are not added
again. GPT-5.6 Luna rates were checked against [official OpenAI pricing](https://developers.openai.com/api/docs/pricing)
on September 14, 2026; the rate card also handles Fast/Flex tiers and the model's long-context
threshold. See [prompt cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching).
Every priced request retains its rate snapshot. Prices are estimates, not provider invoice
reconciliation; negotiated rates, credits, taxes, and external usage are not included.
Update `src/api-pricing.cjs` when provider rates or the configured model change. A dated
model ID or unknown service tier is left unpriced rather than matched to a guessed rate.
The panel flags rate cards older than 90 days.

Supabase world-resolution and RPC requests are also attributed to their initiating bot,
with request counts and outcomes. Shared world-resolution requests count only once.
Supabase compute/storage/egress charges are **billed separately**, not presented as zero
cost. Local Minecraft skills, explicit skill commands, and bot-to-bot coordination do not
make OpenAI requests. This monitor does not track the Codex app's development usage or
reconstruct API bills from before monitoring was installed.

Records live in ignored `data/api-costs.sqlite`, shared by all fleet agents. SQLite uses
transactions, WAL and full synchronous writes; it survives browser/server restarts and
records requests before sending them. A pending request older than one minute is shown
as interrupted with unknown cost, and a later response can still supply its usage. Failed,
cancelled and timed-out calls with no usage remain **unknown**, not free. Received usage
counts even if a reply is empty, stale, or discarded after disconnect. Response IDs prevent
duplicate cost/token totals. API keys, request/response text, inventory payloads, and raw
provider errors are never written to the cost ledger or returned by its endpoints.

Budget alerts appear at 80% and 100% for the project or a bot, using current UTC-day/month
totals. They are optional on-screen alerts, not spending caps: bots keep running. Unknown
costs can make a budget underestimate the eventual bill. A ledger failure is visible and
marks monitoring as incomplete without stopping Minecraft work. Restart after fixing a
storage error. Back up the database after stopping the controller; while it runs, include
its SQLite `-wal` file rather than copying only the main database.

Read-only endpoints: `GET /api/costs`, `GET /api/costs/export`, and each bot's equivalent
under `/bots/<id>`. Filters are `from=YYYY-MM-DD`, `to=YYYY-MM-DD` (inclusive UTC day), and
`agent=Marc`. Save alerts with `POST /api/costs/budgets`, for example
`{"scope":"Marc","dailyUsd":1,"monthlyUsd":20}`; `null` disables an alert. Existing local-only
Host/origin protections apply. No new npm dependency is needed; Node 22.13+ supplies SQLite
(the existing Node 22.23.1 installation qualifies).

Restart the controller to activate collection. The implementation was checked with simulated
OpenAI/Supabase responses and a browser preview, without making paid validation requests.
