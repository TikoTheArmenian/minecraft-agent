# Review and fixes — 12 September 2026

Reviewed the web server, browser code, connection lifecycle, navigation, mining, farming,
waypoint persistence, original Terminal demo, launch scripts, and dependency audit.

## Fixed

- An action timeout could wait forever for its underlying promise, leaving all future work
  locked. Cancellation now has a short cleanup grace period. If an operation cannot settle,
  its old connection is closed so delayed actions cannot interfere with another session.
- Partial work counts could disappear on cancellation or a timeout. Counts now belong to the
  task, and failure reasons survive connection cleanup. Old work cannot unlock a newer task.
- Mineflayer predicts air locally when digging finishes. Mining now also requires a received
  server block update; client prediction alone never increments the removed-block count.
- Failures collecting dropped items could add a successfully removed block to the failed
  mining list. Removal and pickup are now separate results. Collection events count actual
  item stacks picked up while work runs, not assumed drops.
- Farm seed stock and soil are rechecked after travel/equipment changes and immediately before
  harvesting or planting. Mature crops stay intact if replanting stock disappears.
- Connecting could remain stuck forever if the bot never spawned, and plugin initialization
  failures could leak a client. The session now has a spawn deadline and cleanup on failure.
- Late spawn/chunk-loading callbacks could reactivate a disconnected or changed world. Session
  and spawn identities now prevent this. Commands wait for chunks; dimension changes cancel work.
- Inventory, search results, saved places, and dimensions could remain visible after a
  disconnect. Scene data is cleared on disconnect, respawn, and world changes.
- Search could treat inherited object properties as block names. Block resolution now checks
  only actual registry entries. LAN ports and persisted waypoint coordinates are validated.
- Navigation could leave a running task after a synchronous pathfinder error. Errors and
  cancelled deferred starts are handled, and all path completions release their controls.
- Browser conversation history vanished on refresh. Both requests and responses are now kept
  in the server's bounded in-memory history. History still resets when the server restarts.
- Failed commands erased the input text. The browser now preserves it, prevents overlapping
  submissions, labels stale search distances, and shows controls appropriate to connection/work state.
- Event-stream listeners and slow-client buffers could accumulate. Closed responses detach
  their listeners, and lagging clients are disconnected instead of buffering indefinitely.
- API errors could return HTML or expose raw JSON-parser details. The API returns consistent
  JSON errors, validates request shape/content type, and rejects oversized/cross-origin requests.
- Terminal wandering could overlap multiple unfinished turns. It now permits only one pending
  wander step. Late spawn events after quit are ignored, and connection errors exit unsuccessfully.
- Finder launch scripts assumed an absolute project path. They now start from their own folder.

## Validation and remaining limits

`npm run check` syntax-checks all JavaScript source files. `npm test` includes regression tests
for the above lifecycle, cancellation, server-update, mining, farming, HTTP, and persistence bugs.
The tests use controlled block/inventory fixtures and real local HTTP requests. They do not
substitute for harvesting or clearing a chosen live plot. No arbitrary terrain was mined as
part of this review, and visual browser interaction was not exercised.

The existing six moderate npm audit entries remain in the Microsoft/legacy authentication
chain through uuid. npm's suggested force fixes downgrade Mineflayer or minecraft-protocol to
incompatible old releases; these were not applied. Package versions and the lockfile remain pinned.

Area work remains bounded to 512 selected positions and at most 512 removals per job. Automatic
world physics can still move neighboring sand, fluids, or attached blocks. Farming tends existing
farmland; it does not create irrigation, till soil, or run continuously. A sent placement cannot
be rolled back by Stop. The local control app supports explicit command patterns, not an LLM.

## September 12: live block map and survival starter

Added `src/world.cjs`, `src/survival.cjs`, and `public/world.js`. The main UI now
renders loaded blocks to a canvas, supports player/bot focus and height cutaways,
and resolves click/drag mining selections against short-lived server snapshots.
Nearby resources, health, hunger, inventory and threats accompany the image.
Old snapshots, scene changes, forged indices, oversized areas and altered terrain
are rejected before map actions start.

Survive implements inventory-driven wood gathering, recipe-verified crafting,
stone tools, exposed iron, plant-based food collection/eating, and a four-plot
irrigated starter farm. Existing tools/farms are recognized; missing milestones
remain visibly blocked. Crafting and hoe use share cancellation guards. It checks
actual collected inventory, avoids Silk Touch when raw drops are needed, and
requires Survival mode throughout. Close threats/critical health/low air pause
work. This is bounded rule-based autonomy, not indefinite survival or an LLM.

Validation: `npm run check` (13 JavaScript files) and `npm test` (64 passing tests).
New tests use actual 1.21.1 recipes and controlled block/inventory fixtures for the
full empty-inventory progression. Also cover blocked iron with later progress,
wrong/missing pickups, tool upgrades, hunger reserves, water requirements, repeat
farms, threat pausing, mode switches and Stop during crafting/tilling.

The running Java world supplied the live map and resource scan. Browser rendering,
keyboard region selection (2×2×3), map refresh and height controls were verified;
no browser errors were reported. The bot is currently in Creative mode, so the
complete survival run has not been verified end-to-end in the live world. The UI
explains how to change WalkBot to Survival and why a distant/untracked player view
falls back to WalkBot. No additional packages were installed.

## Conversation, inventory card and tool selection

The conversation has a bounded, independently scrollable log with non-shrinking messages;
new replies preserve the scroll position when the reader is above the bottom. The old
destination form is replaced by live inventory, counts, hotbar slot labels and equipped-item
highlighting. The task status remains in Work progress.

Tool selection now compares normal mining speeds in Creative mode and corrects the
comparison material for 1.21.1 ore entries whose material is an incorrect-tool tier tag.
It respects enchantments and harvest capability, resolves speed ties by appropriate tool
tier, and avoids nearly broken tools. It uses the existing Mineflayer equip API to switch
hotbar slots or move inventory tools into the hotbar. No world block data is modified.

Validation: syntax checks passed; 69 tests passed, including diamond versus iron across
stone/ores and game modes, Efficiency enchantments, axes/shovels, worn tools, and actual
equipment selection before digging. Browser verification confirmed 709 pixels of messages
scroll inside a 340-pixel log; incoming replies preserved a scroll position of zero.
The destination card is gone and the inventory replacement renders correctly.

## Activity logging and Survive readiness diagnostics

Investigated the disabled Survive button: the live bot was ready but idle (`busy=false`,
`task=null`, `survival=null`) and in Creative mode. No survival task was stuck.
Added prominent Idle/Running/Stopping state, game mode, controller heartbeat, readiness
reason, and a specifically labeled disabled button. Readiness is derived on the server.

Task instrumentation records action names, starts, completions, failures and deadlines,
plus selected equipment, pathfinder status, obstacles, mode changes, and rejected API
requests. The live feed has filtering, scrolling and download. Activity is mirrored to the
server Terminal and persisted in a rotating 2 MB log with one previous file. `npm run logs`
follows it from another Terminal. Logging errors cannot crash bot work. Unexpected work
rejections also mark the task failed instead of leaving a misleading running label.

Syntax checks passed for 15 JavaScript files; all 76 tests passed. Added coverage for
readiness reasons, log rotation/writing failures, terminal control-character sanitation,
action timing and failure metadata, and the read/download log endpoints.

During this investigation, the user changed WalkBot to Survival and attempted a run.
That exposed a real 1.21 component compatibility bug: `item.enchants` returned an
`{enchantments:[{id,level}], showTooltip}` object rather than the older array. Added
`src/item-tools.cjs` to normalize it without changing inventory packet data, using
the server's dynamic enchantment registry. Both tool selection and Mineflayer's
actual dig-time helper use the normalized list, including after plugin injection.

Final validation: syntax checks cover 16 files and all 80 tests pass. Tests include
real prismarine-item component objects, numeric registry IDs, Silk Touch, Efficiency
and helper installation timing. The live inventory now correctly reports the
netherite pickaxe's Efficiency V. A subsequent live run broke two oak logs and
recognized the existing netherite tool; it stopped with pathfinding failures when
collecting dropped wood and approaching iron/grass. It was idle afterward. The
new UI displayed these events and the saved activity log retained them. The
pre-restart failed state was saved in `data/last-debug-snapshot.json` for reference.

## Swimming, shoreline stairs and resource approaches

Replaced the restrictive land-only movement settings with `TravelMovements`, shared by
ordinary map travel, mining, pickups, tending and Survive. Surface swimming permits bounded
water entries and corrects the pathfinder graph's take-off height for climbing out of water.
Dry-land drops remain small; lava, submerged passages and farmland are excluded.

When a direct route fails, `Travel` checks candidate shoreline stairs against the actual A*
planner, using a private block overlay before changing the world. Both the swimming staging
point and the onward route must be reachable. It builds one- or three-block stairs from an
allowlist of ordinary inventory blocks, at most eight blocks per task. Equipment and turns
are cancellable; placement rechecks terrain, reach and entity collisions, skips the helper's
delayed look, and requires a server block-update packet. Native asynchronous scaffolding
remains disabled. Travel phases and confirmed placements appear in Bot activity.

Live testing also exposed GoalLookAtBlock's inability to target shape-free grass/crops.
`BlockApproachGoal` checks the target cell and intervening collision shapes consistently,
including the bot's actual view before mining. Partial path logs are throttled; SSE coalesces
bursts into the latest state to prevent the browser disconnecting during busy searches.

Validation: 90 tests pass, including actual pathfinder plus prismarine physics swimming off
a platform and climbing zero-, one- and three-block shore routes; rejected stock, occupied
steps, changed terrain, Stop during equip, missing server confirmation, obstructed crop/ore
views, and a 2,000-update SSE burst. Syntax checks cover 18 JavaScript files.

In the user's live Survival world, WalkBot swam from its platform, placed and received server
confirmation for three cobblestone steps, climbed onto the ore island, mined two iron ore,
and collected two raw iron. Cobblestone decreased from eight to five. The final controller
update is running and both in-app tabs were refreshed. No packages were added.

### Follow-up: stuck swimming, hesitant ledges and lingering objectives

Found that pathfinder `goto()` leaves its goal/partial path active after some failures.
Travel now clears those on every exit, guarded by task/session identity, before the
survival loop can move to another objective. A 4.5-second progress watchdog ignores
vertical swimming bob and retries a stalled route at most twice. Water entry follows
an already planned adjacent water landing through a clear corridor, avoiding the
dry-land jump predictor's hesitation at ledges. Submerged starts surface first, existing
shore approaches avoid needless construction, and resource goals require stable ground
beside the target rather than standing on ore or bobbing in water.

Survive logs explicit objective starts and completion/blocked reasons, and the activity
panel shows the objective separately from walking/swimming/placement. Added regressions
for stale route cleanup, a deliberately stalled route, underwater starts, stable mining
stances, and ordered objectives with existing iron. The user's latest observed run had
three raw iron in inventory and four wheat plots planted; food was the remaining blocked
objective. This confirms iron/farming progress, not continuous autonomous survival.

Final combined validation: all 98 tests pass and 18 JavaScript files pass syntax checks.
This includes the subsequent wheat-goal changes present in the shared workspace. Movement
coverage also includes starting just above the water surface, where the stock landing
search skipped the water immediately below. The controller is running with these fixes.

### Follow-up: repeated bobbing beneath the tree platform

The live loop repeatedly attempted high logs from the same tree while holding Jump during
shore searches. Added a bounded lateral escape to an open water column before surfacing,
a four-second shoreline-search budget, and grouping of unreachable logs from the same tree.
Also replaced the package's goto completion helper: an empty *partial* A* result must not
resolve as arrival. That premature resolution caused searches to be cancelled and restarted.

All 101 tests pass, including actual-physics escape beneath a solid overhang, unfinished
empty-path handling, and one failed tree approach rather than a separate retry for every log.
The controller was restarted and reconnected; WalkBot was observed back beside the farm.

## Continuous wheat farming

Added `WheatFarm`, a separate cancellable production loop and web control. Harvests only ripe wheat, replants with reserved seeds, expands irrigated soil, preserves water rows and walking lanes while extending shore ground, crafts chests, and verifies surplus wheat/seed deposits. Keeps 12 wheat and 32 seeds; shows live decisions, storage totals and growth-check countdown. Reuses existing navigation, tool selection, crafting and safety controls; no dependencies added.

Validation: 19 source files passed syntax checks. Full 109-test suite passed after an existing swimming physics test failed once and then passed standalone and in the full rerun. Two additional chest crafting/cancellation tests also pass (10 wheat-specific tests total). Browser verified the new card and Survival-mode gate. Controller restarted and reconnected; LAN assigned Creative mode, so no live farming run was started. Actual chest transfer and growth remain to be exercised in the live world.

## Dropped-item route timeouts

Pickup previously used an exact radius-zero goal at the floored item position, which can lie inside farmland or slabs. Replaced it with a moving collection-range goal, a 350 ms preflight search bounded to 12 blocks, at most three drops per pass, and a one-minute cooldown for failed/unconfirmed drops. Optional pickup movement has no stall retries or shore-building fallback, and retires its route after four seconds before the fatal work timeout. Normal destination travel retains its existing recovery behavior.

Validation: all 113 tests pass, including new fractional-height/moving-drop and unreachable-drop cooldown regressions; 19 source files pass syntax checking. An existing overhang physics test failed once under the full run, then all 16 travel tests and the full suite passed. Controller restarted and reconnected. Live pickup remains to be exercised in Survival mode.

## Farm production and OpenAI chat

Live diagnosis: Survive had finished partially at 11/128 wheat; continuous farming had never been started. Changed the wheat objective to expand irrigated plots and wait cancellably between harvests, without random exploration for ripe crops. Continuous farming now prioritizes planting, clears ordinary grass on plots, can gather grass blocks for dirt, tries additional candidates when early ones fail, and reports expansion blockers. Added a waiting countdown and clearer distinction between the active starter routine and continuous wheat production.

Added OpenAI Responses chat integration and local settings card. Replies to WalkBot mentions/whispers use current game observations, inventory and task progress. No model tools or game-command execution; bounded history, output, request rate, timeout, and session checks. API key is stored in ignored owner-only data/llm.json and excluded from browser state and model prompts. Live API verification awaits a user-configured key. Official schema: https://developers.openai.com/api/reference/cli/resources/responses/methods/create

Validation: all 117 tests passed, then an additional expansion-before-wait regression and the focused survival/chat suite passed; syntax checked 20 files. Browser verified settings and Survival-mode reconnection on LAN port 61388. User started Survive again during verification; it was gathering stone, not yet at its wheat stage. No live farm-growth or paid API success claimed.

## Dedicated FARMER skill

Added FARMER/start farmer command aliases, Start FARMER control, and explicit skill status. Productive passes continue after one second; only idle passes wait 20 seconds. Removed the overall pass deadline while retaining individual action timeouts and safety cancellation. Soil scan predicates now run before result caps. Expansion builds up to 12 ground blocks per pass, can attach to farmland and connect dirt walking lanes, preserves spaced water holes, and rejects placements that would dry existing crops. Partial dirt supplies remain usable even if gathering cannot reach its stock target. Card reports new plots and ground added.

Validation: all 122 tests pass with test concurrency 1, including live-predicate/command behavior, prompt productive continuation, farmland-supported connected ground, and irrigation preservation. Concurrent runs still occasionally fail existing swimming simulations; all 16 travel tests also passed alone. Live FARMER run verified 7 mature crops harvested/replanted and 12 additional plots planted (19 total plantings); it then began gathering dirt for new farm ground. Chest storage remains covered by fixture tests, not a confirmed live deposit in this run.

## Live map destination

Added destination coordinates and action labels to travel telemetry for block approaches, coordinate goals, moving drops, and intermediate shore staging. The map draws a pink destination crosshair and dotted direction line, marks off-view targets at the edge, and shows target height/action below the map. Only active travel in a running task renders a marker; stopping, arrival and disconnect clear it. Overlay redraws with live state even when a map selection freezes terrain refresh.

Validation: syntax checks passed; destination telemetry regression and all 17 travel tests passed standalone. Full suite had 121/122 pass, with the previously intermittent overhang swimming simulation failing; it passed on the standalone run. Restarted controller, reconnected, and resumed FARMER. Live state verified a moving-drop destination and browser verified the destination description clears after travel ends.

## Swimming, bridging, taller banks and collection

Enabled short non-sprinting gap jumps with farmland landing exclusions. Added cardinal bridge plans up to eight blocks, explicit construction staging and advancement, and supported stairs up to five-block banks (ten blocks for the tallest stair). Budget is now 16 confirmed construction blocks per route. Surface escape uses physics ticks, suppresses competing buoyancy controls under obstructions, and surfaces above the block boundary before replanning; movement keeps flotation after finishing in water.

PickupGoal follows actual entity position instead of an integer-radius approximation. Collection temporarily permits walking on farmland, excludes jumps onto crops, waits for delayed server collection, restores movement settings, and leaves deeply submerged drops to float up. FARMER counts confirmed collection events.

Validation before interruption: all 128 tests passed; final farmland jump protections also passed all 22 travel tests. Syntax checks cover 21 files. On September 13 continuation, verified the updated server process was still running, bot already connected to new LAN port 51757 in Survival mode, and resumed FARMER. Live run verified five crops harvested/replanted and ten confirmed item-stack pickups. Some block approaches remain unreachable and chest transfer confirmation warnings persist; these are not claimed resolved. Taller stairs and bridges verified in physics fixtures, not yet a complete live construction crossing.

## Skill selector and false low-air stops

Added Survive/FARMER selection and matching Start behavior/descriptions to the autonomous starter card. Root cause found in Mineflayer 4.39 entities.js: oxygenLevel and breath are updated for every entity with air_supply metadata, not only the local player. Installed a compatibility listener deriving 0–20 oxygen from WalkBot's own metadata. FARMER now uses a recoverable low-air interruption rather than permanently aborting the controller: stop navigation/digging, settle the current operation, escape/surface, restore air, continue. Polls growth waits in short cancellable slices. Other safety failures remain fatal.

Validation: all 134 tests pass, including foreign-entity oxygen contamination, low-air recovery/resumption, and Stop during recovery; syntax checks cover 23 files. Browser verified selection of FARMER and starting it from the starter card. Live controller reconnected on 51757 and resumed FARMER with corrected oxygen readings. Genuine underwater emergency recovery is covered by tests, not intentionally induced in the live world.

## Quiet OpenAI summaries and torch subskill

Removed ActionChat forwarding from Agent. LlmChat now requests a 30-second summary with current/prior semantic snapshots and recent useful INFO events; prompt demands concrete confirmed progress, terse unchanged updates, accurate blocked/idle status, and no per-walk narration. Reuses existing key/model, rate limit and timeout. Stale task/session responses are discarded. Mentions/whispers remain supported.

Added reusable getTorches and lightArea functions plus standalone TorchSkill and get torches command/selector. Uses coal/charcoal recipes, exposed coal gathering, or empty-furnace charcoal production with bounded waits and window cleanup. FARMER prioritizes lighting, places spaced torches near crops/work areas, and applies a five-minute resource retry cooldown. Existing crops, water and occupied furnaces are preserved.

Validation: all 140 tests passed; final furnace cleanup/prompt edits passed ten focused LLM/torch tests and syntax checks cover 26 files. Restarted/reconnected and resumed FARMER. Live OpenAI summary arrived successfully using saved settings: “Placed 4 torches, but shoreline farm expansion is blocked because no route to place ground was found.” Live status confirmed torch placements. Some shoreline routes remain blocked; no claim that torch lighting fixes those route constraints.
