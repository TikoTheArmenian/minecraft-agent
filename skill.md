---
name: minecraft-skill-builder
description: Build or improve Minecraft bot skills in this Mineflayer control-room repository, including resource gathering, farming, combat, terrain work, construction, and processing. Use when implementing bot behavior, its dashboard controls, or regression tests.
---

# Building Minecraft bot skills

This guide is for an agent working in this repository. A **bot skill** is executable JavaScript that controls a Minecraft player; this Markdown file teaches you how to build one. Read the current implementation before editing: helpers and fleet configuration evolve. Paths below are relative to the repository root containing `package.json` and `src/agent.cjs`.

Implement the skill the user requested, including its controls and observable results. The examples below are design guidance, not requests to implement all of them. Respect newer user decisions. Do not turn an example batch size or an old workaround into a universal constraint.

## Find the right integration points

| Concern | Existing implementation to inspect |
| --- | --- |
| Skill names, command aliases, factories, API metadata | `src/skills.cjs` |
| One active task per bot, connection lifecycle, task state, command validation | `src/agent.cjs` |
| Shared cancellable actions, tool selection, digging, planting, item pickup | `src/work.cjs` |
| Gathering, crafting, food, crop preparation | `src/survival.cjs` |
| Continuous production and safety recovery | `src/wheat-farm.cjs`, `src/tree-farm.cjs` |
| Choosing nearby work after each action | `src/work-order.cjs` |
| Level fields, irrigation, protected soil | `src/farm-layout.cjs` |
| Routes, swimming, stairs, bridges, placement checks | `src/travel.cjs`, `src/island-routes.cjs` |
| Reachable interaction positions and dropped-item goals | `src/block-approach.cjs`, `src/pickup-goal.cjs` |
| Server block acknowledgements and teleport cancellation | `src/block-updates.cjs`, `src/teleport.cjs` |
| Remembered farm chests and restocking | `src/farm-storage.cjs` |
| Central hub, consolidation, chest signs, replacement tool stock | `src/storage-steward.cjs`, `src/storage-crafting.cjs`, `supabase/migrations/` |
| Named bot conversations, persistent role/location memory, scheduled returns | `src/colony-chat.cjs`; fleet wiring and ticker in `src/server.cjs` |
| Human chat identity and memory context | `src/llm-chat.cjs` |
| Shared storage, leases, inventory policy, crafting | `src/storage.cjs`, `src/storage-policy.cjs`, `src/colony.cjs`, `src/crafting.cjs`, `src/storage-crafting.cjs` |
| Routes, selected bot, controls, map, activity display | `src/server.cjs`, `public/app.js`, `public/world.js`, `public/activity.js`, `public/index.html` |
| Human-readable architecture and movement rationale | `docs/CODE-GUIDE.md`, `docs/movement-research.md` |

The web controller starts through `src/server.cjs`. `bot.cjs` is an older Terminal entry point. Updating it alone will not update dashboard skills. JavaScript uses CommonJS (`require`, `module.exports`). Reuse installed packages; add a dependency only for a demonstrated capability gap. Inspect installed Mineflayer implementations for version-specific behavior; don't guess APIs or casually patch `node_modules`.

## Define the work before writing the loop

Choose whether this is a finite job or a continuous producer. Define:

- The work area and how it is selected or inferred. Prefer the map, nearby observations, and saved places over mandatory typed coordinates. Bound scans and destructive work explicitly.
- Inputs, output, required tools, working reserves, and storage destination.
- What counts as success, measurable progress, a temporary obstacle, and a reason to pause.
- Whether the skill may change terrain, which blocks it owns, and which player structures it must preserve.
- How it recovers from missing supplies, full inventory, unreachable targets, low air, and a changed world.

A useful continuous cycle is: observe → handle immediate danger → finish local productive work → restock missing supplies → store a useful batch → expand or prepare future work → wait only when there is nothing productive to do. Adjust this order for the skill; combat or food emergencies take precedence over production.

Keep decisions separate from physical actions. Planning selects and explains the next bounded job. Execution revalidates it against the live world. An LLM may explain observations or interpret intent, but should not replace deterministic reach, safety, inventory, and cancellation checks.

## Implement through the existing task lifecycle

1. Add `src/<skill-name>.cjs`, extending `Work`, or `Survival` when its resource and safety helpers are useful. Inspect constructor side effects: inheriting `Survival` also touches survival state. Do not copy the entire wheat farmer into an unrelated skill.
2. Give the class a `run()` entry point matching existing factories. Register its `type`, label, aliases, and factory in `src/skills.cjs`. Inspect `Agent.startWork` and parsing for any additional integration; parameterized jobs need validated arguments, not only an alias.
3. Add the skill to the actual dashboard selector and command flow. Verify the selected bot receives the request. Check the API metadata, availability rules, and help text; don't assume registering a factory automatically updates every UI control.
4. Publish plain, bounded state: phase, current decision, target, confirmed counts, obstacle, next retry time. Keep Mineflayer objects, promises, windows, and credentials out of browser state.
5. Add meaningful tests and validate the result. A code change is not loaded into an existing Node process automatically.

Keep one active work controller per bot. Subskills such as gathering torch supplies must run through that controller, not start a competing top-level task. Another bot has its own controller and inventory; never share mutable task state between players.

### Adding a new player, not just a skill

A skill and a player profile are separate. Existing players can run different skills; adding a factory alone does not create a new connected bot. When a new named player is requested:

- Inspect the fleet in `src/server.cjs`. Give the new `Agent` a unique Minecraft username, fleet/API ID, and dedicated `dataDir`; share the backend `Colony` transport, not inventories or work controllers.
- Wire the agent into the fleet and its `fleet` references, refresh/coordination ticker, connection controls, selected-bot UI, and relevant profile/count assumptions. Inspect `public/app.js` and `public/index.html` rather than assuming the UI is generated from the backend.
- Keep logs, jobs, chat configuration, saved places, and `colony-memory.json` isolated by player. Scope world-specific memory by world and dimension. Never copy another bot's live session or credentials into a profile.
- Add the profession and required tools/supplies to the current coordination model. `ROLES`, `NEEDS`, and `SUPPLIES` in `src/colony-chat.cjs` currently contain explicit role defaults; arbitrary new professions are not inferred automatically. If changing professions on an existing player, deliberately update its persisted role and Sam's learned role rather than relying on a new display label.
- Test that commands, SSE/state, connection changes, Stop, and memory affect only the selected player. Ensure human chat uses that player's identity: an earlier shared chat helper hardcoded “Marc,” making other bots respond as him.

### Cancellation, deadlines, and cleanup

- Call `check()` in bounded loops and after awaits before taking another action. Use `timed()` for operations that can hang, and the work's cancellable `pause()` for waits.
- A continuous skill can remove its overall completion deadline, but each route, dig, placement, window action, search pass, and retry still needs a limit. Infinity is not a solution to a stuck action.
- Preserve `nav`, connection identity, and cancellation guards. An old callback must never move, equip, publish success for, or clear controls on a newer task.
- Clean up listeners, intervals, windows, and temporary movement settings in `finally`. Keep the task lock until its asynchronous cleanup actually finishes.
- Distinguish an expected blocked target from cancellation and fatal failure. A broad `catch` that keeps looping can make Stop ineffective or hide drowning.
- Reuse low-air recovery where appropriate: interrupt ordinary work, surface, confirm recovered air, then resume. If recovery cannot succeed within its limit, report the blocker instead of spinning forever.
- Teleportation invalidates old routes and interactions. Preserve `src/teleport.cjs`: meaningful server displacement cancels the old task; small position corrections should not. Do not automatically resume destructive work in a new location.

**Failure we observed:** teleporting Marc mid-dig left a wait for an old block update. The wait never completed, and the hung-action safeguard disconnected him. Pass the work's abort signal to `watchBlock`; cancelling an observation must release it without pretending Minecraft confirmed success. Truly unresolved side-effecting library operations still require the existing isolation safeguards.

## Minecraft is authoritative

Re-read a block or entity immediately before acting. It may have changed during travel. Verify its type, crop age, required support, reach, visibility, and the equipped item again.

A resolved animation or locally predicted block is not proof of success. Reuse the server-confirmed dig/placement helpers. Register `watchBlock` before sending the action, pass the cancellation signal, wait within a deadline, and always clean up its listeners. Count success only after the appropriate acknowledgement and postcondition checks. A cancelled watcher resolving is not a successful placement; the enclosing work cancellation check must still run.

Tool choice must account for harvest eligibility, mining speed, enchantments, and durability. Use the shared tool selector rather than the first item named `pickaxe` or an iron-first list. A faster but ineligible tool is not suitable; an enchanted diamond/netherite tool should beat a slower iron one when appropriate. Keep useful equipped/hotbar choices while allowing the shared inventory selection behavior.

Pickup is separate from mining. A missing entity may have despawned or been collected by another player. Use nearby pickup goals and confirmed observations; don't infer inventory gains from entity disappearance. Failed optional pickup should not erase a successfully mined block or monopolize the production loop. Cool down inaccessible drops.

## Make production efficient

**Do not sort once from the starting position and follow that order all day.** That caused Marc to alternate between opposite ends of the wheat field. Reuse `nearbyFirst` or an appropriate route strategy that chooses the next target after each action. Preserve local continuity even when collecting a drop shifts the bot slightly. Revalidate candidates; failed targets should not attract the rest of the route.

For rectangular construction, rows or layers with alternating row direction may be better than nearest-first. Preserve prerequisite order: repair a walking gap before extending the far shoreline; build a support before the block resting on it. Locality must not discard those dependencies.

Use batch targets and separate **restock triggers** from **desired stock**. Gather a useful surplus on an already-needed trip; do not leave after every single recipe ingredient. FARMER has used targets of 16 logs, 48 dirt, 8 coal, and 32 seeds. These are tuning examples, not requirements for other skills. Account for available stock, inventory space, remaining job size, tool wear, and travel cost. Accept a smaller available batch if it satisfies the immediate need; don't explore indefinitely just for surplus.

Finish a productive nearby patch before discretionary wood, torch, or chest trips. Handle urgent survival needs immediately. Prefer stack-sized deposits or inventory-pressure triggers over depositing every few items. Reserve enough seeds, food, tools, fuel, and access blocks to avoid depositing something and immediately searching for it again.

Waiting for crop growth is valid only after considering harvesting, replanting, expansion, repairs, supplies, and storage. A blocked objective needs a reason and a bounded retry time. Prevent rapid objective oscillation by retaining a current job, tracking progress, and cooling down failed targets.

## Movement must stay responsive

Use `Travel` and shared interaction goals. “Stand on the ore” is not the same goal as “reach a position where the ore can be mined.” A block may be reachable horizontally but hidden, above reach, underwater, or behind a collision shape.

Bound search time, nodes/candidates, travel distance, and retries. JavaScript pathfinding shares a thread with Minecraft networking and physics. Explicitly yield through an event-loop timer between expensive slices; an immediately resolved promise or a skill's no-op `pause()` does not reliably let physics advance. Raising a route timeout alone can worsen apparent server lag.

For distant destinations, use the existing segmented planning and partial-route handling. Arrival at an intermediate waypoint is not arrival at the original goal. Detect repeated endpoints and lack of positional progress; report the destination and route phase on the map.

Swimming, ledges, floating islands, and doors are separate geometry cases. Reuse existing movement validation rather than holding jump/forward indefinitely. Bridges and stairs require reachable support faces, clear player headroom, sufficient reserved blocks, and server-confirmed placement before stepping onto them. A planning overlay is hypothetical terrain, not proof a bridge exists.

An obsidian cage is not evidence that the controller should crash or keep retrying forever. Report that the destination is blocked. Mining an escape requires suitable tools and permission within the requested terrain-changing scope; don't silently dismantle arbitrary player structures.

## Storage and processing

Check carried inventory, then known usable storage before gathering replacement resources. Chest snapshots are observations that go stale, not authoritative global inventory. Reopen and verify actual contents and transfers through the shared helpers.

When colony storage is configured, reuse its leases, world/dimension identity, item fingerprints, reservations, and reconciliation rules. Never bypass it with raw deposits because a database operation failed. Review `docs/STORAGE-SETUP.md` when changing shared behavior. No configuration and broken configuration are different states. Do not identify a world by its changing LAN port.

Always close container windows, including late opens after cancellation. Rejected or ambiguous transfers must not increment stored/withdrawn counters or silently retry a potentially completed transaction. Respect reserved working stock and valuable item metadata. Keep backend secrets out of logs, UI state, and tests.

For crafting or smelting, distinguish input availability, recipe validity, fuel demand, work in progress, and confirmed output. Reuse existing crafting and furnace code where applicable. Waiting for a furnace should remain cancellable and need not prevent independent safe preparation work. Never count expected future output as carried inventory.

### Lessons from verified chest transfers

**Observed failure:** a real deposit completed, but verification compared the open chest against `bot.inventory.items()`. In the installed Mineflayer version, the standalone player inventory can remain stale until the container closes. Successful wheat and stick deposits were falsely marked uncertain, and Sam stopped when later approaching those chests. The swimming/arrival messages preceding the error were unrelated.

Reuse `storage.withChest()` and `storage.transfer()`. They write intent before the physical action, use the container's player-slot region for the before count, close/reopen the container to obtain fresh server contents, then verify matching chest/player deltas and an empty cursor before finishing the database operation. Use the reopened `ctx.window` for subsequent transfers; holding the old window across multiple moves reintroduces stale state. Preserve exact source/destination slot bounds and metadata fingerprints so modified items are not merged accidentally.

A pending operation quarantines the chest even after its lease expires. Timeout, cancellation, or reconnect does not prove a transfer failed. Stop/disconnect the originating worker and account for its carried inventory before explicit `reconcile storage X Y Z`. Recovery takes an exclusive lease, saves observed contents, preserves historical intent, and marks pending work reconciled; it does not replay a deposit or pretend its old result was confirmed. Inspect affected crafting jobs before requesting remaining work. Never clear all pending rows or bypass the lease to make a warning disappear.

The private Postgres schema and backend-only RPCs are defined in ordered migrations. Apply missing migrations to the intended Supabase project when that deployment is authorized; a local SQL file is not a deployed function. Supabase generates/resolves world UUIDs from stable labels; neither a hand-entered UUID per bot nor a LAN port identifies the shared world. Keep project keys in backend configuration. Real database tests use an explicitly selected disposable container, never the live world database.

### One storage area, existing capacity, and labels

Read the world/dimension hub through `hub_get`; configure it through the existing hub command/RPC. Current deposits select managed category or overflow destinations within eight blocks of that point. This is a current bounded policy, not a Minecraft rule. Do not hardcode this session's chest coordinates, project ID, or bot position into a future skill.

**Observed layout problem:** Jerry created wood/food chests near his work, while Marc created separate farm storage. Sam's initial organizer only sorted managed chests by category and could not consolidate the two areas. Reuse/enroll existing central capacity first, then move stock with verified withdrawals/deposits. Avoid building a new remote store merely because the worker moved. Audit alternate creation/deposit paths, including farm helpers, so they honor the hub too.

Consolidation must account for reservations, capacity, item metadata, and inventory space. Prefer an exact category, then overflow. Free mixed overflow space when dedicated category capacity exists. Recheck actual capacity during execution; another worker can fill a chest after planning. Return leftovers to the source where possible and report anything still carried. Empty old chests remain intact unless removal is requested. Do not treat an unloaded chest as empty or repeatedly haul the same category between equivalent destinations.

Double chests need one canonical identity for both halves, including facing and left/right orientation. Splitting, joining, or replacing chests changes topology; follow the setup guide's reconciliation procedure. Ordinary chests are the currently supported managed container type. Barrels, ender chests, furnaces, and other inventories need explicit semantics rather than pretending they are 27-slot chests.

Use supplied ordinary signs for physical category labels. In the installed library the emitted event is `signOpen`; documentation encountered during development used a different name. Inspect implementation as well as docs. Listen before placement, sneak when attaching to an interactive chest, select a reachable clear face, use `bot.updateSign`, and verify the returned block-entity text. Remove listeners and release sneak in `finally`. Detect an existing correct label so repeated maintenance does not consume another sign; handle a partial/mismatched label deliberately. Category labels age better than exact stock counts. The current reserve retains up to 32 signs.

A block-cell center may have line of sight while the actual player standing at its edge does not. Repeating a goal that accepts the same cell can instantly “arrive” forever. `storage.approach()` handles the observed case with a bounded alternative stance followed by a fresh reach check. Do not remove the reach check or broaden tool reach to hide it.

### Tool making is a production skill

Keep tool manufacturing separate from announcing where tools are. `storage-steward.tools()` currently maintains four pristine iron pickaxes, axes, shovels, hoes, and swords in central stock. It checks existing shared/carried outputs before planning a deficit and uses durable crafting jobs. This buffer is configurable product policy, not a requirement that every future bot carry all five tools.

Use `crafting.planRecipes`, `stocks`, and `execute`: supported recipes, bounded dependency depth/execution count, fresh available stock minus reservations, intermediate ingredients, table requirements, inventory capacity, and verified output. Do not spend a worker's reserved food/access stock without an explicit policy change. Prefer the public `bot.placeBlock` API; an earlier private placement call required additional options and failed. Validate placements against live support/headroom rather than blindly retrying another location.

Workers should obtain suitable shared tools before manufacturing duplicates. `hasTool()` prevents a request for iron when a matching higher-tier tool is already carried; actual action selection must still consider eligibility, durability, and enchantments. A name/tier check alone is not a complete replacement policy for worn tools. Do not take another player's personal equipment to refill the shared buffer. Normal surplus storage preserves carried tools; newly crafted shared outputs are deposited explicitly.

Missing ingredients should produce an honest waiting/blocker state, not fabricated output or endless duplicate jobs. Replenishment does not currently gather ore, smelt iron, or support every recipe. Adding a smelter requires real furnace coordination and confirmed processing. If multiple tool makers are introduced, coordinate the stock deficit atomically: claiming individual jobs does not by itself prevent two makers from independently queuing the same deficit.

## Named coordination and durable memory

The user explicitly requested visible named Minecraft chat between bots. Reuse `ColonyChat`, which works without an LLM:

1. Sam asks a connected fleet peer what it does when its role is unknown and saves the reply.
2. He asks what it carries and needs. Replies are bounded inventory observations and role-specific supply requests; better matching tools suppress inferior replacement requests.
3. He gives central category coordinates, tool pickup coordinates, and currently observed availability. Workers stage the location update, persist it, and acknowledge its revision.
4. Sam compares the catalog layout revision, updates peers when managed chests/categories/locations change, and retries unacknowledged updates. Stock quantities are separate from layout identity. Disconnected peers receive missed updates when connected again.

`colony-memory.json` lives in each bot's `dataDir`. It stores roles, learned reports/destinations, acknowledgement state, and the return policy by world/dimension. This memory is local persistent context; Supabase remains the shared storage catalog. Moving controllers to another machine requires migrating appropriate memory or relearning it. Never assume local memory is already synchronized across hosts.

Wire `agent.coordination.returnSupplies(work)` into a **safe skill checkpoint**. Current policy is five minutes or fewer than four empty inventory slots. It executes through the existing work owner, stores surplus with shared reserve rules, and retrieves missing role tools. Recover tree scaffolds/finish a climb before returning; a future wall builder should secure its working platform first. A timer must not start competing movement or interrupt a container transfer. Document checkpoint delays honestly: this is not an exact five-minute alarm, and idle/stopped workers do not run production checkpoints.

Treat remembered coordinates as routing context, not proof that a chest still exists or contains tools. Physical transfers still consult the shared catalog and reopen the actual chest. A saved acknowledgement proves receipt of instructions, not a successful deposit. Verify both memory and physical behavior when testing the integration.

Automatic protocol messages are accepted only from matching connected fleet peers in the same world/dimension, addressed to the receiving bot. Keep parsing narrow, queues/rate/retries bounded, and queued messages tied to connection epoch and scope. Do not let free-form chat execute arbitrary commands, SQL, or movement. Human LLM chat receives observations and saved context, has no action tools, and must not answer protocol messages or create bot-to-bot reply loops. Named operational coordination is distinct from the disabled periodic activity narration.

## Notes for specific future skills

These are design starting points; verify mechanics against the installed game registry and the relevant implementation before coding.

| Skill | Key choices and regression cases |
| --- | --- |
| Wheat farmer | Harvest mature crops, preserve replanting reserves, finish local patches. Expand across eligible soil rather than arbitrary 2×2 islands. Preserve a consistent ground level, paths, and irrigation; don't quarry the farm floor for expansion dirt. Reuse the hydration planner instead of adding water per plot. |
| Sugarcane farmer | Preserve the growing base and required water/support. Harvest upper growth in nearby batches. Design expansion around sugarcane's own placement rules; don't reuse wheat tilling, seed, or maturity logic blindly. Test vertical columns and changed lower blocks. |
| Mob killer | Define allowed targets, pursuit bounds, attack timing, weapon choice, retreat conditions, and drops. Exclude players, pets, and neutral mobs unless explicitly in scope. Revalidate moving/dead entities and line of sight. Integrate combat with the task lock and safety recovery. |
| Terraformer | Define a bounded target surface and cut/fill plan. Budget fill material before excavation. Preserve access, structural supports, irrigation, and excluded structures. Test negative coordinates, cavities, liquids, unloaded terrain, and cancellation halfway through. |
| Wall builder | Plan supported layers with an accessible working side and deliberate openings. Gather material in batches. Compare expected blocks with live terrain so rerunning continues rather than duplicating work. Do not trap the bot or seal its only route. |
| Smelter | Specify recipes, input/fuel reserves, furnace ownership and capacity, output collection, and storage. Handle full output, absent fuel, unloaded/replaced furnace, rejected transfers, and cancellation while waiting. Shared furnaces need coordination between bots. |

## Tests, diagnosis, and handoff

Use `test/helpers/survival-fixture.cjs` for resource/task behavior and the movement fixtures plus captured terrain for geometry. Fixtures must represent the property being tested: earlier locality tests failed because fake crop age did not match `stateId`; bulk gathering tests failed because fake approach never moved the player. Fix inaccurate fixtures without removing the real behavioral assertion.

Cover the new skill's meaningful invariants: confirmed output, local work order or travel cost, batch collection, reserves, stale targets, missing resources, bounded failures, Stop during an await, and teleport during work. For building, verify support, final geometry, and partial completion. For storage, verify rejected and uncertain transfers. Use physics simulations for actual movement claims; a mocked successful `goto()` proves no reachability.

Additional regression references:

- `test/storage.test.cjs`: stale standalone inventory versus reopened server contents, rejected predicted clicks, metadata, capacity, reservations, and sign parsing.
- `test/colony-postgres.test.cjs`: concurrent workers, backend-only access, world/dimension isolation, quarantine/reconciliation, and hub persistence. These tests skip without the explicit disposable database configuration; report that as skipped, not validated.
- `test/colony-chat.test.cjs`: addressed role/inventory exchange, persistence across a new coordinator instance, dimension isolation, acknowledgement, changed-layout updates, and superior tools suppressing replacement requests.
- `test/web.test.cjs`: player isolation and public API behavior. Update fleet assumptions when adding a player.

In live testing, verify consecutive multi-stack transfers (not only one click), a second maintenance pass that does not duplicate signs/tools, and a worker actually collecting supplies or returning surplus. Shared database tests plus a successful HTTP command response cannot establish these physical results. Check uncertain operations before and after the run. Do not restart a worker mid-transfer merely to load a small refinement; wait for a safe boundary when practical.

From the repository root:

```sh
npm run check
node --test --test-concurrency=1 test/<relevant-file>.test.cjs
# When shared behavior changes, run the wider suite:
node --test --test-concurrency=1 test/*.test.cjs
```

Inspect every failure. Distinguish failures caused by the change from concurrent unfinished edits or environment-dependent tests; don't claim a green full suite from a focused pass. Tests do not establish universal island/door/cage reachability or an unmeasured speed improvement.

For live diagnosis, use Bot activity, `npm run logs`, and the selected bot's `/bots/<id>/api/state`. Inspect the current action, deadline, last progress, destination, position, inventory, and obstacle. `/api/navigation-snapshot` captures bounded loaded terrain for movement replay. Diagnose whether the issue is CPU-bound route search, missing server acknowledgement, unreachable geometry, depleted stock, or legitimate waiting before changing a timeout.

For requested runtime activation, inspect the current fleet and listening process first. Other tasks may have changed files or restarted the server. Preserve other bots' connection/task choices, avoid duplicate servers, and reconnect using the current LAN settings. Don't restart a live session just for documentation. After loading code, verify actual connection and progress rather than only an HTTP 200. A cancelled teleport task should stay cancelled until the user chooses new work.

Keep explanations readable: comment why a reserve, retry limit, acknowledgement, or geometry check exists. Log decisions and confirmed progress to the dashboard without flooding Minecraft chat. Automatic 30-second chat summaries were explicitly disabled; don't restore them as part of a new skill. End with what changed, how it was verified, what is actually running, and any concrete remaining limitation.

## Building-stock policy (current user requirement)

Keep 128 of each carried supported building material (including dirt and cobblestone) out of
normal surplus deposits and recipe spending. Reuse `src/building-supplies.cjs`: when combined
usable building stock falls below eight, refill toward 128 total, taking shared storage first
and gathering only the shortfall. Dirt-only climbing jobs request 128 dirt specifically.
The low-stock trigger and full-batch target are distinct; do not revert to 12/16/32-block trips.
A failed configured database is not an empty chest and must not trigger an unsafe bypass.
Run replenishment at safe work checkpoints, before discretionary work, without interrupting
an active transfer or climbing column. Gathering is bounded and reports a shortfall if safe
nearby terrain cannot supply the batch. Future skills must call this shared policy too.

Storage expansion uses `storage-steward.expand`: fewer than four empty slots across a central
category triggers one new, separately placed chest per pass. Inspect current capacity again
after sourcing/crafting materials, stay inside the hub, enroll and label the confirmed chest,
and let named coordination distribute the new location. Empty remote capacity does not solve
a full central store. Include undeposited carried tools in production-buffer counts: counting
only chest stock caused repeated crafting when a full chest rejected the output. Missing wood
or placement space needs a visible bounded blocker, not repeated duplicate crafting jobs.


### Warehouse revision: double chests and armor

The current warehouse implementation supersedes the earlier single-chest expansion policy.
Read `src/warehouse-layout.cjs` for the fixed south-facing grid, floor/aisle checks, persistent
partial-bay recovery, and verification before registration. Build both halves before exposing
a 54-slot container to shared stock. Do not join an already registered single chest: its ID,
leases, operations and reservations require an explicit topology migration. Keep old stock
readable while consolidating into the new doubles; do not destroy full legacy chests.

Capacity targets include 27 spare slots per category or 25% of used slots, whichever is larger,
plus 54 spare overflow slots. Try at most three bays per pass inside the bounded site. Layout
and materials can prevent completion; report that instead of claiming infinite expansion.
Labels belong on the same front face/half at the same height, not whichever side is nearest.
Use `test/warehouse-layout.test.cjs` for aligned geometry, double verification, registered-half
rejection and armor planning. Sam's armor buffer follows successful tool replenishment and
counts carried outputs; the current supported armor is iron, with at most four shared sets.

For joined chests, wait for both block updates: the destination placement acknowledgement
can precede the partner's change from single to double. Keep the construction record pending
until canonical identity and the 54-slot window are confirmed. Prefer an available crafting
table even for intermediate planks so the installed crafting implementation synchronizes its
window before verification. Retrieve/craft labels if supplied signs run out, and keep them
on the planned front face. Test delayed partner updates and resuming a one-half build.
