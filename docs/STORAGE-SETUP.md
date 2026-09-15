# Shared Storage and Crafting setup

The revised scope and follow-on fleet work are in [the plan](STORAGE-AND-CRAFTING-PLAN.md).
This capability uses Supabase Postgres, not Supabase's object-storage buckets.

## Configure the backend

1. Select or create the Minecraft Supabase project. Do not use an unrelated production project.
2. Apply the SQL files in `supabase/migrations/` in filename order. Existing installations
   should apply every migration they have not run, including
   `202609140003_reconcile_storage.sql` for inspected recovery.
3. Copy `.env.example` to `.env` and fill the project URL and backend secret key.
   Supabase generates a world UUID automatically the first time a bot uses a world label.
   Both bots and separate controllers reuse the ID stored in `colony.worlds`.
   Use the same world label for the same Minecraft world and a different label for a new world.
   Do not use the changing LAN port as world identity.
4. Start with `npm run web`. Environment variables override `.env`. Both bots receive the same
   Colony client. The browser never receives credentials.

`COLONY_WORLDS` is no longer required. Existing mappings are supported for migration: when an
old UUID owns recorded data it is adopted into the registry; unused example UUIDs are ignored.

No configuration preserves the old standalone farming behavior. Partial configuration or an
unreachable configured database blocks shared operations; it never silently bypasses leases.
The backend must be trusted: its secret key bypasses RLS. Anonymous/browser roles have no
access to the private schema or RPC. See [Supabase's key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

## Use it

Connect in Survival mode, within 80 blocks of the storage area. Supply a few plain logs and
building materials or enroll existing stocked chests. Use the Shared storage and crafting panel
inside Commands, saved places & individual skills, or these commands:

- `scan storage`: opens up to 16 nearby chest blocks (32-block discovery radius), deduplicating double chests.
- `manage storage 10 64 -5 wood`: inspect and enroll the chest. Categories are tools, wood,
  building, food, materials and overflow. Discovered chests are observed only until enrolled.
- `create storage wood`: craft/place one chest nearby and enroll it for that category. Uses
  carried/shared ingredients and creates a table if necessary; no resource gathering.
- `store surplus`: store above the shared working-stock reserves in managed chests.
- `organize storage`: move misplaced stock into enrolled category chests. Create/enroll category
  destinations first. If a destination fills, remaining items stay in the worker's inventory.
- `craft stone_pickaxe 2`: create a durable job and immediately attempt it on the selected bot.
- `storage and crafting`: inspect, store, organize, process a queued job, then wait 20 seconds.

The queue form can submit a job while a farmer is busy. Start Storage and Crafting on an idle
bot to process it. Jobs are world/dimension scoped and claimed atomically. A failed/abandoned
job becomes blocked and is not automatically replayed. Inspect its result before submitting a
new request. Requested quantities mean new items, rounded up to Minecraft recipe batches.

Recipes include supported wood planks, sticks, chests, crafting tables, wooden/stone/iron tools,
bread and torches from available coal/charcoal. The planner can create intermediate ingredients
and place a crafting table. It does not gather missing ores, smelt iron, enchant or craft arbitrary
items. It keeps two free inventory slots for crafting and reports missing ingredients/capacity.

Tools and modified items stay carried during surplus deposits. Explicit chest organization can
move them without merging unlike metadata. Saplings, food, seeds, torches and travel blocks
have conservative retained quantities in `src/storage/policy.cjs`; recipe plans also respect
these reserves. An explicit crafted output is stored even when its category is normally retained.

Marc registers newly created farm chests and uses shared deposits/restocking. With Supabase
configured, Jerry/TreeBot stores surplus before a full inventory blocks tree work; enroll a wood
or overflow chest first. Use `create storage category` to create additional storage deliberately.
Marc can also create farm chests using his existing bounded placement helper. General storage-area
layout and expansion are future work.

Refresh stock to read current shared observations, their inspection ages, reservations and jobs.
The catalog response is bounded to 256 containers, 100 recent jobs and 100 uncertain operations;
this first version is intended for a local colony, not arbitrary-distance warehouse logistics.

## Uncertain operations and recovery

A pending inventory operation means the system cannot safely infer whether all requested items
moved. It blocks further chest access even after lease expiry. Never resolve it merely by waiting
or reissuing the same command. A human player can change a chest despite a bot lease.

1. Stop and disconnect the originating worker (shown by operation session in the catalog).
   Ensure that controller/process cannot resume an old Minecraft action.
2. Inspect the chest and the worker's carried inventory in Minecraft. Also clear any inventory
   cursor/window state. Account for partial transfers or crafted outputs.
3. Wait for the stopped worker's lease and heartbeat to expire (90 seconds), then use another
   connected bot to run `reconcile storage X Y Z` at the affected chest. The bot opens it under
   an exclusive recovery lease and saves its actual contents. Pending operations become
   `reconciled`, preserving their original intent and the inspection snapshot; no transfer is replayed.
4. Review any affected crafting job before submitting remaining work. Recovery blocks related
   jobs and releases their reservations. Restart Storage and Crafting after all affected chests
   have been reconciled.

Transfers verify both chest and player slots after closing and reopening the container. This
avoids treating Mineflayer's stale standalone player inventory as a failed transfer, and checks
fresh server contents rather than just locally predicted clicks. A real mismatch still quarantines
that chest for explicit inspection.

If a single chest becomes a double chest, splits, or moves, the old overlapping registration
is deliberately rejected. With all affected workers stopped, reconcile pending operations and
cancel/review related jobs, then remove that old container's reservations, leases and catalog row
in the SQL editor. Rescan and enroll the new topology. Automatic topology migration is deferred.
Unloaded/missing chests are never treated as empty; old observations retain their timestamps.

## Validation

`npm run check` and `npm test` run syntax and fixture tests. Real database integration checks use
an explicitly selected disposable PostgreSQL container and create/drop their own test database:

```sh
docker run --name minecraft-colony-test -e POSTGRES_HOST_AUTH_METHOD=trust -d postgres:17
COLONY_TEST_CONTAINER=minecraft-colony-test node --test test/colony-postgres.test.cjs
docker rm -f minecraft-colony-test
```

This test container exposes no host port. SQL tests cover two-worker exclusion, reservations,
world/dimension separation, uncertain transfer quarantine and backend-only permissions. Live
Minecraft verification must additionally cover real chest clicks, double-chest placement and
crafting with two connected bots. Fixture/SQL success is not a live-world verification.

## Central storage and Sam

Apply `202609140004_storage_hub.sql`, then set `storage hub X Y Z` at the chosen
storage area. This persists one destination area per world/dimension in Supabase.
All shared deposits prefer enrolled category chests within eight blocks of that point;
explicit chest creation also stays within that area. Existing remote chests remain readable.
Enroll the central chests with `manage storage ... category`; use `overflow` for mixed supplies.

Sam's `storage and crafting` loop now labels central chests, consolidates observed stock
(including previously unenrolled source chests), and keeps four pristine iron tools of each
kind in shared storage: pickaxes, axes, shovels, hoes and swords. This is a shared supply,
not automatic delivery into disconnected players' inventories. Survival-based workers try
shared stock before crafting the same tool. Insufficient materials pause replenishment.
Tools already carried by another bot are not counted as available shared stock.

Run `label storage`, `consolidate storage`, or `supply tools` separately for one pass.
Give Sam ordinary signs; he retains up to 32 and labels accessible chest faces with the
category and “Shared by all.” Labels describe categories rather than volatile item counts.
Consolidation preserves reservations and verifies each withdrawal/deposit. Empty source
chests remain in place; it does not break chests. If central storage is full, add/enroll
capacity at the hub. Sam does not automatically build another remote storage area.

## Named coordination and memory

While connected, Sam asks each connected colony bot what it does, then what it carries and
needs. These exchanges use Minecraft chat addressed by name, without requiring LLM chat.
Sam learns roles and inventory reports; workers acknowledge receipt of his central chest
locations. He checks the shared catalog for new or changed chest locations and resends
unacknowledged updates. Reconnected workers receive updates they missed.

Each bot persists world/dimension-scoped memory in its own `colony-memory.json`, including
roles, destinations, tool needs, and a five-minute return policy. Farm, tree, survival and
movement skills check that policy at safe work boundaries; workers store surplus and retrieve
missing role tools. They retain working reserves. A tree worker finishes/recoveries its climb
before returning. This is periodic work scheduling, not an interruption during a transfer.

Sam continues to manufacture the shared iron-tool buffer independently of chat. He reports
which requested tools are currently stocked and where to get them. Chat messages do not
execute arbitrary commands, and only the controller's connected fleet peers can participate
in the automatic exchange. LLM conversations include the saved memory but cannot change it.

Building supplies: normal surplus storage retains 128 per supported building material.
At fewer than eight usable blocks, active work checks storage first and aims to refill to 128,
then gathers any shortfall. Jerry's dirt-column work specifically refills dirt. An unavailable
database does not count as empty storage; unsafe or exhausted gathering reports a blocker.

Sam now expands central storage automatically when a category has fewer than four empty
slots across its central chests. He adds at most one separate chest per maintenance pass,
inside the existing eight-block hub area, then labels it. Named coordination publishes the
new location. `expand storage` runs one inspection/expansion pass explicitly. Shared chests
and crafting ingredients are tried first; a bounded nearby wood search supplies missing
chest materials when accessible. Missing materials or clear placement space is reported.
Undeposited carried tools count toward the tool buffer, preventing repeated crafting while
storage is full. Empty remote chests do not count as capacity at the central hub.


## Warehouse layout and armor (current policy)

Sam now builds new capacity as **double chests**, registering a bay only after Minecraft
confirms both south-facing halves and the combined 54-slot window. Nine fixed bays form
three rows within the eight-block hub: pairs are spaced four blocks apart, at one elevation,
with a front sign and a two-block-deep approach strip. A bounded supported floor can be added;
existing crops, chests and obstructing structures are not removed to force the layout.
Incomplete bays are saved in Sam's scoped coordinator memory and excluded from ordinary scans.
Do not register a partial single half or join an already registered legacy single chest.

Capacity planning excludes legacy single-chest capacity: it creates enough new double capacity
to hold observed stock plus at least 27 extra slots per category (or 25% of occupied slots,
whichever is larger), and 54 extra overflow slots. Up to three bays are attempted per pass.
This supersedes the earlier four-free-slot/single-chest expansion rule. New deposits favor
packed double chests; consolidation drains legacy singles into the new warehouse as room
becomes available. Old empty chest blocks are retained. A full nine-bay site requires an
explicitly larger/relocated hub design; missing materials or blocked geometry is reported.
Sam owns central warehouse construction; farmers no longer scatter single chests at that hub.

Signs use the same southern face of the canonical half of each double chest, at chest height.
Existing incorrect front text can be edited through the sign editor. Sam notifies workers via
the existing layout-revision chat exchange when new managed bays appear.

After all five tool types meet their shared targets, Sam can craft iron helmets, chestplates,
leggings and boots. He builds one of each missing piece per pass, up to four shared sets,
using actual available iron and storage capacity. Carried outputs count toward the target.
Insufficient iron is not fabricated or automatically smelted. Armor crafting does not
interrupt missing-tool replenishment, and supplying armor does not automatically equip peers.

Live verification also exposed two timing details: a double chest's partner block update can
arrive after the placed half, so registration waits for both; crafting now uses an available
crafting table for intermediate planks as well as table-required recipes. If supplied signs
run out, Sam retrieves or crafts ordinary wood signs and verifies their front text. Bays whose
floor would cover an old chest are rejected before placement. A zero-chest pending bay that
became obstructed can be replaced by another free planned bay; actual partial pairs remain
reserved for recovery.
