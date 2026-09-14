# Marc and Jerry web control room

Want to understand the implementation? Start with [the code walkthrough](docs/CODE-GUIDE.md).

Start the web app by double-clicking **Start Web App.command**, or run:

```sh
cd /Users/tiko/Desktop/projs/minecraft
npm run web
```

Open **http://127.0.0.1:4317** in your browser. Keep that Terminal window open while using it.
Open your Java 1.21.1 world to LAN, then click **Connect bot**. Leave the LAN port blank to
read the Agent Test installation’s log, or enter the port shown in Minecraft. The world label
keeps saved places separate: use the same label when reopening the same world and a different
one for a new world. The bot connects locally as WalkBot. Quit the original Terminal bot before
connecting through the app. Refreshing the web page keeps the same bot session.

## Use the map instead of coordinates

The main screen draws a **live 33 × 33 block image** from Minecraft's loaded block data.
It follows the nearest tracked player by default; choose **WalkBot** or a named player in
**Follow** to change focus. If your player is not tracked, it explicitly falls back to WalkBot.
The bot cannot see chunks around a distant player that it has not loaded. In a world with
commands enabled, `/tp WalkBot @s` brings it to you without finding coordinates.

- **Click** a tile to see its block type and height, then **Walk near selection**.
- **Drag** a rectangle, choose **1–4 layers**, and click **Mine selection**. The preview shows
  the exact inclusive volume (maximum 512 positions). Mining starts at the highest displayed
  block in the selection and extends downward by the chosen depth; lower terrain may need
  another pass. The server checks distance, snapshot age, and changed terrain before starting.
- Use **− / +** to look four blocks lower/higher or the middle button to reset. This is a
  cutaway, not a surface satellite image: lower the view to look under trees or cave roofs.
- The image updates about every four seconds. Selecting freezes it; selections expire after
  30 seconds. **Refresh / clear selection** reloads the image. **Save image** downloads a PNG.
- Arrow keys inspect tiles; Enter selects; Shift + arrows extends a rectangle; Escape clears.

Health, hunger, inventory, nearby resources, and observed hostile mobs appear beside the map.
In the commands section, **Talk to your bot** scrolls independently while the message input
stays visible. It follows new replies at the bottom and preserves your position when reading
older messages. **Current inventory** replaces the old destination card, showing item counts,
hotbar positions, and the item currently in hand.
Inventory lists show each item's real Minecraft icon: block items are drawn as small cubes
from the block's own top and side textures, and other items use their inventory sprite. The
textures are read from the Minecraft 1.21.1 client jar that the launcher already downloaded
(`~/Library/Application Support/minecraft/versions/1.21.1/1.21.1.jar`), into ignored
`public/textures/`, the first time `npm run web` starts. Nothing is downloaded. Rebuild the
folder with `npm run textures`, or pass another jar path (or set `MINECRAFT_JAR`) if the game
is installed elsewhere. Without a jar the app runs unchanged and shows lettered tiles instead.
Surveys refresh about every ten seconds, or with **Scan**. Resource totals include hidden loaded
blocks and are capped at 64 per category; finding ore is not proof that it is reachable.

## Monitor activity and debug a stationary bot

The **Bot activity** panel is always visible above the map. It distinguishes **Idle**, **Running**,
**Stopping**, and a disconnected controller, shows the game mode and live-update status, and
explains why Survive is unavailable. Idle + Creative means no survival routine is running;
run `/gamemode survival WalkBot` in Minecraft chat to enable it. You may stay in Creative yourself.
The current LAN settings put WalkBot back into Creative when it reconnects, so recheck the mode
after a controller restart. Opening LAN with Survival as the joining game mode avoids that reset.

The expandable **Live activity log** records commands, chosen tools, paths, action starts and
results, obstacles, and rejected requests. While a task runs, the panel shows the current action,
elapsed seconds, timeout countdown, and last position change. Standing still can be normal
while crafting, digging, or waiting for a server acknowledgment; use the named action to tell.
**Warnings and errors** filters the feed, **Follow new events** controls scrolling, and
**Download log** saves the current log file. Stop all actions cancels active work.

To monitor from a separate Terminal window:

```sh
cd /Users/tiko/Desktop/projs/minecraft
npm run logs
```

This follows `data/logs/activity.log` and keeps following it through rotation/restarts. The
controller also prints activity to its `npm run web` Terminal. File logging begins when this
version starts; older events were not recorded. The file survives restarts and rotates at 2 MB,
keeping the previous file as `activity.log.1`. The browser feed shows the latest 100 events in
the current controller session. `GET /api/logs` returns up to 200 structured events and the
saved file path. If writing the file fails, the app warns and keeps showing in-memory events.

## Survive

Click **Start Survive** or enter `survive`. WalkBot must be in **Survival mode**. If it joined
in Creative, run `/gamemode survival WalkBot` in Minecraft chat (world commands must be enabled).
You can remain in Creative yourself. A normal terrain world offers the trees, stone, food and
water that this routine needs; an empty superflat world does not supply all of them.

The commented planner in `src/survival.cjs` rechecks inventory and terrain as it works:

1. Collect wood, recognizing logs/planks already in inventory.
2. Make planks, sticks, a crafting table and a wooden pickaxe if needed.
3. Collect cobblestone / cobbled deepslate and craft a stone pickaxe. Existing usable better
   tools are retained; Silk Touch tools are avoided when the recipe needs cobble/raw iron.
4. Collect at least three raw iron from reachable exposed ore. **This does not smelt iron.**
5. Gather melons or ripe crops, craft bread when wheat is available, and eat stocked safe foods
   when hungry. It preserves four carrots/potatoes as planting stock and replants harvested crops
   when drops supply seeds. It does not hunt animals or fish in this first version.
6. Gather wheat seeds from grass if needed, craft a hoe, and till/plant **four nearby plots**
   beside existing water. It can also use carrots, potatoes or beetroot seeds. A pre-existing
   irrigated four-crop patch satisfies this step. Crops need time to grow; use **Tend crops** later.

Each step shows running / complete / blocked status and a reason. Missing iron does not prevent
trying food and farming. Re-running plans from the current inventory and world; it does not
reset materials or blindly repeat completed work. It is a **rule-based survival starter**,
not an open-ended language model or a guarantee of staying alive. It uses the installed packages,
with no model API key or additional downloads.

Travel is shared by the map, mining, farming and Survive. WalkBot can swim across surface
water, climb low banks, and build short stairs onto higher shores. It first checks that a
stair would connect a swimming approach to the requested destination. It uses ordinary
blocks already in inventory (dirt, cobblestone, cobbled deepslate, stone, andesite, diorite,
granite or netherrack), with at most **16 blocks placed per route**. Supported stairs reach banks up to five
blocks above the water cell; straight bridges span up to eight missing blocks. Existing routes and
stairs are reused. Watch **Bot activity** for swimming, building, server confirmation,
climbing and arrival. No extra packages are required.

The bot surfaces before route planning, uses stable ground for mining/farming, and explicitly
clears completed or failed routes before changing objectives. If it stops making progress
for about 4.5 seconds, it clears and retries the route (at most twice), then checks another
shore approach. Bot activity shows the current survival objective separately from the
travel action, including why an objective finished or was skipped as blocked.

The routine has a 20-minute budget, at most eight short exploration attempts, and resource
searches within 80 blocks of its starting point. Shore planning checks loaded terrain within
24 blocks; travel allows water entries up to six blocks below and small drops onto land.
It avoids submerged passages, lava and farmland, and does not dig access tunnels.
Resource mining avoids sealed targets, adjacent liquid and falling sand/gravel.
Close hostile mobs, critical health or low air pause the routine for help; it does not fight,
build shelter, or continuously defend the bot. **Stop all actions** cancels it. A server action
already sent may finish; a hung crafting action can require disconnecting to stop late actions.

The full empty-inventory sequence is tested using controlled block/inventory fixtures and
Minecraft 1.21.1 recipes. The live browser map, selection and height controls were also verified.
The complete survival sequence has not yet been run end-to-end in your live world.

Try these commands in the web app:

| Command | Result |
| --- | --- |
| `survive` | Start the six-step survival routine |
| `look around` | Refresh the nearby resource and threat survey |
| `where are you` | Current coordinates |
| `go to -31 38 -26` | Navigate near the destination (adjacent block cells) |
| `find oak logs` | Up to 24 matching blocks within 32 blocks |
| `find stone 64` | Search within a specified radius, at most 64 |
| `save base` | Save the bot’s current coordinates |
| `go to base` | Walk to that saved location |
| `forget base` | Remove a saved location |
| `stop` | Cancel movement immediately |
| `help` | Show supported commands |

The map, search form, saved-place buttons, and Stop button use the same commands.
This version understands the listed command patterns and aliases, not open-ended AI conversation.
No external model or API key is needed. The map is a rendered block image; first-person screenshots are still omitted.

Pathfinding avoids route digging and long falls. It allows non-sprinting one-block gap jumps,
with separate guarded construction for bridges and stairs. Destinations are
limited to 256 blocks away and navigation times out after 60 seconds. Stop cancels further
input; momentum can continue briefly. A death or disconnect cancels active work.

Searches use loaded terrain, including hidden blocks, and are limited to 24 results. Results
record their observation time and can become stale. “Walk near” attempts to reach the listed
coordinates; it does not mine. Use the explicit mining commands or forms when you want WalkBot to break blocks.

The web app listens only on this Mac. Saved places live in ignored `data/waypoints.json` and
are grouped by world label and dimension. The existing Terminal scripts remain available below.

## Mining and farming

The web app now includes **Mine blocks**, **Clear a coordinate area**, and **Tend crops** forms.
The following commands work in the conversation box too:

| Command | Behavior |
| --- | --- |
| `mine stone 16 within 32` | Search loaded terrain within 32 blocks and mine up to 16 stone blocks |
| `mine oak logs 8` | Mine up to eight nearby oak logs, default radius 32 |
| `mine area 10 64 10 to 12 66 12` | Clear the inclusive box between two corners (27 positions here) |
| `farm wheat 16` | Tend wheat on existing farmland within 16 blocks |
| `farm carrots 16` | Harvest ripe carrots and replant carrots |
| `farm potatoes 16` | Harvest ripe potatoes and replant potatoes |
| `farm beetroot 16` | Harvest ripe beetroot and replant beetroot seeds |
| `farm all 16` | Tend all four crops, preserving each harvested crop’s type |
| `stop` | Cancel travel/digging and prevent subsequent work actions |

Area corners can be entered in either order. Each area is limited to **512 positions** and at most 512 removals, with
both corners within 64 blocks of the bot. Work proceeds through reachable targets and retries
blocked targets after the selection opens up. Air is ignored. Unbreakable blocks, liquids,
unloaded positions, and targets that remain inaccessible are reported as unresolved rather
than falsely marked cleared. The bot moves aside before mining its supporting block when a
route exists. It does not dig access tunnels outside your selection; short shoreline steps
may be built as described above.

Type mining defaults to 16 blocks, caps requests at 128, and searches a radius up to 64.
A search snapshots up to 512 matching positions in loaded terrain; it is not an unlimited
exploration task. Mining chooses the fastest available tool that can harvest the target,
including the required tool tier, or uses bare hands when suitable. It checks both the hotbar
and main inventory before each block and equips the winner. Diamond beats otherwise comparable
iron; faster enchantments, the correct tool type, and remaining durability are considered.
Creative mode still selects the appropriate tool instead of tying every item with empty hands.
Give WalkBot tools first;
the individual mining skill does not craft or spawn them. Survive can craft its own starter tools. Nearly broken tools are avoided. Creative mining does not
produce normal Survival drops. Nearby drops are collected when reachable, but the removed-block
count is not a guarantee that every dropped item reached the inventory.

Farming is **one pass**, not a background loop. It checks up to 1,024 nearby farmland positions
(radius up to 32). It only harvests fully grown wheat, carrots, potatoes, and beetroot, reserves
planting stock before harvesting, replants the same crop, and plants empty farmland using the
selected crop. In “all” mode, empty plots use available stock in wheat/carrot/potato/beetroot
order. Young plants and unrelated crops are left alone. No seeds means ripe crops stay intact.
The farm needs existing irrigated farmland, appropriate lighting, and paths beside plots.
The bot avoids routes stepping onto farmland while tending. The individual tending skill does not till soil, place water,
use bone meal, or wait for growth. Drop tools and planting stock near WalkBot for it to pick up;
its inventory appears in the web app. Use wheat seeds, carrots, potatoes, or beetroot seeds.

Both work skills have a five-minute task budget plus bounded individual actions. Stop releases
movement and cancels digging; a placement already sent to the server may still finish. Cancelling
between harvesting and planting can leave that plot empty; run tending again to sow it. Wait for
an in-flight work action to settle before starting another movement/mining/farming task.
The progress panel displays mined/harvested/planted/skipped counts, confirmed item-stack pickups during the task, and reasons for partial work. Counts survive cancellation. If a stalled operation cannot settle after Stop, the app disconnects its old bot session; reconnect to continue.

Implementation: `src/work.cjs` contains the commented work routines and command parser. It uses
Mineflayer, the installed pathfinder, and a direct `vec3` dependency; no model service is needed.
Mining counts require server block-update confirmation, not just client prediction. Tests exercise these routines against controlled block/inventory fixtures. Live harvesting and
area clearing still need testing on a chosen plot with tools and planting stock supplied.

See [REVIEW-NOTES.md](REVIEW-NOTES.md) for the bug fixes and remaining limitations from the full review. Conversation history survives a browser refresh but resets when the control-room server restarts.

## Implementation

- `src/agent.cjs`: session lifecycle, command parsing, pathfinding, search, and saved places.
- `src/server.cjs`: local HTTP API and live updates using server-sent events.
- `src/world.cjs`: block snapshots, player focus, resource surveys and validated map actions.
- `src/survival.cjs`: inspect/plan/act loop, crafting, food and starter farms.
- `public/world.js`: canvas map, click/drag selection and survival progress.
- `test/survival.test.cjs`, `test/world.test.cjs`: recipe progression, blocked steps, cancellation, farm and map action checks.
- `public/`: browser interface. No browser framework or build step is required.
- `test/web.test.cjs`: command limits, persistence, cancellation, failed routes, origin checks,
  and disconnecting during an unfinished connection attempt.

Run `npm run check` and `npm test`. Installed additions: `mineflayer-pathfinder@2.4.5`,
`express@5.2.1`, and a direct `minecraft-protocol@1.68.0` dependency. Browser-native EventSource
provides updates, so no additional WebSocket package is needed. npm still reports the same six
moderate dependency audit entries noted below; no forced incompatible downgrade was applied.

## Original Terminal demo

### Setup notes

The bot and dependencies are installed in `/Users/tiko/Desktop/projs/minecraft`.
Node 22.23.1 was already installed and satisfies Mineflayer 4.39.0's Node >=22 requirement.
Minecraft 1.21.1 is already downloaded. An **Agent Test** installation was added to the
launcher profile file, using `/Users/tiko/minecraft-agent-worlds` for isolated game data.
The original launcher profiles were backed up next to `launcher_profiles.json` with a
`launcher_profiles.before-agent-test-` filename prefix.

## Your next steps

1. Open Minecraft Launcher. Select **Java Edition → Agent Test → Play**. If it is absent,
   fully quit and reopen the launcher. You can also create an installation named Agent Test,
   select release **1.21.1**, and set Game Directory to `/Users/tiko/minecraft-agent-worlds`.
2. Create a new singleplayer world named **Agent Playground**: **Creative**, **Peaceful**,
   **Allow Commands ON**, and **Superflat** world type.
3. Press **Esc → Open to LAN**, choose **Creative** for joining players, and start the LAN world.
4. Keep the world open. Double-click **Start Bot.command** in this project folder, or run:

   ```sh
   cd /Users/tiko/Desktop/projs/minecraft
   npm start
   ```

   The script finds the LAN port in the isolated game's log, checks the Minecraft protocol,
   writes `config.json`, and starts WalkBot. If detection fails, supply the port shown in game:

   ```sh
   npm start -- 53124
   ```

   Replace 53124 with the actual port. `npm start` is exclusively for the local demo.

5. Wait for **Ready!** in Terminal. Enter `pos`, then `w`, wait a second, and enter `pos`
   again. Coordinates should change. Try `wander`, then `stop`.
6. In Minecraft chat, run `/tp @s WalkBot` to find the bot. Walk back a few steps to watch it.

Terminal commands: `w`, `s`, `a`, `d`, `j`, `left`, `right`, `pos`, `wander`, `stop`, `help`, `quit`.
Press Return after each. `quit` or Control-C disconnects. Restart with `npm start` after reopening
the world to LAN. Wandering is random; it does not navigate around obstacles or use an AI model.

## Validation and remaining work

Run `npm run check` for syntax checks and `npm test` for simulated movement lifecycle tests.
Tests cover spawn gating, movement timeout, stopping during a pending turn, death, respawn,
and quit. These simulations do not verify a live Minecraft connection.

The initial setup could not be tested live because computer control timed out. Since then,
the web version has connected to the running world and exercised movement, nearby search,
and stopping through its API. The new browser map and selection controls have been visually tested.

`npm audit` reported six moderate entries in the dependency tree, stemming from a transitive
uuid advisory. The pinned tutorial dependency was retained; the suggested force fix would
downgrade Mineflayer to an incompatible old release.

## Optional online server

After the local demo works, get the server address, port, supported version, and permission
to use a bot. Configure `config.json` with `host`, `port`, your account email as `username`,
`auth: "microsoft"`, and `version: false`, then run `node bot.cjs`. Complete Microsoft device
sign-in when prompted. The account must own Java Edition. Disconnect your regular client
first if using the same account. Never put a password in the configuration.

`.auth/` and `config.json` are ignored by Git. Do not share the authentication cache.
The web controller includes pathfinding and the survival starter. The original Terminal movement demo remains independent.

Protocol reference: [PrismarineJS API](https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/docs/API.md).

Crafting/eating API reference: [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md). Implementation also checks the installed pinned package source.

### Continuous wheat farm

Click **Start FARMER**, or send `farm wheat forever`. Stop any current task first. In Survival mode, WalkBot repeatedly harvests mature wheat, immediately replants, collects seeds, makes a hoe, and expands irrigated plots. It adds dirt beside existing water while preserving water rows and walking lanes. It crafts chests from gathered wood and deposits surplus wheat and seeds, keeping 12 wheat for food and 32 seeds for expansion. Existing nearby chests may also be used; it never withdraws their contents.

The routine checks again every 20 seconds and runs until Stop, disconnection, a dangerous condition, or a timed-out action. The Wheat farm card reports nearby plants observed (up to 1,024), wheat stored during this run, and storage chests; Bot activity shows actions, failures, and the next crop check. Expansion is limited to loaded reachable terrain within 80 blocks of where the routine started, with 16 new plantings and up to 12 new dirt blocks per pass. Crops need normal Minecraft growth conditions and loaded chunks. This is a rule-based farming routine, not an unlimited world-wide farm planner. No additional packages are required.

### OpenAI chat and wheat progress

Set `OPENAI_API_KEY` in the controller environment or the ignored root `.env` file, then run `npm run web`. All bots share this server-side key. New bots have messaging enabled by default; the **LLM chat** card only enables or disables replies for the selected bot. Per-bot `llm.json` files store that preference, never credentials or model selection. Restart the controller after changing the environment. API usage is billed through your API account.

Say `WalkBot, what are you doing?` in Minecraft chat or whisper to WalkBot. Each request includes current task, inventory, farm/survival progress, and nearby observations, plus a short conversation history. Uses the [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) with `store:false`, a 20-second timeout, a single pending request, and a 10-request/minute limit. Replies are informational: chat has no command execution or movement tools. Messages not addressing WalkBot are ignored. Errors and configuration state appear in the chat card.

Survive now expands production between wheat harvest checks instead of wandering to look for ripe crops. It waits 20 seconds between passes and retains its 20-minute overall limit. For ongoing production and chest storage, use **Start FARMER**. That skill prioritizes planting before early chest construction, clears ordinary grass above plots, and displays expansion blockers instead of only saying it is waiting.

### FARMER

Click **Start FARMER**, or send `farmer` / `start farmer`. This is the dedicated continuous wheat-production skill, with no wheat quota or overall time limit. It harvests mature crops, replants, adds up to 16 plots per pass, builds up to 12 connected dirt ground blocks per expansion pass, and crafts/deposits surplus into chests. Existing aliases such as `farm wheat forever` still work.

Productive passes continue after one second; idle passes retry after 20 seconds. Each individual action remains timed and cancellable. Candidate filtering happens before the scan result cap, so underground dirt cannot crowd out usable surface plots. Ground extension can attach to farmland, connect across dirt walking lanes, and preserves water needed by existing crops. FARMER works within loaded, reachable terrain up to 80 blocks from its starting point; it does not guarantee an unlimited or mathematically optimal farm. The card reports new plantings, ground added, nearby plants, stored wheat, and missing resources.

### Movement and pickup recovery

Underwater escape steers on physics ticks, swims sideways under roofs without continuously pressing upward, then surfaces with a small height margin before each new route search. Travel keeps the bot afloat when finishing in water. Pickup follows actual item positions, permits careful walking over farmland while excluding jumping onto it, waits up to 800 ms for server collection, and restores normal movement rules afterward. Deep drops are left to float upward instead of being chased into submerged tunnels. FARMER now counts confirmed playerCollect events.

Terrain regression fixtures cover four- and five-block banks, a four-block bridge, a one-block gap jump, underwater overhang escape, and delayed collection on farmland. Construction still requires enough ordinary blocks in inventory and a supported, loaded route.

### Progress summaries in Minecraft chat

OpenAI posts one brief `[Update]` every 30 seconds while connected and LLM chat is enabled/configured. The prompt compares current task, inventory, confirmed counters, recent useful INFO events, and blockers against the last successful summary. Unchanged work gets a short “Still working on …” message. No per-action INFO forwarding remains. Existing mentions and whispers still receive direct replies. Requests share the existing timeout/rate limit; a busy request skips that summary interval rather than queueing old updates. Disconnect or a changed task invalidates stale summaries.

### Skill selector and low-air recovery

The **AUTONOMOUS STARTER ROUTINE** card now has a Skill selector for **Survive** and **FARMER**, with the matching description and Start button. FARMER's separate card continues to show production totals.

Oxygen readings now come only from WalkBot's own entity metadata, correcting Mineflayer's updates from other entities. FARMER requests recovery below 12/20 air while in water: it retires navigation/digging, lets the action settle, surfaces, waits for at least 18/20 air, then resumes farming. Growth waits also check for low air. Stop cancels recovery. Unsuccessful escape or other critical dangers can still pause the skill.

### Get torches and automatic lighting

Send `get torches` or select **Get torches** in the skill card to gather/craft 16 torches. It uses existing torch stock first, crafts from coal or charcoal plus sticks, gathers exposed coal if needed, and can build/use an empty furnace to make charcoal from logs and plank fuel. Occupied furnaces are left alone.

FARMER prioritizes stocking eight torches when it has fewer than four, then places up to four torches per pass on clear solid ground near crops and work areas. Existing lights prevent closely repeated placements; crops and water are preserved. If materials or a route are unavailable, it reports the blocker and waits five minutes before trying to obtain more, allowing farm work to continue. No additional packages are needed.

### Two bots and continuous tree farming

The control room now runs **Marc** and **Jerry** as independent Minecraft sessions.
The two cards show both bots' status and provide Connect, Start, Stop and Manage controls.
**Manage** selects that bot's map, inventory, conversation, logs and other commands.
**Stop both bots** cancels both tasks. Each bot has its own connection and can disconnect
without stopping the other. Jerry's saved settings and logs live in `data/treebot/`.

Connect both using the same LAN settings. Start wheat farming on Marc and **Start tree
farmer** on Jerry, or select Jerry and send `farm trees`. Both require Survival mode.
Jerry searches loaded terrain within 48 blocks (and 80 blocks of its starting position).
It supports oak, birch, spruce, jungle, acacia, dark oak and cherry trees rooted in ordinary
planting soil with a natural leaf canopy. It captures connected logs, including diagonal
branches, before cutting. Connected clusters are limited to 256 logs, 40 blocks vertically,
and 12 blocks horizontally from the discovered root; oversized/unloaded trees are refused.
Mangroves and Nether fungi are not supported yet.

Jerry collects matching saplings from drops/leaves and reserves enough to replant every
trunk base before cutting. It gathers exposed dirt away from planting soil and nearby
farmland, prioritizing a reserve of 32 dirt between trees. It mines from the base upward,
then jump-places dirt in the cleared trunk to reach higher logs. Branches can use supported
stairs when necessary. Temporary supports are recorded in the saved job and recovered in
reverse order before replanting; descending through a column requires solid ground exactly
one block below each removed support. Routes may clear natural leaves but cannot mine
unrelated terrain. Jerry’s status card shows its carried dirt against the reserve target.
It harvests the connected logs, returns to the planting sites, and verifies matching sapling
placements; dark oak requires its 2 × 2 footprint. Leaves may decay naturally afterward.

A tree counts as complete only when all captured logs are gone and its roots replanted.
Unfinished trees are retained across Stop/restart in `tree-jobs.json`, scoped by world label
and dimension. Missing saplings, a full inventory, or an inaccessible branch are reported;
the bot retries temporary obstructions after 1.5 seconds and checks for new trees every
10 seconds. Three unchanged failures pause the saved job for attention. Empty its inventory
when full; this skill does not automatically store logs in chests. Navigation/action timeouts
and dangerous conditions pause work. Reuse the world label only for the same world.

Validation covers whole-tree discovery and harvesting, diagonal branches, partial retries,
planting reserves, cancellation, stair movement configuration, and isolated multi-bot APIs.
Live connection and UI switching were checked with both bots; a complete live tall-tree
harvest still needs suitable nearby terrain and planting stock.

### Clear bot controls and canopy recovery

A sticky **Controlling Marc / Controlling Jerry** bar identifies the active bot throughout
the page. Start, Stop, Connect, map actions, commands and settings name their target. The
selection survives refresh. Switching clears the map selection and command draft and disables
stale controls while the selected session loads. The map follows the selected bot by default;
its label states both the viewed entity and the bot receiving commands. Jerry hides the
unrelated wheat-production card, and activity logs are collapsed initially.

Jerry checks reach from its actual eye position, fixing a case where the cell-center ray
was blocked by leaves despite a clear real view. For taller canopies, it builds and confirms
one supported step at a time, then replans using those actual blocks. This avoids the
pathfinder's inability to model all previous hypothetical staircase supports. It steps back
before replanting when standing in the sapling's placement space. Three attempts with no
harvest/replant progress pause the task with its unfinished tree saved instead of repeating
an identical failure forever. Restart tree farming after resolving the reported blocker.

Regression tests include captured terrain from both birch trees: the offset standing position
and a real movement/physics simulation that places six support blocks to reach the upper log.

The two saved birch-tree jobs were also verified live: all captured logs were removed and
matching saplings were confirmed before the jobs were cleared. Canopy work now releases
movement and waits for a stable landing before clearing leaves or placing the next support.

### Shared Storage and Crafting (Supabase)

The new skill shares inspected chest contents and durable crafting jobs across bots through
Supabase Postgres. It provides explicit chest enrollment, category organization, surplus deposits,
working-stock reserves, ingredient reservations and verified crafting. Marc uses shared farm
storage when configured; the tree farmer can unload into enrolled wood/overflow chests.

Read [setup, commands and recovery](docs/STORAGE-SETUP.md) and the
[revised implementation plan](docs/STORAGE-AND-CRAFTING-PLAN.md). Configure the intended Supabase
project before using shared storage. Existing standalone skills still work without configuration.
The first version is bounded to local reachable storage and does not yet implement fleet-wide
resource claims, automatic warehouse layout or general world exploration.

### Practice movement

Select either bot, choose **Practice movement — follow sponge**, and press Start,
or send `practice-movement` (`practice movement` also works). The continuous skill
scans loaded terrain within 64 blocks for the nearest sponge or wet sponge, then
moves beside or onto it using the usual movement system. It leaves the marker in
place, watches for changed targets, and waits when no sponge is nearby. Move or
remove the current sponge to direct the next trip. **Stop** cancels the selected
bot’s skill. Like the other continuous skills, it currently starts in Survival mode.

### Sam: dedicated Storage and Crafting bot

Sam is the fourth independent bot, alongside Marc, Jerry and Barneett. Choose **Control Sam**
to connect him and start his default **Storage and Crafting** skill. He uses the same Supabase
world registry, managed chests and crafting queue as the other bots, with separate local data
and logs in `data/sam/`. Use the same world label when connecting the fleet.

Long walks use weighted A* (2× the destination heuristic once the remaining
heuristic distance is at least 24 blocks). This favors a usable route over the
shortest possible route without changing allowed movement or hazard checks.
When a search times out with a useful route, the bot walks that existing segment
before planning the next section, avoiding a duplicate search to its endpoint.

Walking can open hand-operated doors (wooden and copper) and fence gates, waiting
for server confirmation before crossing. It leaves already-open passages open;
closed iron doors require an external redstone mechanism. Navigation treats fence
and wall tops at their actual collision height: no ground-level fence jumps, but
walking along the top is supported from a raised approach with enough headroom.
Doors, gates, fences and walls are protected from automatic pathfinding digging.

### Start and switch skills from chat

In Minecraft chat, address the bot by name, or whisper the command directly:

- `Marc, start farmer`
- `Jerry, switch to practice movement`
- `Sam, start storage and crafting`
- `Jerry, turn on` — start the last skill requested this controller session, or his default tree farmer skill.
- `Jerry, stop` — cancel the running skill and any pending switch.
- `Marc, skills` — list available skills.

These commands also work in the web conversation. Without a name, web commands target
the selected bot; whispers target their recipient. Available skills are Survive, FARMER,
Tree farmer, Get torches, Storage and Crafting, and Practice movement. `start <skill>`,
`switch to <skill>`, and the existing bare skill commands start or switch skills. A switch
cancels current work and waits for its active action to settle before starting the replacement.
A newer switch replaces any pending one. Each bot stays independent.

Skill commands work with LLM chat disabled and require no API key. The bot must already be
connected and in Survival mode; `turn on` starts its skill, not its Minecraft connection.
Bare `start` / `turn on` defaults to FARMER for Marc, Tree farmer for Jerry, Practice movement
for Barneett, and Storage and Crafting for Sam. Ordinary conversation still uses the optional
LLM configuration. Public commands must begin with the bot's name; other bots' messages
cannot trigger skill controls.

### Exchange: gifts and two-way trades

Choose **Exchange** in the skill selector or send `Marc, exchange`. Marc checks nearby
idle fleet bots and chooses a useful transfer from their actual inventories. Both sides
agree using deterministic supply and reserve rules, then meet and verify the handoffs.
If both have surplus the other needs, they trade; if only one does, that bot gives a gift.
Automatic sharing considers role supplies, dirt, bread, torches, logs and saplings, keeps
shared working reserves, and leaves carried tools and modified items alone. No API key
or Supabase configuration is required.

To select a partner or exact items, use Minecraft chat, whispers, or the web conversation:

| Command | Result |
| --- | --- |
| `Marc, exchange with Jerry` | Decide a useful gift or trade with Jerry |
| `Marc, give Jerry 16 dirt` | Give Jerry exactly 16 dirt |
| `Marc, give 16 dirt to Jerry` | The same one-way gift |
| `Marc, trade Jerry 16 wheat for 8 oak_log` | Give 16 wheat, then receive 8 oak logs |
| `Marc, stop` or `Jerry, stop` | Cancel both sides of the meeting |

Use Minecraft item IDs with underscores. Explicit transfers may spend working reserves;
quantities are limited to 1–64 per direction. Damaged, enchanted, named or mixed-metadata
stock is refused to avoid tossing the wrong item. Both bots must be connected to the same
server/world/dimension, see one another within 32 blocks, and be in Survival mode. Start
Exchange on **one bot**; it reserves its idle partner for the meeting. A busy partner is
left alone—stop that bot’s current skill first. This is one finite meeting, not a background
loop, and it does not resume the bots’ previous production skills afterward.

The bots use existing walking routes to meet on dry ground, without building a route or
mining terrain. Inventory space and both sides’ stock are checked again before the first
handoff. Bot activity shows the partner, current action, confirmed given/received counts
and blockers. Matching new item collection events plus inventory changes confirm delivery.

Minecraft transfers happen by dropping and collecting items, so a two-way trade is not
atomic. If a pickup is uncertain or either bot stops, the remaining handoff is cancelled
and the result reports partial work. Already delivered items stay with the recipient;
items already tossed may remain on the ground or reach another player. Check the inventories
and meeting spot before retrying; the skill never automatically repeats an uncertain toss.

Regression fixtures cover planning, reserves, gifts, reciprocal trades, capacity and metadata
checks, partner isolation, confirmed pickups, cancellation, and disconnection. A live-world
handoff still needs validation after loading the updated controller.

### Nine bots, one fleet list, and five new production skills

The fleet is now a single list in `src/fleet.cjs`: id, Minecraft username, data directory,
default skill and profession. The server creates one independent `Agent` per entry, the
browser builds the **Control …** tabs and the skill selector from `/api/fleet` and
`/api/skills`, and Sam learns each newcomer's profession from the same list. Adding a bot is
one line; adding a skill is one registry entry in `src/skills.cjs` plus its module.

| Bot | Default skill | Command |
| --- | --- | --- |
| Marc | FARMER (wheat) | `farmer` |
| Jerry | Tree farmer | `farm trees` |
| Barneett | Practice movement | `practice-movement` |
| Sam | Storage and Crafting | `storage and crafting` |
| Orin | Ore finder | `find ores`, `find ores iron within 48` |
| Cane | Sugarcane farmer | `farm sugarcane` |
| Knight | Mob killer | `hunt mobs`, `hunt mobs within 16` |
| Terra | Terraformer | `terraform`, `flatten x1 z1 to x2 z2 at y` |
| Forge | Smelter | `smelt`, `smelt raw_iron 16` |

Every new skill deposits surplus and fetches its tools through the shared storage helpers in
`src/storage.cjs`, declares its working stock with `this.reserves`, and calls
`agent.coordination.returnSupplies()` at a safe checkpoint so Sam's five-minute return
policy applies. Each skill has its own guide under `docs/skills/`.

To try one bot's skill live without touching the running control room:

```sh
node --env-file-if-exists=.env scripts/live-skill.cjs --bot orin --command "find ores" --seconds 180
```

`--pre "/give @s stone_pickaxe"` sends chat lines first; the harness prints the bot's
activity log, position, inventory and a final JSON summary, then stops and disconnects.
