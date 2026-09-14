# Smelter (Forge)

Forge (`fleet id forge`, skill type `smelter`, module `src/smelter.cjs`) turns shared raw materials
into finished goods in furnaces beside the storage hub and puts the output back into shared storage.
Sam's iron-tool buffer consumes the iron ingots Forge produces.

## Commands

| Command | Meaning |
| --- | --- |
| `smelt`, `smelter`, `start smelter` | Continuous mode: keep smelting whatever shared storage and inventory offer, wait 20 s when idle. |
| `smelt raw_iron 16` | One batch of a supported input (1–256 items), then finish with counts. |

`parseSmelter` rejects unknown inputs and out-of-range quantities with a clear error and returns
`null` for unrelated text, so other skills' aliases still parse.

## Recipes and fuel

`SMELTABLES` maps inputs to outputs: raw/ore iron, copper and gold to ingots, `coal_ore` to coal,
`sand`/`red_sand` to glass, `cobblestone` to stone, `clay_ball` to brick, `netherrack` to nether
brick, any log (stripped or not) to charcoal, raw beef/porkchop/chicken/mutton/cod/salmon to cooked
food, `potato` to baked potato, `kelp` to dried kelp, `wet_sponge` to sponge. Names are checked
against the connected registry. `FUEL`: coal 8, charcoal 8, coal block 80, planks and logs 1.5,
stick 0.5 smelts per item; lava buckets are never used. One smelt takes 10 s.

## One cycle

1. **Stock**: `storage.list` plus `crafting.stocks` give plain shared stock minus reservations from
   fresh managed chests, and carried stock minus reserves. Up to three batches of at most 64 are
   chosen, raw ores first, then raw food, sand, clay, cobblestone, other blocks, and logs last.
   Shared logs keep a floor of `LOG_FLOOR` (32) for chests and tools. Without a colony database
   Forge only smelts what he carries and says so.
2. **Furnaces**: furnace blocks within 16 blocks of the hub (`hub_get`), else within 24 of Forge.
   A lit furnace Forge did not load is someone else's and is skipped without opening; other
   furnaces are opened and used only when input, fuel and output are all empty (or hold exactly
   Forge's own job). If none is usable he retrieves a furnace from storage, otherwise crafts one
   through the durable queue (`enqueue`/`claim_job` + `crafting.execute`; 8 cobblestone), then
   places it within 8 blocks of the hub, at least two blocks from every chest, sign and table so
   chest faces stay free for Sam's labels. Existing furnaces are reused on later passes.
3. **Fuel**: carried coal/charcoal first, then `storage.retrieve(['coal','charcoal'])`. With no
   coal at all but spare logs, he bootstraps charcoal by smelting logs with logs as fuel. Fuel
   shortfalls shrink the batch; no fuel means a visible waiting decision. `reserves` keep 16 coal
   and 16 charcoal carried; cobblestone has no reserve for Forge (it is furnace material).
4. **Inputs**: `storage.retrieve` per input, then only the confirmed carried count is loaded.
5. **Load**: approach, `openFurnace` under `timed()`, verify empty, `putInput`, `putFuel`, read the
   slots back, close, and compare the inventory delta.
6. **Wait**: poll the furnace block once per second with `check()`; open the window only when about
   eight outputs should be ready, when the block is unlit (done or stalled), or when the limit
   (count × 10 s + 30 s) expires. `takeOutput` is confirmed through the window's player slots.
   Leftover input and fuel are taken back when the job ends. Up to three furnaces run at once.
7. **Store**: `storage.store(this, {fingerprint, count})` for each produced output (ingots are
   `materials`, so they land in a materials chest or overflow; cooked food goes to food), then
   `storage.store(this)` for surplus and `coordination.returnSupplies(this)` as the safe checkpoint.

State is published as `agent.state.smelter`: `status`, `decision`, `furnaces[{x,y,z,state}]`,
`active[{position,input,count,collected,startedAt}]`, `smelted{output:n}`, `stored`,
`fuelCarried`, `waitingUntil`. Expected output is never counted before it is collected.

## Safety and cancellation

Continuous mode removes the overall deadline (`task.continuous`), but every route, window action,
transfer and wait keeps its own limit. Stop cancels `pause()`, `timed()` rejects, and `finally`
closes the furnace window, including a window that arrives after cancellation. Leaving Survival
mode, low health, low air, lava or a hostile within seven blocks stops the skill with a message.

## Tests and live checks

`node --test --test-concurrency=1 test/smelter.test.cjs` covers parsing, batch selection with
reservations and stale chests, fuel arithmetic, skipping occupied furnaces, verified load/collect
against a fake furnace window, cancellation closing the window, deposit with the produced
fingerprint, and furnace placement spacing. Live: `node --env-file-if-exists=.env
scripts/live-skill.cjs --bot forge --command "smelt" --seconds 300 --pre "/give @s raw_iron 16"
--pre "/give @s coal 8"`; confirm the `stored` counter and `iron_ingot` in `/bots/sam/api/storage`.

## Limitations

Only ordinary furnaces (no blast furnace or smoker). Furnaces are shared by convention, not by a
lease: another player loading Forge's furnace between polls makes him abandon that job with an
issue. Inputs withdrawn for a batch that later cannot be loaded stay carried until the next store.
