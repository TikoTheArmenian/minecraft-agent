# Sugarcane farmer (bot Cane)

`src/skills/sugarcane-farm.cjs` · class `SugarcaneFarm` · fleet id `cane` · command `farm sugarcane`
(aliases `sugarcane farmer`, `start sugarcane farmer`, `farm sugar cane`).

A continuous producer: it harvests grown sugar cane above the base, replants along water,
grows the patch outward, and stores surplus in the colony's shared chests. It runs until Stop.
Dashboard state is published as `agent.state.sugarcaneFarm`:
`{status, decision, columns, ready, harvested, planted, stored, cycles, waitingUntil, blocker}`.

## Why sugar cane is not wheat

Sugar cane has no seeds, no tilling and no maturity age. A plant is a vertical column; the
lowest block (the **base**) keeps growing as long as it sits on soil that touches water.
Breaking the second block drops every block above it and leaves the base to regrow, so the
skill digs **only `base.y + 1`** and never the base itself. Digging uses the shared
server-confirmed `Work.dig(pos, 'sugar_cane', predicate)`; the predicate re-reads the base
before every step so a column whose base vanished is skipped rather than destroyed.

## One cycle

1. **Observe**: `find(['sugar_cane'], 48)` limited to 80 blocks from the start position;
   `groupColumns` groups blocks into columns by base (a cane block whose support is not cane).
   `columns` and `ready` (height >= 2) are published.
2. **Safety and food**: `safety()` aborts on critical health, lava or nearby hostiles; low air is
   handled by surfacing (`recoverAir`) instead of failing, because the work area is a shoreline.
3. **Harvest**: ready bases nearest-first through `work-order.nearbyFirst`; approach, dig the
   second block, count only after the confirmed removal, then `Work.pickup`. Up to 64 per pass.
4. **Plant / expand**: candidate soil is sand, red sand, dirt, grass, podzol, coarse dirt, mud or
   rooted dirt with two air blocks above and **water touching one horizontal side of the soil**
   (the game's placement rule). Farmland is never used and nothing is planted within three
   blocks of farmland, wheat, carrots, potatoes or beetroots, so Marc's irrigated field is left
   alone. Spots beside existing cane come first, then nearest-first. Up to 16 per pass while
   more than the 8-cane reserve is carried. Each placement registers `watchBlock` with the task's
   abort signal before placing and is counted only after the server reports the new block.
5. **Store**: with the colony enabled, `storage.store(this)` runs once carried cane reaches
   32 + reserve or fewer than four inventory slots are free. `this.reserves = { sugar_cane: 8 }`
   keeps planting stock out of deposits. Sugar cane is a `materials` item, so it goes to a
   materials chest or the hub's overflow chest. A deposit that moves nothing is recorded as an
   obstacle and retried a minute later; `stored` only counts confirmed transfers. With the
   colony disabled the decision says storage is skipped.
6. **Supplies**: below the reserve, `storage.retrieve(this, ['sugar_cane'], 16)` is tried (at most
   once a minute) before waiting. `agent.coordination.returnSupplies(this)` runs at the end of
   every cycle as the safe checkpoint (shared reserve policy, building blocks, role tools).
7. **Wait** only when the pass produced nothing: `waitingUntil = now + 20 s`, then re-observe.
   Productive passes continue after one second.

Failed targets rest for 60 seconds. Three consecutive passes that only produced errors pause
the task with the blocker (`status: partial`), like the tree farmer's stalled-pass rule.
Stop cancels immediately through `check()`/`pause()`; `finally` clears controls and restores
the agent's base movements.

## Live verification (2026-09-14, world "Agent Playground")

The world is open ocean around the built base, so a 5x3 dirt/sand strip was placed 110 blocks
north of the hub (x -467..-463, y 62, z 949..951) with three two-high columns. A 200-second run:
`3 harvested, 8 planted, 0 stored`; a follow-up scan showed all three harvested bases still
present (`sugar_cane` age 8/2/6, air above) and 11 one-block columns growing. The skill did not
dig the platform (shared `safeTarget` excludes water-adjacent soil). A second 240-second run
near the hub carried 66 cane: the first `storage.store` found every hub chest full and reported
"No managed chest ... accepted sugar cane" with `stored` still 0; after the shared checkpoint
withdrew 128 dirt from the overflow chest, the next pass deposited a verified batch
(`stored: 59`) and `/api/storage` then listed sugar cane in the overflow chest at -470 65 1060.
Two of the four base-area columns were harvested with their bases kept; the other two were
unreachable from that side and rested on cooldown.

## Limitations

- Storage needs a managed materials or overflow chest with free space within 8 blocks of the
  hub and 80 blocks of Cane's start; expansion is Sam's job, not this skill's.
- Cane does not build shorelines or place water. It plants only where water already touches
  accepted soil.
- Growth takes about 18 game minutes per block, so most passes are waiting passes.
- `scripts/live-sugarcane.cjs` is a read-only scan helper for checking columns, plantable soil
  and specific blocks on the live world.
