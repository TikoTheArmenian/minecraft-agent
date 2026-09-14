# How Marc and Jerry work

Start with this guide, then read the file headers and the comments above the main functions. The website is a remote control and status display. The server runs the bots even when the page is closed.

## Follow one command

For example, pressing **FARMER** follows this chain:

1. `public/world.js` sends a command to the selected bot's local API.
2. `src/server.cjs` routes that request to the appropriate `Agent` (Marc or Jerry).
3. `src/agent.cjs` parses the command and creates a `WheatFarm` task.
4. `src/wheat-farm.cjs` repeatedly runs a farm cycle: check safety and supplies, harvest, expand, and store surplus.
5. Shared actions in `src/work.cjs` equip tools, dig blocks, plant seeds, and collect drops.
6. When an action needs a different position, `src/travel.cjs` finds and executes a route.
7. The agent publishes updated state. The browser redraws progress, inventory, the map, and logs.

Minecraft confirms the results. Finishing a local animation does not, by itself, prove that a block was removed or an item was transferred.

## Which files should I read?

| You want to understand… | Read… |
| --- | --- |
| Starting the website and every bot in the fleet | `src/server.cjs`, bot list in `src/fleet.cjs` |
| Which skills exist, their aliases, labels and dashboard text | `src/skills.cjs` (the browser selector reads `/api/skills`) |
| Trying one bot's skill live without the control room | `scripts/live-skill.cjs` |
| Connecting, commands, starting skills, and Stop | `src/agent.cjs` |
| The continuous wheat farm | `src/wheat-farm.cjs`, starting at `cycle()` and `run()` |
| Farm height, protected ground, and irrigation | `src/farm-layout.cjs`; `hydrated()` in `src/survival.cjs`; `irrigationRemains()` in `src/wheat-farm.cjs` |
| Seeds and building blocks in chests | `src/farm-storage.cjs` |
| Getting wood, crafting tools, food, and the starter farm | `src/survival.cjs` |
| Cutting and replanting trees | `src/tree-farm.cjs` |
| Torch crafting and placement | `src/torches.cjs` |
| Moving, swimming, bridges, and stairs | `src/travel.cjs`, starting at `go()` |
| Describing a ramp to a floating island | `src/island-routes.cjs` |
| Choosing the best tool and performing physical work | `src/work.cjs` |
| Reach, visibility, and item pickup destinations | `src/block-approach.cjs`, `src/pickup-goal.cjs` |
| Minecraft's confirmation packets | `src/block-updates.cjs` |
| Chat replies from OpenAI | `src/llm-chat.cjs` |
| Collecting terrain data for the map | `src/world.cjs` |
| Drawing the map and handling its controls | `public/world.js` |
| Selecting a bot and receiving browser updates | `public/app.js` |
| Showing the activity log | `public/activity.js` |

`bot.cjs` and `start.cjs` are the older Terminal bot entry points. The web app starts through `src/server.cjs`. Dependencies under `node_modules/` are third-party libraries; you generally do not edit them.

## Names you will see repeatedly

- **`bot`**: Mineflayer's live Minecraft player: position, inventory, loaded blocks, and actions.
- **`agent`**: our coordinator for that player. It owns the connection, task, logs, and dashboard state.
- **`work`**: the task currently allowed to move and act. `Survival` extends `Work`; other skills reuse its helpers.
- **`state`**: data sent to the browser. It is a snapshot, not the Minecraft world itself.
- **`plan`**: a skill's progress and current decision, such as its farm layout or current tree job.
- **`counts`**: progress counters. Their meaning depends on the action; for example, blocks mined and item stacks collected are different measurements.
- **`goal`**: a rule defining an acceptable destination. To mine a log, Marc needs to reach a place where he can see and touch it, not stand inside it.
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

The OpenAI model receives observations and answers direct mentions or whispers. It does not directly operate the movement or farming code. Automatic 30-second summaries are disabled. The older `ActionChat` class is retained in `src/action-chat.cjs`, but the agent does not use it to announce every action.

## Debugging a problem

Start with **Bot activity** on the website. Check the skill's decision, current action, latest error, and time since the position changed. Those distinguish “waiting for growth” from “trying to reach a block.”

From a Terminal in this project:

```sh
npm run logs    # Follow the saved activity log.
npm run check   # Check JavaScript syntax.
npm test        # Run the automated tests.
```

Tests under `test/` describe expected behavior. Movement tests include simulated Minecraft physics and captured island terrain. They help prevent regressions, but a successful test does not prove that every new island or obstruction is traversable.
