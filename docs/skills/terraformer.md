# Terraformer (Terra)

Terra levels one bounded rectangle of columns to a target height: blocks above the target are
cut, missing surface blocks (and up to three supports beneath them) are filled, and the job is
saved so a later `terraform` continues where it stopped. Implementation: `src/skills/terraformer.cjs`.

## Commands

| Command | Meaning |
| --- | --- |
| `flatten X1 Z1 to X2 Z2 at Y` | Level the rectangle between the two corners so its top solid block is at `Y`. Corners are normalised; at most 32×32 columns; `Y` between -60 and 300. |
| `terraform` (also `terraformer`, `start terraformer`, the Start button) | Resume the saved unfinished job for this world/dimension, or, when there is none, flatten the 9×9 square centred on Terra at her current floor level (`floor(y) − 1`). |
| Stop | Cancels immediately after the current confirmed action; the job stays saved. |

Both corners must be within 64 blocks of Terra when the job starts. Terra needs Survival mode;
Sam's role table lists `iron_shovel` + `iron_pickaxe` and 128 dirt as her supplies.

## Job flow

1. **Survey.** For every column, read the live blocks from `Y+8` down to `Y−3`. Everything
   non-air in `(Y, Y+8]` is a *cut*. If the block at `Y` is air, water or lava it is a *fill*,
   together with up to three contiguous open cells beneath it. A solid block above `Y+8` in any
   column refuses the whole job ("too tall; choose a higher target or smaller area").
2. **Protection.** Chests, barrels, furnaces, crafting tables, signs, torches, farmland, crops,
   water touching farmland, bedrock, obsidian, beds, doors, fences and gates, glass, rails and any
   block with a block entity are never touched, and every column within two columns of one is
   skipped with a reason (`plan.skipped`, at most 20 shown, `skippedCount` for the total). Columns
   with liquid above the target level or unmineable blocks are skipped too. The single commented
   constant is `PROTECTED_NAMES` / `PROTECTED_PATTERNS` in `src/skills/terraformer.cjs`.
3. **Budget.** `needFill` is the number of placements. Material comes first from the cut blocks
   (dirt, grass, stone → cobblestone, deepslate, granite…), then from shared storage: when the
   colony is enabled, the hub is within 80 blocks of the start position and cut yield plus carried
   blocks still fall short, Terra runs `storage.retrieve(BUILDING_BLOCKS, min(needFill, carried + 128))`.
   Missing iron tools are fetched from storage once as well.
4. **Cut.** Layer by layer from the top down. Within a layer, rows alternate direction and the next
   block in the row is chosen with `work-order.nearbyFirst`. Terra never digs the block she stands
   on: `approachCut` looks for a neighbouring stance (three attempts) and `Work.dig` refuses
   otherwise. Blocks beside liquid above the target are left alone so the rectangle is not flooded.
   Each layer boundary is a checkpoint for `coordination.returnSupplies` (the shared five-minute
   surplus/tool policy).
5. **Fill.** Outer ring first so each block has a support face, placed bottom-up per column with
   `watchBlock` confirmation. Reference faces are tried in order (block below, then the nearest
   solid side walls) with `FillStanceGoal`, which raycasts to the *face* rather than the block
   centre: a pit wall's centre is hidden under the surrounding surface while its face is in view.
   When Terra has dropped into the pit she is filling, she jump-places the block under her own
   feet (`jumpFill`, the tree farmer's climbing pattern) instead of searching for an outside stance.
   Dirt goes on the surface, stone types into hidden supports. Every placement re-checks support,
   reach, held item and that no entity occupies the cell.
6. **Store and finish.** With the colony enabled and the hub within 80 blocks of the start,
   surplus above the reserves (`dirt 128, cobblestone 64, cobbled_deepslate 64, stone 64`, plus the
   outstanding fill demand while filling) is deposited when fewer than four inventory slots are free
   and at the end of the job. When the colony is disabled the plan says so and nothing is stored.
   Chests are never opened directly.

Each pass re-surveys, so a finished column is verified against live blocks before it is skipped.
When cut material and storage cannot cover the remaining fills the job ends as `partial` with the
exact deficit in the decision and stays saved. Three consecutive passes without progress pause the
job as `partial` with the blocker. The overall deadline is 60 minutes; every route, dig and
placement still has its own limit.

## Persistence and state

`data/terra/terraform-jobs.json` (atomic tmp+rename) keeps one job per `${world}:${dimension}`:
area, target `Y`, verified done columns, cut/filled counts and status. Complete jobs are removed.
`agent.state.terraformer` publishes `{status, decision, area, columns, done, cut, filled, needFill,
carriedFill, skipped, skippedCount, deficit, storage, waitingUntil}`; `task.skill` is `TERRAFORMER`.

## Testing

- `node --test --test-concurrency=1 test/terraformer.test.cjs`: parser bounds, survey counts on
  fixture terrain (negative coordinates, water, deep cavities), protected buffer, too-tall
  refusal, storage budgeting and deficit, hub distance, cancellation + resume, replaced jobs,
  never digging the standing block, stalled passes, ring order of fills, published state.
- `scripts/live-terraformer.cjs` connects Terra without the control room and prints the live
  height map of a rectangle, protected blocks within 48 blocks and a coarse land/water map
  (`--landscan`). Use it before and after `scripts/live-skill.cjs --bot terra --command "flatten …"`.

## Limitations

- Steep hills (two-block walls) may be unreachable without stairs; unreachable blocks are
  reported and retried on later passes, then the job pauses. Tree canopies inside the rectangle
  need a second pass: the top leaves are hidden until the lower ones are cut (seen live).
- A 1×1 pit deeper than the bot can see into from its edge is only filled after dropping in.
- Liquids above the target level are not drained or dammed; those columns are skipped.
- Gravel/sand falling into the rectangle during cuts is handled by the next pass, not predicted.
- Map-selection ("flatten the selected area on the map") needs a `world.cjs`/UI change and is not
  implemented; use the typed command.
