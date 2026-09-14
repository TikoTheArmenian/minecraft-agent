# Ore finder (Orin)

Orin scans loaded terrain for ore, reports what is there, mines the ore that is already exposed,
and stores raw ore batches in the shared hub. Implementation: `src/ore-finder.cjs`
(`OreFinder extends Survival`, `parseOreFinder`); tests: `test/ore-finder.test.cjs`.

## Commands

| Command | Effect |
| --- | --- |
| `find ores` / `ore finder` / `start ore finder` | All eight ores, radius 48 |
| `find ores iron`, `find ores coal iron`, `find ores lapis lazuli` | Only the named ores |
| `find ores coal within 32`, `mine ores diamond within 64` | Radius 8–64 (default 48) |

Ore names: coal, iron, copper, gold, redstone, lapis, diamond, emerald (each covers the stone and
`deepslate_` variants; Nether ores and ancient debris are ignored). Unknown ores or a radius outside
8–64 raise a clear error; unrelated text (`find oak logs`, `mine stone 16`) returns `null`.

## Cycle (continuous, until Stop)

1. **Scan**: `bot.findBlocks` for the selected ore ids within the radius and within 80 blocks of
   the start, at most 512 blocks. Each ore is **exposed** (one of its six faces is air/cave air)
   or **buried**. Published as `state.oreFinder`: `found` per ore, `exposed`, `buried`,
   `mineable`, `unsafe`, `needsTool`, `nearest` exposed position per ore, `mined` per ore,
   `stored`, `tool`, `waitingUntil`, and the current `decision`.
2. **Eat** when hunger is 16 or lower (Survival helper).
3. **Tool**: eligibility uses `block.canHarvest` through the shared `chooseTool`, never a name
   list. If the carried pickaxe cannot harvest an exposed ore, Orin fetches the lowest sufficient
   tier: wooden/stone through the Survival crafting progression, iron from shared storage
   (`storage.retrieve`) or from three carried iron ingots. A failed tool trip is retried after one
   minute; the affected ores are skipped and the decision says why.
4. **Mine** exposed, safe ores nearest-first (`work-order.nearbyFirst`) with
   `Survival.harvest`: re-approach, re-validate `safeTarget` (exposed, no lava/water neighbour,
   no sand/gravel above, never the block under the feet), server-confirmed dig, pickup. Failed
   targets cool down for two minutes. Newly exposed neighbours are mined on the next pass, so
   veins are followed naturally without tunnelling.
5. **Store** when colony storage is enabled and carried raw ore + coal reaches 32 or fewer than
   four inventory slots are free: `storage.store(this)` at a checkpoint between digs. Raw ore is
   `materials`; with no materials chest it lands in the hub overflow chest. Torches are a working
   reserve (`this.reserves = { torch: 16 }`). A deposit that moves nothing is reported as a blocker
   and retried after two minutes while mining continues.
6. **Supply checkpoint**: `agent.coordination.returnSupplies(this)` at the end of every pass
   (building-block reserve, five-minute surplus return, missing role tools from Sam's layout).
7. **Wait**: with nothing exposed and mineable, wait 20 s and rescan. Buried ores are only
   reported (v1: no blind tunnels or digging straight down). Three consecutive passes that end in
   an error without new mined or stored progress pause the task with the blocker in the decision.

## Limits and safety

- Continuous: no overall deadline, but every route, dig, equip and chest action keeps its timer.
- Stop cancels between 250 ms slices of any wait; a cancelled dig is never counted as mined.
- Health, lava, low air and nearby hostiles stop the task (Survival safety guard, every 500 ms).
- Dirt/grass are only touched for the shared building reserve and never within a farm or beside a
  chest, crafting table or furnace.
- Without colony storage nothing is stored; a full inventory pauses the task with a message.

## Live results (LAN world, harness `scripts/live-skill.cjs --bot orin`)

- Spawn scan (no tools, 60 s): `Ores within 48: copper 200, iron 116, coal 166, lapis 30 · 12 exposed
  (12 mineable), 500 buried (reported only)`; the 512-block cap was reached. Orin spawns on a
  floating smooth-stone spawn pedestal above the ocean, so every route failed with `No path`; the
  skill kept rescanning every 20 s and explained the skipped ores instead of spinning.
- Mining (`find ores coal within 24`, teleported beside the coal column at −487/−488, 65–68, 1039,
  stone pickaxe): eight `Dig coal_ore … Wait for server to confirm removal` pairs, `mined: 8`,
  `coal×8` collected, `collectedStacks: 18`; the next scan reported `0 exposed, 36 buried` and waited.
- Storage: with 40 raw iron carried the pass began with `Storing surplus (40 raw ore/coal carried …)`,
  walked to the hub, opened the overflow chest and honestly reported `Shared storage accepted no
  items` because it was full (27/27). After the shared supply checkpoint withdrew 128 building blocks
  (`retrieved: 128`), later passes stored `Store 8 coal` (`stored: 8`) and `Store 64 raw_iron`
  (`stored: 64`, raw iron 80 → 16 carried). `/bots/sam/api/storage` then listed the overflow chest
  at (−470, 65, 1060) with `raw_iron×64, coal×64` and no uncertain operations.
- A human `/tp` of Orin mid-run cancelled the task through the shared teleport guard, as intended.
  The island is ocean-bound and the only other land is a player build, so no remote `/setblock`
  site was used; `scripts/live-ore-finder.cjs` reads terrain and prints harness `--pre` lines.

## Known limitations

- Buried ores are never tunnelled to (v1 rule); low air is a fatal stop, not a surfacing routine.
- The 512-block scan cap makes dense-field counts a lower bound; hub capacity is not created
  here, a full materials/overflow chest is reported and retried.
