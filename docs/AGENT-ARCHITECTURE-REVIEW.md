# Architecture review: preparing the fleet for per-bot LLM supervisors

Reviewed September 14, 2026. Local baseline: `fda48b6`. Mindcraft baseline: [`5f3acc87b479864124173de444f31fa5538f94a6`](https://github.com/mindcraft-bots/mindcraft/tree/5f3acc87b479864124173de444f31fa5538f94a6), the `develop` checkout retrieved for this review.

This is the historical source review and offline validation report, before implementation. Its local paths and line references describe that baseline. The findings were subsequently addressed; see [the implemented runtime](AGENT-RUNTIME.md) and [current source layout](CODE-GUIDE.md#source-layout). The original design and implementation sequence are in [AGENT-ARCHITECTURE-PLAN.md](AGENT-ARCHITECTURE-PLAN.md).

## Recommendation

Keep this project and evolve its existing runtime. Mindcraft is a useful reference for putting an LLM above Minecraft skills, but adopting its codebase or executor would discard important protections already present here.

The desired design is one supervisor per bot, with its own objective, model configuration, inbox, and memory. Each supervisor selects bounded work through the same validated interface as human commands. A deterministic runtime owns movement, inventory actions, cancellation, recovery, and confirmed results. The supervisor can communicate while a skill runs; changing physical work requires the runtime to complete the handoff.

The project has a credible foundation, but it is not yet ready for unattended LLM-driven switching. The biggest gaps are inconsistent command entry points, workflow inheritance, incomplete durable job tracking, and the absence of a common result and handoff contract. Moving files into folders alone would leave those issues intact.

## What is already worth preserving

| Foundation | Evidence | Why it matters |
| --- | --- | --- |
| One active work owner per player | [agent.cjs](../src/agent.cjs), lines 379–410 and 481–575 | Stop invalidates callbacks; a queued replacement starts after the current work promise settles. |
| Stale-session protection | [agent.cjs](../src/agent.cjs), lines 86–89, 280–369; [work.cjs](../src/work.cjs), lines 152–178 | Connection, spawn, and task identity prevent old actions from belonging to a new session. Extend this to model decisions. |
| Bounded action cancellation | [work.cjs](../src/work.cjs), lines 198–285 | Timeouts and cancellation include a cleanup grace period. An unresolved side effect retires its socket instead of releasing a live competing action. |
| Minecraft confirmation | [block-updates.cjs](../src/block-updates.cjs); [work.cjs](../src/work.cjs), lines 310–361 | Local prediction is separated from server-confirmed block changes. An LLM needs that distinction in its results. |
| Shared profiles and registry | [fleet.cjs](../src/fleet.cjs); [skills.cjs](../src/skills.cjs) | Nine profiles and twelve registered skills already exist; the UI obtains their metadata from the server. |
| Shared storage coordination | [storage.cjs](../src/storage.cjs); [colony.cjs](../src/colony.cjs); [migrations](../supabase/migrations/) | Leases, reservations, operation intent, verification, and uncertain outcomes provide a stronger foundation than chat promises about inventory. |
| Existing observability | [activity-log.cjs](../src/activity-log.cjs), [api-costs.cjs](../src/api-costs.cjs), [cost-routes.cjs](../src/cost-routes.cjs) | Per-bot activity and API accounting can be extended with decision/run/message identifiers. Cost alerts currently report usage; they do not enforce spending limits. |
| Behavior tests | [test](../test/) | Fixtures cover physics, server acknowledgements, cancellation, storage, selected-bot isolation, and skill behavior. Preserve them through refactoring. |

## Lessons from Mindcraft

The recommendations in the last column are design judgments for this project, not claims that upstream implements them.

| Mindcraft mechanism | What its source actually does | Adopt or adapt here |
| --- | --- | --- |
| Command catalog | [`commands/index.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/commands/index.js) combines commands, parameter parsing/validation, execution, and generated command documentation. | Extend our registry with validated parameter and result schemas. Generate model tools and human-facing metadata from that definition. Keep text parsing at the edge. |
| Per-agent profiles | [`prompter.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/models/prompter.js) assembles profile prompts, model choices, examples, and current context. | Separate identity, preferred profession, default skill, controller model, and optional conversation model. A profession is a preference; the active skill determines working supplies. |
| Autonomous control | [`self_prompter.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/self_prompter.js) maintains an objective and active/paused/stopped states, prompts repeatedly, and restarts on idle. | Use explicit supervisor state and event-driven decisions. Decide after a goal change, meaningful blocker, milestone, completion, or relevant message. Productive continuous skills should not cause repeated model calls. |
| Immediate reactions | [`modes.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/modes.js) provides ordered reactive behaviors such as self-preservation, with interruption policies. | Keep air recovery, eating, and emergency reactions deterministic. Route physical reactions through the same ownership mechanism as skills. Preserve different combat and farming policies. |
| Peer conversations | [`conversation.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/conversation.js#L143-L195) tracks conversations and response timing; bot messages go through its MindServer proxy. Public “To …” chat can be an optional display echo. | Introduce message identity, recipient, channel, expiry, reply correlation, and delivery status. Implement real Minecraft public chat and whispers explicitly for the requested behavior. Internal delivery and an in-game echo must not both trigger the same decision. |
| Bounded memory | [`history.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/history.js) separates recent turns, summarized memory, saved state, and fuller history. | Keep bounded recent dialogue, but store objectives, checkpoints, and observed facts structurally. A prose summary cannot be the authority on whether a furnace was loaded or a handoff completed. |
| Process isolation | [`agent_process.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/process/agent_process.js#L13-L51) starts a Node child process per agent. | Its module-global conversation/mode state relies on isolation. Our nine agents share a process: services must be constructed per bot. Keep the current deployment initially; introduce processes later if profiling or fault isolation requires them. |
| Task evaluation | [`tasks/tasks.js`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/tasks/tasks.js) supports tasks with explicit setup and success checks. | Add repeatable multi-bot scenarios with measured outcomes. Keep world setup and inventory-reset commands inside a disposable test-world harness. |

Several upstream details should shape what we avoid copying:

- **Text output is not a result contract.** [`runAsAction`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/commands/actions.js#L6-L23) discards the underlying return value. [`ActionManager`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/action_manager.js#L104-L125) returns `success: true` when its callback resolves, alongside interruption/timeout flags. Our supervisor needs confirmed, typed effects and explicit partial/blocked outcomes.
- **Restarting a function is not durable resumption.** The upstream [resume mechanism](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/action_manager.js#L39-L57) retains an in-memory callback. Our tree, terrain, furnace, and transfer jobs need checkpoints validated against the actual world after restart.
- **Stop must include the supervisor.** Upstream [`!stop`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/commands/actions.js#L54-L64) explicitly leaves self-prompting active. Here a human Stop should inhibit new autonomous work until explicitly resumed.
- **Generated execution is a separate feature.** Upstream [`!newAction`](https://github.com/mindcraft-bots/mindcraft/blob/5f3acc87b479864124173de444f31fa5538f94a6/src/agent/commands/actions.js#L28-L50) can generate code when enabled. The requested standardized skills work well with a fixed, reviewed registry; runtime code generation adds no necessary foundation capability.

## Current defects and reproducible inconsistencies

These are distinct from future architecture requirements. The reproductions used real local methods with simulated surrounding Minecraft operations; they did not connect to a live world.

### 1. Furnace ownership is recorded after the side effects it must recover

**High priority before automatic switching.** [smelter.cjs](../src/smelter.cjs), lines 572–614, loads input and fuel, closes the window, and performs a cancellable pause before adding and persisting the job. A cancellation during this sequence can leave items in a furnace without tracked ownership.

Targeted reproduction: cancel at the post-load pause. Result: `CANCELLED`, furnace contents `8 raw_iron + 1 coal`, tracked jobs `0`. On a subsequent run, the untracked lit/nonempty furnace is treated as occupied (lines 469–482). This is loss of automatic recovery information, not proof that the Minecraft items disappeared.

Fix direction: persist a recoverable load intent before the first transfer, advance it after confirmations, and reconcile interrupted/uncertain states. If the required durable record cannot be written, do not initiate an untracked transfer. Reuse the storage operation model.

### 2. Reclaimed output of a different item can satisfy a new smelting order

**High priority before supervisors consume success.** [smelter.cjs](../src/smelter.cjs), lines 267–297 and 319–326, aggregates reclaimed output into an untyped `produced` count.

Targeted reproduction: a saved iron job yields eight ingots while a new request is `smelt sand 8`. The real run reports `succeeded` and “Smelted 8 sand → glass,” although the simulated output was `{iron_ingot: 8}`.

Fix direction: track confirmed output by item and request/job identity. Recovering an earlier order is useful work, but must not discharge an unrelated objective. Define explicitly whether preexisting output of the same item satisfies “obtain” versus “produce new” requests.

### 3. Bare start ignores five fleet defaults

**Behavioral defect.** [agent.cjs](../src/agent.cjs), line 547, recognizes default skills for Jerry, Barneett, and Sam, then falls back to wheat farming. It does not consult the profile default in [fleet.cjs](../src/fleet.cjs), lines 14–18.

Targeted calls to `controlSkill({type: 'startSkill'})` with no previous skill selected `wheatFarm` for Orin, Cane, Knight, Terra, and Forge. The browser's explicit default-skill button follows a different path and can work correctly, hiding the inconsistency.

Fix direction: resolve the complete default invocation from the injected profile and retain the last validated invocation, including parameters where meaningful.

### 4. Web, public chat, and whisper do not accept the same commands

**Behavioral defect.** [skill-chat.cjs](../src/skill-chat.cjs), lines 9–13 and 20–31, recognizes skill aliases and specially handles Exchange. It does not route general parameterized commands through [skills.cjs](../src/skills.cjs), lines 154–162. [agent.cjs](../src/agent.cjs), lines 576–608, has another parsing path for web input.

| Input | Current result |
| --- | --- |
| Web: `smelt raw_iron 16` | Parses as a parameterized smelter command. |
| Public: `Forge, smelt raw_iron 16` | Not recognized by the in-game command handler; can fall through to informational LLM chat. |
| Whisper to Forge: `smelt raw_iron 16` | Same missing parameterized control path. |
| `start smelt raw_iron 16` or `switch to smelt raw_iron 16` | Not resolved as a parameterized skill invocation by the control parser. |

Fix direction: normalize addressing/channel first; parse one canonical command; validate the same invocation for every source. Preserve source identity so a peer request does not inherit human command authority.

### 5. A partial storage announcement can receive a full-revision acknowledgement

**Reliability defect.** [colony-chat.cjs](../src/colony-chat.cjs), lines 62–67, accepts any nonempty staged location list and acknowledges the supplied revision without verifying completeness. The sender computes its revision over the complete list at lines 93–96. Its bounded queue can silently omit messages at lines 39–42.

Targeted reproduction: announce a revision for two locations, deliver one location and the final commit line. Result: expected locations `2`, accepted locations `1`, acknowledged `true`. This demonstrates protocol behavior under an incomplete delivery; it does not establish that live packet loss occurred.

Fix direction: include expected part count and payload digest, verify before committing, correlate acknowledgements, expire incomplete batches, and report queue overflow. A successful chat send is not proof that the recipient committed the complete update.

## Architectural gaps to address

### Runnable workflows also act as shared libraries

[Survival](../src/survival.cjs), lines 54–73, both provides inventory/crafting/gathering helpers and initializes a specific starter workflow in `agent.state.survival`. Subclasses such as [WheatFarm](../src/wheat-farm.cjs), lines 18–38, save and restore that state after `super()`. [Terraformer](../src/terraformer.cjs), lines 164–174, bypasses the inherited check and replaces “Marc” in inherited safety text.

The coupling also points upward: Survival imports WheatFarm prototype methods to expand a field (lines 774–779), even though WheatFarm inherits Survival. Static relative-require inspection found that cycle, a related cycle through Torches, and a Storage/WarehouseLayout cycle. Some imports are lazy; this is evidence of unclear layering, not proof of an import-time failure.

Extract reusable capabilities by behavior: inventory, gathering, crafting, crop preparation, safety, and confirmed interaction. Make Survive an ordinary composed skill. Preserve the shared runtime/cancellation context when one skill calls a capability.

### Settled actions do not necessarily leave the bot at a good handoff point

Current switching waits for asynchronous settlement, which protects exclusive ownership. It does not guarantee that a tree climber has descended or a workflow reached its checkpoint. Tree support recovery happens inside the tree cycle ([tree-farm.cjs](../src/tree-farm.cjs), lines 792–794); generic cancellation cleanup releases controls without performing that workflow recovery (lines 825–842).

Add a cooperative yield request for ordinary supervisor switches, distinct from immediate Stop. A skill must declare and reach its next safe handoff boundary within a deadline, or return a blocker. Do not describe existing cancellation as a proven overlapping-task race: its current ownership lock is valuable and should remain.

### Profiles, skills, and coordination policy are partly conflated

[colony-chat.cjs](../src/colony-chat.cjs), lines 7–16 and 32, seeds a persistent profession from the username. Tool and supply requests use that profession at lines 57–58 and 133. Switching Jerry to wheat farming does not change his working supply policy. Sam is also identified by name throughout the coordinator protocol.

Give identity, preferred profession, active skill needs, and coordinator capabilities separate fields. Derive reserves from the active invocation plus persistent obligations and baseline needs. Resolve the storage coordinator by capability. Existing manual reserve exceptions must survive the migration.

### General peer chat and peer whispers are not implemented yet

[agent.cjs](../src/agent.cjs), lines 271–279, sends public chat through the fixed ColonyChat protocol; whispers bypass it. [skill-chat.cjs](../src/skill-chat.cjs), lines 20–23, and [llm-chat.cjs](../src/llm-chat.cjs), line 100, intentionally ignore recognized fleet senders. The existing model is informational and cannot run skills (lines 155–167).

This is expected current behavior, not a defect in the informational chat feature. Adding autonomous peer communication requires a new inbox and explicit routing, not simply removing the fleet filter or enabling model commands in chat text.

### State and results lack one consumer contract

Tasks and individual skill plans expose different status words, counters, and state locations. Each workflow catches errors and publishes its own outcome. [Agent.startWork](../src/agent.cjs), lines 481–537, launches a promise but does not return a durable run handle or a standardized result. Navigation has a separate lifecycle implementation at lines 412–477.

Move lifecycle ownership into a common runner, make status/result schemas explicit, and publish a bounded view derived from runtime state. Keep display labels for humans; controllers should consume reason codes, item-specific effects, checkpoint references, and observed blockers.

### Persistence and source organization need targeted cleanup

Tree job loading, terraforming job loading, and smelter job loading handle malformed data differently. [Smelter persistence](../src/smelter.cjs), lines 214–235, reports write failure as an issue and continues. Introduce versioned stores with validated world/dimension/bot scope, atomic writes, and explicit recovery behavior. Recovery-critical writes need stronger guarantees than optional history.

The project already has sensible small modules, alongside dense implementations mixing concerns. Begin with the boundary extractions above. Add formatting and linting in an isolated change, and introduce checked contracts through JSDoc plus `checkJs`, or TypeScript at new boundaries. A whole-repository language or frontend rewrite is unnecessary for this design.

[scripts/check.cjs](../scripts/check.cjs), lines 5–13, checks only top-level JavaScript in three directories. Make it recursive before moving code into nested modules. Package scripts currently provide syntax checking and tests but no automated dependency-boundary or type checks. Documentation also drifts: the code guide still opens with Marc and Jerry; the README advertises periodic summaries while [llm-chat.cjs](../src/llm-chat.cjs), lines 1–4 and 34–35, disables their scheduling. Update those during foundation cleanup.

## Validation and limits

- `npm run check`: passed, 62 JavaScript files syntax checked.
- `npm test`: 387 tests discovered; 386 passed, zero failed, one skipped; approximately 13 seconds.
- The skipped test is the real PostgreSQL integration suite, gated by `COLONY_TEST_CONTAINER` in [colony-postgres.test.cjs](../test/colony-postgres.test.cjs), lines 7 and 36–38. This run does not verify the actual database integration.
- Targeted offline reproductions confirmed the default-start, command-routing, incomplete-announcement, and two smelter findings described above. Existing passing tests do not cover those cases.
- No live Minecraft behavior, paid model request, production database change, or upstream runtime was exercised. No claim is made that a full world scenario passed.

The next implementation should address the concrete defects first, then establish the common command, run, result, and checkpoint contracts. The [implementation plan](AGENT-ARCHITECTURE-PLAN.md) defines a staged route to that foundation and a narrow first autonomous pilot.
