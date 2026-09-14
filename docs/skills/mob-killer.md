# Mob killer (Knight)

`src/mob-killer.cjs` · class `MobKiller extends Survival` · fleet id `knight` · task label `MOB KILLER`.

## Commands

`hunt mobs`, `kill mobs`, `guard here`, `mob killer`, `start mob killer`, each optionally followed by
`within N` (N = 8–48 blocks, default 24). `parseMobKiller` returns `{ type: 'mobKiller', radius }` and
throws a clear error for an out-of-range radius. The bot's position when the skill starts is the
**post**; the patrol radius is measured from it.

## Cycle (continuous, until Stop)

1. **Assess health.** Health ≤ 8 → retreat toward the post (bounded 15 s route), `eat()` if food is
   carried, and wait until health ≥ 12. Health ≤ 4, lava, or air < 8 → the skill pauses with a
   message naming the bot. A nearby hostile is never a reason to stop: `safety()` is overridden.
2. **Creepers.** Never meleed. If one is within 6 blocks the bot backs off 8 blocks (toward the post
   when that leads away from the creeper) and re-evaluates.
3. **Pick a target.** Nearest entity whose `name` is in `HOSTILES` (`src/world.cjs`), not a creeper,
   alive, not on cooldown, within `radius` of the post. Anything with `type === 'player'` or a
   `username`, villagers, iron golems, wolves and passive animals are never eligible.
4. **Arm.** Best carried melee weapon by tier (netherite > diamond > iron > stone > golden > wooden),
   swords before axes, worn-out items skipped; equipped once per target. Without a weapon and with the
   colony enabled, `storage.retrieve(this, ['iron_sword'], 1)` is tried (at most every 5 minutes).
   Fists are allowed only against zombies/husks/drowned/skeletons/strays/bogged at health ≥ 16.
5. **Pursue.** `goals.GoalFollow(entity, 3)` through a bounded 8 s `Travel` attempt in optional mode
   (single attempt, no shore bridging). A 500 ms monitor clears the route when the mob is in reach,
   gone, beyond `radius + 8` from the post, a creeper approaches, or health drops to 8. Two failed
   routes with the mob within 8 blocks → hold ground for 6 s facing it (mobs usually come to us);
   otherwise a 30 s cooldown.
6. **Fight.** In reach (eye to hitbox ≤ 3.0 blocks and no block in the way): `lookAt` the upper body,
   `bot.attack(entity)`, pause 600 ms, `check()`. Per-target budget: 40 swings and 90 s.
7. **Kill accounting.** A kill counts only when the entity leaves `bot.entities` (`entityGone`) or
   the server reports `entityDead` **after** at least one of our hits. Then `Work.pickup()` runs at the
   death position and around the bot (bounded, cooled-down misses).
8. **Store.** With the colony enabled, ≥ 16 carried mob drops or fewer than 4 empty slots trigger
   `storage.store(this)` (drops use the shared policy: `reserves = {}`, so all of them are surplus).
   The hub (`hub_get`) must be within 80 blocks of the post, otherwise the trip is skipped with a
   decision note. Colony disabled → drops stay in the inventory and the decision says so once.
9. **Checkpoint and idle.** With no target and no hostile near the post,
   `agent.coordination.returnSupplies(this)` runs (surplus deposit and missing role tools); the
   building-block refill inside it is opted out via `refillingBuilding = true`, because a guard must not
   dig up the ground around its post. Then the bot walks back to the post (if > 4 blocks away),
   publishes `waitingUntil = now + 5 s`, pauses 5 s and rescans.

Self-defence: a mob already in melee reach is attacked even if it is on a soft cooldown or the bot is
recovering. Hard cooldowns (hit budget exhausted) are respected so an unkillable mob is left alone.

## Published state

`agent.state.mobKiller = { status, decision, post{x,y,z}, radius, target{name,distance}|null, weapon,
kills{zombie:n,…}, killsTotal, drops, stored, retreats, waitingUntil }`. `drops` counts mob-drop items
gained after kills (inventory delta), `stored` the items `storage.store` confirmed. `task.continuous = true`,
`task.deadlineAt = null`; every route, turn, equip and wait still has its own limit.

## Cancellation and cleanup

`check()` runs in every loop and after every await; waits use `pause()`. `run()`'s `finally` removes
the `playerCollect`/`entityGone`/`entityDead` listeners and the 500 ms safety guard, clears controls
and the pathfinder goal, and restores `agent.baseMovements`.

## Tests and live harness

`node --test --test-concurrency=1 test/mob-killer.test.cjs` covers the parser bounds, target
exclusion and nearest-first choice, weapon ranking, retreat at health ≤ 8 with self-defence, the
pursuit bound, unreachable and stubborn targets, kill counting on entity removal only, the store
trigger with a mocked `storage.store`/`hub_get`, the idle checkpoint, and Stop during a fight.

`scripts/live-mob-killer.cjs` runs one bot in the LAN world with extra combat observations. It
teleports onto a flat dry patch (`--spot x z [--survey]`, slow falling during the survey, landing
verified), refuses to summon or change difficulty within 100 blocks of another player, ends the run
if the bot is displaced, and sends `--post` cleanup lines (mob-only selectors, difficulty restore).

## Known limitations

- Ranged mobs are fought by closing in; there is no arrow dodging. Skeletons at range can wear the
  bot down and trigger retreats.
- Chasing through water is unreliable (pathfinder start nodes in deep water); the hold-ground rule
  covers mobs that swim to the bot.
- Other mobs' damage is not distinguished from ours (a kill needs one of our hits); the skill never changes the world difficulty, so in Peaceful there is nothing to hunt.
