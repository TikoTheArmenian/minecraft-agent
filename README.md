# Minecraft Agent

**A local control room for a team of Minecraft bots.**

Minecraft Agent brings a small crew of automated players into your Minecraft Java world. Give them jobs—growing wheat, gathering wood, finding ore, running furnaces, or organizing shared supplies—and watch their progress from a browser. Each bot has its own inventory, activity history, and assignment, so you can run one helper or coordinate a whole fleet around your base.

The project uses [Mineflayer](https://github.com/PrismarineJS/mineflayer) to connect bots as Minecraft players. The web controller runs on your computer and connects to a local world opened to LAN; no Minecraft mod or frontend build is required. The included fleet has nine bots, and custom profiles can define their names, default jobs, and available skills.

You choose how much automation to use:

- **Direct control:** start tested, rule-based skills and issue movement, mining, and farming commands. No API key is required.
- **Optional AI chat:** ask a bot about its work and surroundings. These replies are informational.
- **Optional AI supervisors:** give individual bots objectives and let a model choose among registered skills. Shadow mode lets you inspect decisions before enabling autonomous execution.
- **Optional shared storage:** connect Supabase so bots can coordinate managed chests and crafting jobs.

This is an experimental automation project. Bots act in the world: they break and place blocks, use supplies, and can die. Begin in a test world or a backed-up save, and keep the activity log visible while you learn how a skill behaves.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [The control room](#the-control-room)
- [The fleet](#the-fleet)
- [Skills](#skills)
- [Chat and commands](#chat-and-commands)
- [How the bots move](#how-the-bots-move)
- [Configuration](#configuration)
- [AI chat and supervisors](#ai-chat-and-supervisors)
- [Shared storage](#optional-shared-storage)
- [API costs](#api-costs)
- [Troubleshooting](#troubleshooting)
- [Development and documentation](#development-and-documentation)
- [Contributing](#contributing)

## Requirements

- [Node.js](https://nodejs.org/) **22.13.0 or newer**, with npm (the controller uses Node’s built-in SQLite)
- Minecraft Java Edition **1.21.1** (the version Mineflayer joins)
- A singleplayer world opened to LAN **on the same computer as the controller**
- Commands enabled in that world (`/gamemode`, `/tp`)
- A normal terrain world for gathering and farming. Superflat Creative voids will not supply trees, stone, or food.

The web fleet joins as offline LAN players at `127.0.0.1`, using Minecraft protocol version `1.21.1`. Bedrock Edition is not supported by this controller. Microsoft authentication for the separate terminal demo is described under [Online servers](#online-servers).

## Quick start

### 1. Download and start the controller

```sh
git clone https://github.com/TikoTheArmenian/minecraft-agent.git
cd minecraft-agent
npm ci
npm run web
```

You do not need an `.env` file for direct control. Leave optional services unconfigured for your first session.

On macOS you can also double-click **Start Web App.command**. Keep that Terminal window open.

### 2. Connect your first bot

1. Open [the control room](http://127.0.0.1:4317).
2. In Minecraft: **Esc → Open to LAN**. Prefer **Survival** as the joining game mode so the bots do not reset to Creative on reconnect. Leave **Allow Commands** on.
3. In the control room, pick a bot tab, enter a stable **world label** for that save and the LAN port Minecraft shows in chat, then click **Connect bot**. The port can change each time you reopen the world to LAN.
4. Put the bot in Survival if needed: `/gamemode survival Marc` (or that bot’s name). You can stay in Creative yourself.
5. Press **Start** for the bot’s default skill, or choose another skill and start it.

For a simple first check, type `where are you`, then `look around` in the selected bot’s web conversation. The dashboard should show its position, health, and nearby blocks. Start one skill and watch the activity log before connecting more bots.

**Port auto-detection:** leaving the port blank only works when your Minecraft installation writes its log to `~/minecraft-agent-worlds/logs/latest.log`. Standard launcher installations should enter the port manually.

### 3. Stop and return later

Use **Stop** to cancel a bot’s work, or **Emergency: stop all bots** for the fleet. To close the controller, press `Ctrl+C` in its terminal; this disconnects the bots.

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
| **Tree farmer** | Starts near a mature tree without starter supplies. Retrieves or crafts an axe and shovel, gathers dirt for access, and cuts whole trees (oak, birch, spruce, jungle, acacia, dark oak, cherry). Collects saplings after cutting, restores missing planting dirt, and saves unfinished planting while harvesting other trees. Tree work survives Stop and restart. |
| **Get torches** | Crafts 16 torches from coal, charcoal, or a furnace run. FARMER also stocks and places a few lights on its own. |
| **Pumpkin farmer** | Runs `farm pumpkins`: harvests pumpkins beside matching stems, preserves stems, plants irrigated plots with clear fruit lanes, and stores surplus. |
| **Melon farmer** | Runs `farm melons`: harvests melons beside matching stems, preserves stems, makes seeds from slices, and plants irrigated plots with clear fruit lanes. |
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

Skill commands work with no API key. Public in-game commands must start with the bot’s name to select their recipient. This is routing, not player authentication: another player can address a bot too. Use the fleet in worlds with players you trust.

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

Type mining defaults to 16 blocks (max 128) and a radius of 32 (max 64). The bot picks the fastest suitable tool it already has. Give it tools first — individual mine/farm commands do not craft them. Survive and the production skills can make or fetch their own.

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
| `farm pumpkins` | Continuous pumpkin farming (separate skill) |
| `farm melons` | Continuous melon farming (separate skill) |
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

## Configuration

For optional integrations, copy the example once, then edit `.env` locally:

```sh
cp .env.example .env
```

Keep only the settings you use. If you only want AI features, leave the Supabase values empty or remove their placeholder lines; partially configured storage can block shared operations. Restart the controller after changing environment settings. Existing environment variables take precedence over `.env`.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Enables optional chat and supervisor requests. Keep it on the server. |
| `SUPERVISOR_MODEL` | Default supervisor model; profiles can override it. Choose a model available to your API account. |
| `SUPABASE_URL` | Project URL for shared storage and crafting. Configure with the secret key. |
| `SUPABASE_SECRET_KEY` | Backend Supabase key; never put it in browser code. |
| `BOT_PROFILES_FILE` | Path to a JSON array replacing the built-in fleet. See [custom profiles](docs/AGENT-RUNTIME.md#profiles-and-adding-bots). |
| `MINECRAFT_JAR` | Optional path to the installed Minecraft 1.21.1 client jar for local icon extraction. |

Local settings, `.env`, `.auth/`, generated textures, and `data/` are gitignored. Bot profiles may customize data directories; keep those directories private as well.

### Saved data

Each bot stores logs, preferences, saved places, and skill/runtime records in its own data directory. Marc defaults to `data/`; the other built-in bots use subdirectories. The fleet shares `data/api-costs.sqlite` and `data/supervisor-usage.json` for cost history and supervisor usage limits.

Use a stable world label for each save and the same label across its bots. Keep different saves under different labels. Stop the controller before backing up the complete `data/` directory. Supabase-backed storage records need a separate database backup.

## AI chat and supervisors

Both features use `OPENAI_API_KEY` and can incur charges on your API account. They are independent of direct skill commands, which work without a key. Requests include relevant bot context, such as objectives, inventory, nearby observations, or messages, depending on the feature.

### Informational chat

Enable replies per bot in the **LLM chat** card, then ask `Marc, what are you doing?` in Minecraft chat or a whisper. Replies describe the bot’s current work and observations; chat replies cannot execute commands. Automatic periodic summaries are disabled. Per-bot `llm.json` files save the reply preference, never the API key.

### Objective-driven supervisors

Each bot has a separate **Supervisor** panel, objective, skill runner, and inbox. The supervisor can select registered skills, request a switch, stop its own work, message peers through Minecraft, or wait. Physical work still runs through the deterministic skill runtime and its validation and cancellation checks.

1. Connect a bot and enter a small, concrete objective, such as making eight glass.
2. Choose a model available to your API account.
3. Choose **Shadow** to record proposals without executing them, or **Autonomous** to execute decisions. Shadow mode still makes model requests.
4. **Save**, then **Resume**. Saving pauses decisions; a controller restart always leaves supervisors paused.

**Pause** stops new decisions. **Stop** also cancels physical work and pending switches. Manual skill assignments pause autonomous control.

Chat controls include `Marc, goal: Make eight glass`, `Marc, supervisor shadow`, and `Marc, supervisor resume`. Use `supervisor autonomous` to select execution mode.

Request and token caps limit supervisor admission separately from the dollar-cost dashboard. See the [runtime guide](docs/AGENT-RUNTIME.md) for budgets, custom profiles, structured APIs, interruption recovery, and a staged live pilot.

## Optional: shared storage

With [Supabase configured](docs/STORAGE-SETUP.md), Sam and the production skills share inspected chests and a crafting queue. Farmers deposit surplus; Orin stores ore; Forge smelts hub materials; Terra and Knight can fetch tools. Without configuration, standalone skills still run using only what they carry.

Use the same world label for the whole fleet. Apply the SQL in `supabase/migrations/` in filename order, then fill `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`. The browser never receives those credentials.

## Online servers

After the local LAN demo works, you can point a bot at a server you have permission to use. Copy `config.example.json` to `config.json`, set `host`, `port`, your account email as `username`, `auth: "microsoft"`, and `version: false`, then run `node bot.cjs` and complete Microsoft device sign-in. The account must own Java Edition. Disconnect your regular client first if it is the same account. Never put a password in the file.

`config.json` and `.auth/` are gitignored. Do not share the authentication cache. The terminal movement demo (`npm start`) is separate from the web control room. These settings do not reconfigure the web fleet’s localhost-only connection.

## Limits worth knowing

- Bots only see **loaded chunks**. Finding ore on the map is not proof it is reachable.
- Resource surveys cap category totals; searches return at most 24 listed blocks.
- Creative mining does not drop Survival items. Nearby drops are collected when reachable; a removed-block count is not a guarantee every item reached inventory.
- Tree farmer does not auto-store logs in chests unless shared storage is set up. Empty a full inventory yourself if you are running it standalone.
- Exchange, mining, and farming are bounded jobs. They are not a world-wide planner.
- The web app binds to this computer only. Saved places live in gitignored `data/waypoints.json`.

## API costs

The **API costs** panel shows estimated OpenAI spending for the project or an individual bot. Filter by UTC dates, inspect model and daily breakdowns, and download the filtered history as CSV. Estimates use recorded usage and local rate cards; unknown usage or unsupported pricing stays visibly unknown. Update `src/infra/api-pricing.cjs` when pricing or model configuration changes.

Daily and monthly dollar alerts are **notifications, not spending caps**. The supervisor’s request/token limits are enforced separately. Supabase requests are attributed to bots, but Supabase compute, storage, and egress charges are billed separately. The dashboard does not reconstruct earlier bills or track development usage in Codex.

The cost ledger persists in `data/api-costs.sqlite`. It records usage metadata, not API keys or prompt/response text. A monitoring failure is shown in the dashboard and does not stop Minecraft work. For backups, stop the controller first; copying only a live SQLite database can omit writes in its `-wal` file.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Bot cannot connect | Open the world to LAN again, enter its current port, and confirm Java Edition 1.21.1 is running on the same computer. |
| Blank port fails | Auto-detection uses a custom log path; enter the port shown in Minecraft chat. |
| A skill is unavailable | Connect the bot, set it to Survival with `/gamemode survival <name>`, and read the activity panel’s reason. Some jobs also need materials, an area, or shared storage. |
| Bot cannot find a resource or reach a target | It only knows loaded terrain. Move it closer, check the route, and inspect the log for missing tools or supplies. |
| Bot seems stuck | Crafting and digging can take time. Check the current action and timeout, then Stop if needed. Disconnect and reconnect if an action cannot settle. |
| A run requires recovery review | Inspect the world, inventory, and interrupted operation before following the [runtime recovery guide](docs/AGENT-RUNTIME.md#requests-results-and-recovery). |
| Supervisor makes no decisions | Check its model, API key, mode, objective, budget, and pause/error state. Save pauses it; press Resume afterward. |
| Shared storage is blocked | Check both Supabase settings, migrations, world label, enrolled chests, and the reported error in the [storage guide](docs/STORAGE-SETUP.md). |
| Icons appear as letters | Install the matching client jar or set `MINECRAFT_JAR`, then run `npm run textures`. Missing icons do not block the controller. |
| Port 4317 is already in use | The controller may already be running. Open the existing dashboard or close the earlier terminal process. |
| Startup reports unsupported SQLite or Node features | Check `node --version`; use Node 22.13.0 or newer, then run `npm ci` again. |

For a useful bug report, include the bot, command, Minecraft and Node versions, expected behavior, and relevant activity-log lines. Review logs before sharing: they may include player names, chat, and world coordinates. Never include `.env` or authentication files.

## Development and documentation

The controller is CommonJS JavaScript. `src/main.cjs` composes the fleet and starts the local HTTP server; `public/` contains the browser UI with no frontend build step.

| Directory | Responsibility |
| --- | --- |
| `src/agents/` | Bot identity, profiles, and fleet composition |
| `src/runtime/`, `src/skills/` | Validated commands, run lifecycle, and executable skills |
| `src/supervisor/`, `src/messaging/` | Optional model decisions and bot communication |
| `src/minecraft/`, `src/navigation/`, `src/capabilities/` | Confirmed game actions, travel, and shared resource routines |
| `src/storage/`, `src/world/`, `src/infra/` | Shared storage, observations, persistence, and cost tracking |
| `src/web/`, `public/` | HTTP routes and browser controls |
| `test/`, `supabase/migrations/` | Automated tests and database schema changes |

### Run checks

```sh
npm ci
npm run verify
```

`verify` runs syntax checks, ESLint, checked input contracts, architecture boundaries, source formatting, and behavior tests. Individual checks are available through `npm run check`, `npm run lint`, `npm run typecheck`, `npm run architecture`, `npm run format:check`, and `npm test`.

The behavior tests use simulated Minecraft and provider responses; they need no live world or paid model calls. The PostgreSQL integration test skips locally unless `COLONY_TEST_CONTAINER` identifies a disposable test container. The [CI workflow](.github/workflows/verify.yml) provisions PostgreSQL for that test. Offline tests do not establish live Minecraft or model reliability.

### Live skill harness

With a local world opened to LAN, try a single bot:

```sh
node --env-file-if-exists=.env scripts/live-skill.cjs --bot orin --port 51234 --command "find ores" --seconds 180
```

Replace `51234` with the current LAN port shown in Minecraft. See [the harness source](scripts/live-skill.cjs) for additional options. `--pre "/give @s stone_pickaxe"` sends a chat command first and requires commands enabled. The harness performs real world actions, prints activity, position, inventory, and a JSON summary, then disconnects.

### Further reading

| Guide | Contents |
| --- | --- |
| [Code guide](docs/CODE-GUIDE.md) | How a click becomes a bot action and where to make changes |
| [Runtime and supervisors](docs/AGENT-RUNTIME.md) | Implemented contracts, profiles, budgets, APIs, and recovery |
| [Adding skills and bots](skill.md) | Extension workflow and skill conventions |
| [Storage setup](docs/STORAGE-SETUP.md) | Database configuration, shared chests, and crafting |
| [Skill guides](docs/skills/) | Detailed commands and production cycles |
| [Architecture review](docs/AGENT-ARCHITECTURE-REVIEW.md) | Design comparison and architecture findings |
| [Architecture plan](docs/AGENT-ARCHITECTURE-PLAN.md) | Design baseline and staged rollout plan |

## Contributing

Bug reports and focused pull requests are welcome. Describe the problem and how to reproduce it; for a code change, explain the resulting behavior and run `npm run verify`. Add meaningful coverage when changing behavior, and include live-world observations when the change depends on game physics or inventory timing.

Start with the code guide and follow the existing module boundaries. Keep credentials, local configuration, generated assets, and saved world/bot data out of commits.

## Acknowledgments

Built on Mineflayer and the PrismarineJS ecosystem. Minecraft is a trademark of Mojang Studios. This project is independent and is not an official Minecraft product.

### 3D surroundings viewer

Choose a connected bot, then use **Follow** to select that bot or a nearby loaded player in its world. The React Three Fiber viewer defaults to an **11 × 5 × 11** block volume and refreshes every second. The size selector also offers 17 × 5 × 17 and 7, 11, and 15 block cubes. Shallow views sample only five centered vertical layers. Drag to rotate, scroll or pinch to zoom, right-drag to pan, and use **Reset camera** to recenter. Click blocks and player markers to inspect them. **Hide overhead blocks** provides a cutaway.

Pink lines show the selected bot's actual pathfinder waypoints, clipped to the volume and visible through terrain. Paths clear on stop, completion, reset, teleport, or world changes. Unknown chunks remain empty and are counted below the viewer. Block collision shapes preserve slabs and stairs. Blocks use face textures extracted from the installed Minecraft 1.21.1 client, with pixel-sharp filtering and default biome tints. Water spans the full block footprint; farmland is 15/16 of a block tall. Grass, torches, wheat and other crops use two upright crossed texture planes with no top face. Other plants and fluids use simplified shapes, and animated textures currently show their first frame. The expandable **Top-down map · movement and mining** retains the existing action controls.

`npm run web` and `npm start` build the local browser bundle automatically. After editing `public/map-viewer.mjs`, run `npm run build:web` and refresh the browser; restart the web server for backend changes. If launching `node src/main.cjs` directly, build first.

### Idle storage guardian

After storage maintenance, when no crafting job is waiting, the storage coordinator can
build one iron golem per hub from surplus supplies. It requires four of every shared
iron tool and armor piece, its own armor equipped, a carved pumpkin or jack o’lantern,
and enough iron to leave 64 ingots untouched after making the four iron blocks.
Existing iron blocks count toward the build. A plain pumpkin must be carved first.

The coordinator chooses a clear site outside the warehouse, places the head last, and
confirms the golem entity appeared. Nearby golems suppress construction. Partial builds
are saved for resumption; an uncertain spawn is retained for inspection rather than
spending another set of materials. The completed guardian record prevents repeated
construction at the same hub, including after a restart.
