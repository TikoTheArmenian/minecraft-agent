# How the bot fleet works

Start with this guide, then read the file headers and the comments above the main functions. The website is a remote control and status display. The server runs the bots even when the page is closed.

The implemented architecture and operator controls are documented in [AGENT-RUNTIME.md](AGENT-RUNTIME.md).

## Source layout

`src/main.cjs` is the single startup entry point used by `npm run web`. Implementations live in folders named for their responsibility:

```text
src/
  main.cjs       # Compose services, start the fleet/web server, and shut down
  agents/        # Player profiles, per-player state, and fleet composition
  skills/        # Registry and the 12 executable Minecraft workflows
  runtime/       # Commands, contracts, one-owner execution, Work, and recovery
  capabilities/  # Reusable resource progression, farm layout, and supplies
  navigation/    # Routing, reach/visibility goals, passages, and work order
  minecraft/     # Connection, packets, placement compatibility, tools, safety
  storage/       # Shared storage, crafting, farm chests, and warehouse layout
  world/         # Loaded-world observations, maps, and saved waypoints
  messaging/     # Human/peer chat, whispers, inboxes, and storage coordination
  supervisor/    # Per-bot LLM decisions, provider transport, and inference limits
  infra/         # Versioned JSON, activity logs, API costs, and pricing
  web/           # Express application and HTTP route adapters
```

Add a new workflow in `skills/` and register it in `skills/registry.cjs` with its contract in `runtime/skill-contracts.cjs`. Put reusable physical helpers in the relevant capability, navigation, Minecraft, or storage folder. Shared capabilities must not import runnable skills or application entry points; supervisors select work through the runtime. `npm run architecture` checks these boundaries, resolves relative imports, and prevents loose implementation files at the root of `src`.

Import the owning module directly. There are no forwarding files at the former flat paths. Saved jobs, authentication, logs, cost ledgers, public assets, bot IDs, and public API URLs retain their existing locations and identities. `npm run format` and `npm run lint` cover every source folder.

## Follow one command

For example, pressing **FARMER** follows this chain:

1. `public/world.js` sends a command to the selected bot's local API.
2. `src/web/server.cjs` routes that request to the selected profile’s `Agent`.
3. `src/agents/agent.cjs` translates the command; `src/runtime/skill-runner.cjs` validates it, records its run identity, acquires the physical lock, and creates `WheatFarm`.
4. `src/skills/wheat-farm.cjs` repeatedly runs a farm cycle: check safety and supplies, harvest, expand, and store surplus.
5. Shared actions in `src/runtime/work.cjs` equip tools, dig blocks, plant seeds, and collect drops.
6. When an action needs a different position, `src/navigation/travel.cjs` finds and executes a route.
7. The agent publishes updated state. The browser redraws progress, inventory, the map, and logs.

Minecraft confirms the results. Finishing a local animation does not, by itself, prove that a block was removed or an item was transferred.

## Which files should I read?

| You want to understand… | Read… |
| --- | --- |
| Starting the website and every bot in the fleet | `src/main.cjs`, `src/agents/fleet.cjs`; HTTP app in `src/web/server.cjs` |
| Which skills exist, their aliases, labels and dashboard text | `src/skills/registry.cjs` (the browser selector reads `/api/skills`) |
| Trying one bot's skill live without the control room | `scripts/live-skill.cjs` |
| Connecting, commands, starting skills, and Stop | `src/agents/agent.cjs` |
| The continuous wheat farm | `src/skills/wheat-farm.cjs`, starting at `cycle()` and `run()` |
| Farm height, protected ground, and irrigation | `src/capabilities/farm-layout.cjs`; `hydrated()` in `src/capabilities/resources.cjs`; shared expansion in `src/capabilities/crop-expansion.cjs` |
| Seeds and building blocks in chests | `src/storage/farm-storage.cjs` |
| Shared resource progression and the starter workflow | `src/capabilities/resources.cjs`; the runnable plan in `src/skills/survival.cjs` |
| Cutting and replanting trees | `src/skills/tree-farm.cjs` |
| Torch crafting and placement | `src/skills/torches.cjs` |
| Moving, swimming, bridges, and stairs | `src/navigation/travel.cjs`, starting at `go()` |
| Describing a ramp to a floating island | `src/navigation/island-routes.cjs` |
| Choosing the best tool and performing physical work | `src/runtime/work.cjs` |
| Reach, visibility, and item pickup destinations | `src/navigation/block-approach.cjs`, `src/navigation/pickup-goal.cjs` |
| Minecraft's confirmation packets | `src/minecraft/block-updates.cjs` |
| Informational chat replies | `src/messaging/llm-chat.cjs` |
| Choosing skills with an LLM | `src/supervisor/supervisor.cjs`, `decision-schema.cjs`, and `inference-scheduler.cjs` |
| Run admission, results, Stop and cooperative switching | `src/runtime/skill-runner.cjs`, `command-service.cjs`, `skill-contracts.cjs` |
| Peer identity, inboxes, public chat and whispers | `src/messaging/` |
| Atomic checkpoints and Mineflayer placement compatibility | `src/infra/json-store.cjs`, `src/minecraft/actions.cjs` |
| Collecting terrain data for the map | `src/world/observations.cjs` |
| Drawing the map and handling its controls | `public/world.js` |
| Selecting a bot and receiving browser updates | `public/app.js` |
| Showing the activity log | `public/activity.js` |

`bot.cjs` and `start.cjs` are the older Terminal bot entry points. The web app starts through `src/main.cjs`. Dependencies under `node_modules/` are third-party libraries; you generally do not edit them.

## Names you will see repeatedly

- **`bot`**: Mineflayer's live Minecraft player: position, inventory, loaded blocks, and actions.
- **`agent`**: our coordinator for that player. It owns the connection, task, logs, and dashboard state.
- **`work`**: the task currently allowed to move and act. `ResourceWork` extends `Work`; resource-based skills inherit the neutral capability base. No skill inherits the runnable `Survival` workflow.
- **`state`**: data sent to the browser. It is a snapshot, not the Minecraft world itself.
- **`plan`**: a skill's progress and current decision, such as its farm layout or current tree job.
- **`counts`**: progress counters. Their meaning depends on the action; for example, blocks mined and item stacks collected are different measurements.
- **`goal`**: a rule defining an acceptable destination. To mine a log, a bot needs to reach a place where he can see and touch it, not stand inside it.
- **`overlay`**: imaginary blocks used while checking a proposed construction route. Nothing has been built until execution places and confirms those blocks.
- **`predicate`**: a function returning true or false, used to filter candidates or check whether a block is still suitable.
- **`cooldown`**: a short period during which an unsuccessful target is skipped instead of tried repeatedly.

## Coordinates and vectors

Minecraft uses `x` and `z` for horizontal position and `y` for height. A `Vec3` groups those three numbers.

```js
const soil = crop.position.offset(0, -1, 0) // The block immediately below the crop.
const cell = bot.entity.position.floored() // Convert a precise player position to a block cell.
```

`offset()` returns a shifted position. `distanceTo()` measures distance. `floored()` rounds each coordinate down, including negative coordinates. Player positions can have decimals, so being near a block is different from standing in its cell.

## Waiting, cancellation, and errors

`async` functions can wait for Minecraft. `await` means “continue after this operation finishes.” It does not automatically move expensive calculations off the main JavaScript thread. Navigation explicitly yields between search slices so physics, network updates, and Stop can still run.

Each task has an `AbortController`, which is its cancellation signal. `check()` is called throughout loops to notice cancellation or expired time limits. `timed()` wraps operations so a missing response cannot wait forever.

The agent also tracks connection and task identifiers (`epoch`, `spawnGeneration`, and `nav`). These prevent a delayed callback from an old task affecting a newly connected bot. `finally` blocks release windows, listeners, and movement controls even when an operation fails.

Some errors are recoverable: the farm can skip a blocked plot and continue. Serious errors end or pause the task. Low air has a dedicated recovery path in FARMER so it can surface before resuming work.

## How the dense wheat field works

The farm picks a ground level and looks for clear, hydrated soil at that level. There is no longer a modulo-based 2×2 planting pattern: former walking gaps can become crops too. Work is bounded per pass, so a whole field fills over successive passes as seeds and routes allow.

Ground construction preserves required irrigation and reserves access blocks. The bot can walk through farmland, but movement avoids intentionally jumping or dropping onto it. Storage retains planting and food supplies; when carried seeds run low, Marc checks chests before gathering more grass. Chest contents are remembered observations, so withdrawals always recheck the actual chest.

## What the LLM does

The OpenAI model receives observations and answers direct mentions or whispers. It does not directly operate the movement or farming code. Automatic 30-second summaries are disabled. The older `ActionChat` class is retained in `src/messaging/action-chat.cjs`, but the agent does not use it to announce every action.

## Debugging a problem

Start with **Bot activity** on the website. Check the skill's decision, current action, latest error, and time since the position changed. Those distinguish “waiting for growth” from “trying to reach a block.”

### Travel telemetry

Each `Travel` instance publishes its diagnostics on `agent.state.task.travel`:

| Field | Contents |
| --- | --- |
| `route.path` | The latest `path_update` path as detached `{x, y, z}` coordinates; an empty result has an empty path. Walking, resets, and cleanup do not consume or erase this snapshot. |
| `route.search` | Search details associated with that path: `status`, `searchRadius`, `visitedNodes`, `generatedNodes`, `cost`, `time` (milliseconds), `updatedAt`, and `source: 'walking'`. Missing metrics are `null`; a radius of `-1` means unlimited. |
| `route.partialEndpoint` | The current timeout segment's selected endpoint, available before the bot reaches it. A new path result clears it until another endpoint is selected. |
| `route.segments` | Up to 128 selected partial segments in order, each with `endpoint`, `plannedAt`, and `reachedAt` (`null` until reached). This preserves the chain through subsequent searches. |
| `search` | The latest search details, with `source: 'walking'` or `'preview'`. Construction and pickup previews report their actual radius (64 or 12) without replacing `route`. |
| `events` | The latest 128 structured stall/retry events: `type`, `reason`, `at`, `position`, `phase`, `destination`, and relevant attempt, idle duration, or segment details. These also appear in activity-log `details`, with `taskId`. |

Timestamps use epoch milliseconds. Search slices update state immediately; partial-result broadcasts are limited to once per second. Terminal search results and segment changes publish immediately. The final snapshot remains available after success, failure, or cancellation until another `Travel` instance replaces it. These fields support viewers and captured-state replay; they do not retain complete route history across separate trips.

From a Terminal in this project:

```sh
npm run logs    # Follow the saved activity log.
npm run check   # Check JavaScript syntax.
npm test        # Run the automated tests.
```

Tests under `test/` describe expected behavior. Movement tests include simulated Minecraft physics and captured island terrain. They help prevent regressions, but a successful test does not prove that every new island or obstruction is traversable.
