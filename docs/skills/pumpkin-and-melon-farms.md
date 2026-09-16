# Pumpkin and melon farmers

These are **two separate selectable skills**, available to any bot:

| Skill | Chat command | Runtime ID |
| --- | --- | --- |
| Pumpkin farmer | `farm pumpkins` or `pumpkin farmer` | `pumpkinFarm` |
| Melon farmer | `farm melons` or `melon farmer` | `melonFarm` |

Both run until Stop, with independent progress state. Their shared implementation is `src/capabilities/stem-farm.cjs`.

## Setup and behavior

Start near an existing patch or clear dirt, grass or farmland beside water. Supply the matching seeds, or pumpkins / melon slices to craft seeds from. Empty seed stock can be replenished from shared storage. A hoe is needed to till new plots; existing farmland needs no hoe. The farmer can retrieve a hoe from shared storage.

Each pass checks safety and food, harvests up to 64 matching fruits, plants up to 16 stems, and deposits surplus when a batch is ready or inventory space is low. Only fruits adjacent to the matching normal or attached stem are harvested. Standalone pumpkins or melons are left alone. Stems and other crops are never harvested by these skills.

Planting requires irrigated soil, clear space above, and an adjacent supported air cell for fruit. New stems cannot occupy a cell horizontally next to either kind of existing stem, preserving fruit lanes across both crops. The farmer does not move water, clear terrain or build new land. Growth also needs adequate in-game light; provide lighting for enclosed farms.

Seeds are made in the inventory crafting grid. Up to eight seeds are kept out of storage deposits, but can be used for planting. Pumpkin blocks and melon slices are routed as food. Storage requires configured shared storage; otherwise produce remains carried. Full inventories pause harvesting until room is available.

Productive passes repeat after one second; idle passes recheck after 20 seconds. Failed targets have a cooldown. Three consecutive error-only passes pause with a blocker. Stop and handoff cancel at safe boundaries; low air triggers recovery before farming resumes.

## Verification

`node --test test/stem-farm.test.cjs` checks separate registration/state, matching-fruit harvesting, stem preservation, changed-target revalidation, irrigation and spacing, seed recipes, shared storage, full inventories, and cancellation.

Growth layout reference: [Minecraft Wiki: Pumpkin and melon farming](https://minecraft.wiki/w/Tutorial:Pumpkin_and_Melon_farming).
