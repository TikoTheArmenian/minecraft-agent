# Smelter (Forge)

Forge (`fleet id forge`, type `smelter`, `src/skills/smelter.cjs`) smelts shared raw materials in furnaces
beside the storage hub and stores the output; Sam's iron-tool buffer consumes the iron ingots.

## Commands

| Command | Meaning |
| --- | --- |
| `smelt`, `smelter`, `start smelter` | Continuous mode: keep smelting whatever shared storage and inventory offer, wait 20 s when idle. |
| `smelt raw_iron 16` | One batch of a supported input (1–256 items), then finish `succeeded` with counts. |

`parseSmelter` rejects unknown inputs or quantities with a clear error and returns `null` for unrelated text.

## Recipes and fuel

`SMELTABLES` maps inputs to outputs: raw/ore iron, copper and gold to ingots, `coal_ore` to coal,
`sand`/`red_sand` to glass, `cobblestone` to stone, `clay_ball` to brick, `netherrack` to nether
brick, any log (stripped or not) to charcoal, raw beef/porkchop/chicken/mutton/cod/salmon to cooked
food, `potato` to baked potato, `kelp` to dried kelp, `wet_sponge` to sponge. Names are checked
against the connected registry. `FUEL`: coal 8, charcoal 8, coal block 80, planks and logs 1.5,
stick 0.5 smelts per item; lava buckets are never used. One smelt takes 10 s.

## One cycle

1. **Reclaim**: jobs saved in `data/forge/smelter-jobs.json` (per world/dimension) from a previous
   run are collected first, so Stop or a reconnect never orphans Forge's own items in a furnace.
2. **Stock**: `storage.list` plus `crafting.stocks` give plain shared stock minus reservations from
   fresh managed chests, and carried stock minus reserves. Up to three batches of at most 64 are
   chosen, raw ores first, then raw food, sand, clay, cobblestone, other blocks, logs last. Shared
   logs keep a floor of `LOG_FLOOR` (32). Without a colony database Forge only smelts what he carries.
3. **Furnaces**: furnace blocks within 16 blocks of the hub (`hub_get`), else within 24 of Forge.
   A lit furnace Forge did not load is someone else's and is skipped without opening; other
   furnaces are opened and used only when input, fuel and output are all empty (or hold exactly
   Forge's own job). If none is usable he walks to the hub, retrieves a furnace from storage, or
   crafts one through the durable queue (`enqueue`/`claim_job` + `crafting.execute`; 8 cobblestone),
   then places it within 8 blocks of the hub and at least two blocks from every chest, sign and
   table so chest faces stay free for Sam's labels. Failures here become a wait, not a stop.
4. **Fuel**: carried coal/charcoal first, then `storage.retrieve(['coal','charcoal'])`. With no
   coal but spare logs, he bootstraps charcoal by smelting logs with logs as fuel. Shortfalls shrink
   the batch; no fuel is a visible waiting decision. `reserves` keep 16 coal and 16 charcoal
   carried; cobblestone has no reserve for Forge because it is furnace material.
5. **Inputs**: `storage.retrieve` per input; only the confirmed carried count is loaded.
6. **Load**: approach, `openFurnace` under `timed()`, verify empty, `putInput`, `putFuel`, wait up
   to 3 s for the window slots to confirm each, close, compare the inventory delta. A failed fuel
   step takes the input back so no half-loaded furnace is left behind.
7. **Wait**: poll the furnace block once per second with `check()`; open the window only when about
   eight outputs should be ready, when the block is unlit (done or stalled), or when the limit
   (count × 10 s + 30 s) expires. `takeOutput` is confirmed through the window's player slots.
   Leftover input and fuel come back when the job ends. Up to three furnaces run at once.
8. **Store**: `storage.store(this, {fingerprint, count})` per produced output (ingots are
   `materials`, so a materials chest or overflow; cooked food goes to food), then `storage.store(this)`
   for surplus and `coordination.returnSupplies(this)` as the safe checkpoint. Forge opts out of the
   128-block building refill (`refillingBuilding = true`): he never builds, and the refill was seen
   digging up the ground around the hub once shared dirt ran out.

`agent.state.smelter` publishes `status`, `decision`, `furnaces[{x,y,z,state}]`, `active[...]`,
`smelted{output:n}`, `stored`, `fuelCarried`, `waitingUntil`; expected output is never counted early.

## Safety and cancellation

Continuous mode removes the overall deadline (`task.continuous`); a one-off job keeps
`5 min + 10 s × quantity`. Every route, window action, transfer and wait has its own limit. Stop
cancels `pause()`, `timed()` rejects, and `finally` closes the furnace window (also one arriving
late). Leaving Survival, low health/air, lava or a hostile within seven blocks stops the skill.

## Tests and live checks

`node --test --test-concurrency=1 test/smelter.test.cjs` covers parsing, batch selection (reservations,
stale chests), fuel arithmetic, occupied-furnace skipping, verified load/collect on a fake window,
cancellation closing the window, fingerprinted deposit, placement spacing and job persistence. Live:
`node --env-file-if-exists=.env scripts/live-skill.cjs --bot forge --command "smelt raw_iron 8"
--seconds 150`; confirm `stored` and `iron_ingot` in `curl -s http://127.0.0.1:4317/bots/sam/api/storage`.

## Limitations

Only ordinary furnaces (no blast furnace or smoker). Furnaces are shared by convention, not by a
lease: another player loading Forge's furnace between polls makes him abandon that job with an issue.
A furnace holding unknown items counts as occupied and is re-checked every 60 s. Inputs withdrawn for
a batch that cannot be loaded stay carried until the next surplus store.
