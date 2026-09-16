# Mineflayer plugin integration

## Implemented

The existing `hunt mobs` and `find ores` commands now use task-owned adapters for
`mineflayer-pvp` and `mineflayer-collectblock`. Their skill selection, bot profiles,
terrain policy, navigation ownership, storage, and cancellation still run through
Work and SkillRunner.

| Component | Implementation |
| --- | --- |
| Combat | `src/minecraft/combat.cjs`: PVP weapon data, cancellable physics-tick cooldowns, guarded aiming and offhand shield sequencing. |
| MobKiller | `src/skills/mob-killer.cjs`: adapter-backed strikes, replacement of unusable weapons, server-death evidence for kill counts. |
| Collection | `src/capabilities/block-collection.cjs`: subclass of the published `CollectBlock`, with a Work-owned executor replacing upstream `collect()` and `cancelTask()`. |
| OreFinder | `src/skills/ore-finder.cjs`: nearest-target collection in batches of up to 32 attempted eligible blocks, then rescan. |
| Eating | `src/minecraft/auto-eat.cjs`: auto-eat's ESM controller through a task-scoped bot view, with bounded confirmation and item restoration. |
| Armor | `src/minecraft/armor.cjs`: armor-manager classification, conservative upgrade selection, and verified equipment changes at resource checkpoints. |
| Tools | `src/minecraft/tools.cjs`: mineflayer-tool subclass retaining harvest predicates, modern enchantments, and shared-storage policy. |

These are selective integrations. We do not load the stock background PVP
controller or the stock collection executor. Existing pursuit already supports
bounded dynamic following and protected navigation. Reusing that implementation
avoids an additional movement owner. Crop harvesting, tree climbing, terraforming,
and general supply gathering retain their current execution paths.

No live server was restarted as part of implementation. New processes load the
adapters automatically; an already-running controller needs a restart at a safe
boundary to pick up the code.

## Dependencies

Pinned versions:

- `mineflayer-pvp`: `1.3.2`
- `mineflayer-collectblock`: `1.6.0`
- `mineflayer-auto-eat`: `5.0.3`
- `mineflayer-armor-manager`: `2.0.1`
- `mineflayer-tool`: `1.2.0` (now a direct dependency)
- Existing Mineflayer `4.39.0` and pathfinder `2.4.5` remain unchanged.

PVP depends on `mineflayer-utils@0.1.4`, which declares an old Mineflayer 2.x
runtime dependency. Its published JavaScript uses local utility modules and does
not require Mineflayer at runtime. A targeted npm override resolves that dependency
to the application's Mineflayer version. `npm ls` confirms a single deduplicated
Mineflayer/pathfinder pair. The collection adapter does not activate automatic
`mineflayer-tool` retrieval.

## Combat behavior

`MeleeCombat` uses the PVP package's exported `getAttackSpeed()` data. It rounds
fractional cooldowns upward: iron sword 13 ticks, iron axe 23, stone axe 25.
The published default timing solver floors and randomizes timing; the adapter
uses deterministic full base cooldowns instead. Pre-1.9 servers use a four-tick
interval. This covers vanilla weapon data, not custom server attribute modifiers.

Each strike:

1. Checks Work ownership, entity identity and skill policy.
2. Lowers an equipped offhand shield and waits two cancellable ticks if needed.
3. Aims through `Work.timed()`, then rechecks the live target, reach, visibility,
   current weapon, health, creeper proximity and pursuit boundary.
4. Sends one attack. After three ticks, raises the shield if the target is still
   eligible, then waits the remaining cooldown.
5. Releases shield use before returning, including on abort.

There is no perpetual attack timer. Tick listeners exist only during a bounded
wait and are removed on completion, abort or timeout. A stalled physics stream
cannot leave the task waiting forever. Concurrent strikes are rejected. Late
cleanup cannot change item use on a replacement bot or newer task.

MobKiller keeps hostile-only selection, creeper avoidance, retreat, line of sight,
hit budgets, bounded pursuit and shared weapon retrieval. It re-equips an available
replacement when a weapon becomes unusable. An unarmed recovery attempt yields
instead of spinning. Kill counts require a server `entityDead` event for the
engaged entity after our engagement has produced hits; disappearance alone no
longer counts. This confirms the target's death, not exclusive last-hit attribution.

## Collection behavior

`BlockCollection` retains the upstream target queue and its dynamic nearest-target
selection. It owns a finite candidate list, deduplicated by block coordinate, and
invokes a skill-supplied `visit` executor. It rechecks Work authority and the live
block state before each visit and after each await. It rejects concurrent collection
batches on the same bot and clears its queue before releasing ownership.

OreFinder supplies the executor. It retains exposed-ore safety checks, harvestable
tool selection, drop-specific tool restrictions, bounded approach, confirmed digging,
optional pickup, food checks, storage and handoff checkpoints. Unmineable or
cooled-down targets do not consume the batch budget. An ore replaced during a
storage trip is skipped. The next cycle rescans for newly exposed ores; collection
does not grant permission to tunnel through unrelated blocks.

The adapter overrides upstream execution because stock collection:

- changes falling-block and fluid movement protections;
- directly equips tools and digs without Work's confirmation/journal hooks;
- can retrieve tools from chests or empty inventory outside the shared storage policy;
- has waits that are not fully covered by cancellation.

The adapter never installs its own movements or opens a chest. `cancelTask()`
cancels its Work owner and waits for the current executor to settle. Physical
execution must remain in Work's bounded actions; the callback is an internal skill
API, not an arbitrary external script runner. Existing runtime isolation still
retires a connection if a side-effecting operation cannot settle safely.

### Bounded vein discovery

The subclass also provides `findFromVein()` using upstream traversal with a
per-call coordinate cache. This repairs upstream object-identity deduplication
when repeated `blockAt()` calls return fresh objects. Bounds are 1–128 blocks,
1–16 Manhattan distance, and neighbor radius 1. It only observes terrain.

OreFinder's pilot uses its existing bounded scan and does not automatically mine
all discovered vein blocks. Future callers must apply their own area, exposure,
liquid, support and tool restrictions before passing discovered blocks to collection.

## Tests and validation

### Eating, armor and tools

`ResourceWork.eat()` now maintains armor and invokes auto-eat at existing safe
checkpoints. This covers the survival workflow, resource gathering, farmers,
OreFinder, terraformer's work loop and MobKiller. It does not start an independent
idle-bot timer. Jobs extending bare `Work` can call the armor helper explicitly at
a safe boundary; their existing behavior is otherwise unchanged. All digging
through `Work.dig()` uses the tool adapter.

Auto-eat loads its pinned ESM `EatUtil` class with dynamic import. The real
controller selects food, equips it and initiates use through a Work-scoped bot
view. It retains the existing allowed-food list, hunger threshold (16), limit of
four meals per checkpoint and four-item carrot/potato/beetroot planting reserves.
Food priority is now highest food points among eligible carried items. Open
windows and cursor items defer eating and armor maintenance.

The consumption observer is registered before item use and requires both the
server's consumption acknowledgement and increased hunger, in either packet
order. Work bounds the operation to seven seconds. Stop releases use and removes
the observers immediately, without leaving an unresolved `bot.consume()` promise.
Restoring the previously held item is awaited and skipped for obsolete/cancelled
tasks. The upstream automatic tick loop, timeout observer and unawaited restoration
are not used. The utility plugin bundled as a transitive dependency is not loaded.

Armor-manager's slot classification is reused, with corrected iron/chainmail
ranking and conservative replacement rules. Upgrades must preserve every carried
enchantment on the equipped piece; worn or cursed candidates are excluded. Elytra,
equipped cursed armor and manually occupied offhands stay in place. Turtle helmets
may be replaced by a better copy of the same helmet. An empty offhand can receive a
carried shield. Equipment is checked against actual inventory slots after each
bounded operation. No delayed `playerCollect` equipment callback is installed.

The tool adapter extends the published `Tool` class and uses its redundant-equip
check. Mining-time comparisons normalize 1.21 enchantment components and ore
material tags. Harvest eligibility, durability, creative-mode restrictions,
caller predicates such as no Silk Touch, and existing tie-breaks are preserved.
The adapter verifies the selected tool in hand; automatic chest retrieval remains
disabled in favor of the existing shared-storage routines.

`test/equipment-plugins.test.cjs` exercises the actual EatUtil controller and Tool
class, server acknowledgement ordering, safe restoration, Stop during equip/use,
planting reserves, armor protection and equipment verification. Run it with the
existing item-tool, survival and work tests when modifying these adapters.

New adapter tests cover real published-library queue/vein behavior, cooldown tick
counts, stalled ticks, delayed aiming, shield cancellation, exclusive ownership,
changed targets, bounded batches, cancellation settlement and handoffs. Skill tests
cover despawn accounting, reused entity IDs, weapon replacement, new danger during
aiming, unsafe/replaced ore and batch starvation.

Run the focused tests:

```sh
node --test test/combat.test.cjs test/block-collection.test.cjs test/mob-killer.test.cjs test/ore-finder.test.cjs
```

Run the full repository gate with `npm run verify`. Live-world physics, shield
performance and throughput gains still require controlled testing with matched
terrain and equipment. Compare confirmed items/minute, travel distance, failed
routes, health lost and Stop latency. The plugin's nearest-target strategy does
not establish globally optimal routes or a measured improvement over `nearbyFirst()`.

## Upstream references

- [PVP project](https://github.com/PrismarineJS/mineflayer-pvp)
- [PVP implementation](https://github.com/PrismarineJS/mineflayer-pvp/blob/master/src/PVP.ts)
- [PVP timing solver](https://github.com/PrismarineJS/mineflayer-pvp/blob/master/src/TimingSolver.ts)
- [Collectblock project](https://github.com/PrismarineJS/mineflayer-collectblock)
- [Collection executor](https://github.com/PrismarineJS/mineflayer-collectblock/blob/master/src/CollectBlock.ts)
- [Vein traversal](https://github.com/PrismarineJS/mineflayer-collectblock/blob/master/src/BlockVeins.ts)
- [Auto-eat](https://github.com/linkle69/mineflayer-auto-eat)
- [Armor manager](https://github.com/PrismarineJS/MineflayerArmorManager)
- [Tool plugin](https://github.com/PrismarineJS/mineflayer-tool)

Implementation was checked against the pinned npm archives, not just the moving
GitHub default branches.
