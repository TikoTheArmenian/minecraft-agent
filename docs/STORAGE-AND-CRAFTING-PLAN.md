# Storage and Crafting: revised implementation plan

## Goal and boundary

Give every bot a shared, world-scoped Supabase Postgres catalog, coordinated chest access,
and durable crafting requests. Minecraft is the authority; database contents are dated
observations. This implements the storage foundation from the fleet review, not an unlimited
world planner. Keep the existing one-task-per-agent lifecycle and travel/safety bounds.

The server injects a stateless Colony client into every Agent. Separate controller processes
can use the same database; no correctness depends on a shared JavaScript Map. Supabase generates world
UUIDs and resolves the shared world label atomically across changing LAN ports. Dimensions remain separate.

## Deliverables

1. Versioned SQL migration with private tables and a backend-only RPC: containers/slots,
   bot sessions, leases, inventory operations, crafting jobs and ingredient reservations.
   All coordination transactions are short; never hold a database transaction during travel.
2. Function-style storage and crafting capabilities. The new skill extends Work directly,
   avoiding Survival constructor side effects. Registry-based new skill dispatch.
3. Inspect, create and explicitly manage chests, store surplus, retrieve supplies, organize managed
   chests, and craft bounded vanilla recipes using carried and shared materials.
4. Marc uses coordinated storage when configured. TreeBot unloads before inventory blocks
   harvesting. No unmanaged/player chest is rearranged. Existing standalone farming remains
   available when Colony is not configured; configured DB errors never fall back silently.
5. Local HTTP endpoints and UI for stock freshness, locations, managed categories and job
   status; text commands remain available. Credentials never enter state, logs or the browser.
6. Tests for concurrency, stale observations, world isolation, item identity/stack limits,
   reservations, partial transfers, cancellation and recipe planning. Test the real SQL engine.

## Consistency rules

Discover within loaded terrain and bounded distance; re-read a chest after arrival. Normalize
both halves of a double chest to one key. Store slot-level fingerprints including components
and NBT. Do not merge unlike tools or use modified equipment as generic recipe ingredients.
Retain tools, planting stock, food, torches and construction supplies; route surplus by category.

Acquire expiring database leases after travel. Renew before each action. Persist an operation
intent before Minecraft mutation and commit an absolute snapshot only after inventory deltas
confirm. A lost response never causes blind replay. An unfinished mutation quarantines writes
for that chest; reconciliation requires stopping the originating session and inspecting actual
inventories. Expired jobs with possible physical effects become blocked, never auto-recrafted.
Reservations are scoped to job, chest and fingerprint and subtracted from advertised stock.
Players do not honor leases: revalidation and two-sided transfer confirmation remain required.

Recipes use the connected registry, bounded dependency depth and action count. Requested
quantity means new output (batch rounding is reported). Missing ingredients block a durable
job; no implicit mining expedition. Initial support: plain wood products, basic wooden/stone/
iron tools, bread and coal/charcoal torches. General smelting, enchanting and automatic tool
upgrades are deferred. Existing torch skill retains its charcoal behavior.

## Setup and rollout

Select the intended Supabase project before applying migrations. Configure SUPABASE_URL,
SUPABASE_SECRET_KEY in backend environment.
Apply the migration, configure both bots identically, inspect and enroll storage chests, then
run scan/store/craft. Start with real single/double chests and a known crafting table in a safe
loaded area. Exercise two bots contending for the last ingredient and reconnect after transfer.

## Follow-on work from the fleet review

Config-driven arbitrary fleet UI, global resource/tree/crop target claims, shared waypoints,
extracted legacy Survival capabilities, general goal scheduling, hostile fleeing/death recovery,
worker-per-bot execution, incremental long-distance travel and broader world memory are separate
milestones. Do not claim that this storage change solves those problems. Do not change existing
movement timeout policy without dedicated lag/cancellation measurements.

## Implementation status

Implemented in the repository: backend Colony transport and migration, skill registry,
shared storage and inventory policy, bounded recipe planner, durable crafting queue,
explicit category chest creation, farmer integration, local API and browser controls.
Full catalog reads stay outside the frequent Agent/SSE snapshots.

Validation: 203 tests passed with the PostgreSQL 17 integration suite enabled; subsequent
storage/wheat tests (38) and syntax checks passed after the final inventory-counter and
state-size adjustments. Browser checks covered skill selection, panel layout, missing setup
feedback and disconnected action gating. Temporary preview/test services were removed.

Supabase is configured. The automatic world registry migration is deployed. Live chest
crafting, placement and registration succeeded; wood and food category chests are enrolled.

World registration is now automatic in Supabase. The registry migration was applied to the configured project and its backend connection verified.
