# Movement research and implementation

Reviewed September 13, 2026. Baritone is a Java navigation system, not an LLM.

Primary sources:
- https://github.com/cabaletta/baritone/blob/1.19.4/FEATURES.md
- https://github.com/cabaletta/baritone/blob/1.19.4/src/main/java/baritone/behavior/PathingBehavior.java
- https://github.com/cabaletta/baritone/blob/master/src/main/java/baritone/pathing/calc/AStarPathFinder.java
- https://github.com/cabaletta/baritone/blob/master/src/main/java/baritone/pathing/path/PathExecutor.java

Baritone combines A* with segmented paths, bounded calculation, movement costs,
world caching, and execution checks. Its planner can run separately from client
movement, and it can calculate the next segment before the current one finishes.
These are architectural ideas; no Baritone source was copied into this project.

## Changes in this project

- Fixed event-loop starvation: Travel.path previously awaited skill.pause(0).
  FARMER's override performs zero loop iterations for zero milliseconds, yielding
  only a microtask. Repeated A* slices could starve physics, timers and sockets.
  Navigation now uses an abortable timer directly, with a 5 ms pause between slices.
- A* computation slices: 5 ms target; live route total search timeout: 1 second.
  These are cooperative budgets, not hard real-time guarantees: one expansion can
  exceed its budget before the library checks the clock again.
- Shore candidate scanning yields every 64 scanned columns; candidate generation
  and route probes share a 1.5 second wall-clock budget. Probes receive the remaining
  budget. The final small bridge scan remains synchronous.
- A timed-out route with meaningful progress to a safe dry-land endpoint can be
  used as an intermediate segment. The original destination is still required;
  intermediate progress never counts as task completion. Repeated endpoints and
  an eight-segment cap prevent indefinite partial-route loops.
- FARMER gives up construction for the current pass after three consecutive
  blocked approaches, allowing other work rather than trying 24 similar sites.

## Limits

This is not Baritone parity. Mineflayer still executes movement using its own
physics/pathfinder. We have not added threaded world snapshots, planning ahead,
long-distance chunk caching, arbitrary digging through obstacles, or advanced
sprint parkour. Farm protection and guarded construction remain in force.

Tests use real Mineflayer movement and Prismarine physics on synthetic terrain,
plus focused timer/cancellation and segment tests. Live terrain can still expose
navigation failures; responsiveness does not guarantee a route exists.

## Floating-island access

Added rising bridge candidates from nearby stable land. Each upward move places
an adjacent support and then the raised walking block, keeping all placements
attached to existing or previously confirmed blocks. The existing overlay route
check must reach the original goal before any construction begins. Execution
walks onto each confirmed step before extending again. Current bounds: four
blocks of rise, eight horizontal cells, and at most 16 placed blocks per route.
Unknown terrain and obstructed headroom are rejected. This does not add arbitrary
tunnelling, vertical jump-pillaring, or long-distance sky bridges. Existing mining
skills can use the resulting access route.

A real Prismarine-physics regression traverses a gap and climbs onto an island
three blocks above the departure platform, with air beneath the entire bridge.
A second regression checks reference-block support and unknown-cell rejection.
