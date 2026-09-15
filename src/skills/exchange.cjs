/** One bounded, jointly owned meeting. A toss is never retried after an uncertain pickup. */
const { goals } = require('mineflayer-pathfinder')
const { randomUUID } = require('node:crypto')
const { Work } = require('../runtime/work.cjs')
const { Travel, TravelMovements } = require('../navigation/travel.cjs')
const { PickupGoal } = require('../navigation/pickup-goal.cjs')
const { plain, reserve, describe } = require('../storage/policy.cjs')
const { HOSTILES } = require('../world/observations.cjs')
const { workingNeeds } = require('../messaging/colony-chat.cjs')
const { directoryFor } = require('../messaging/peer-directory.cjs')

function parseExchange(text) {
  const s = String(text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
  let m = s.match(/^(?:exchange|exchange items)(?: with ([a-z0-9_]{1,16}))?$/)
  if (m) return { type: 'exchange', peer: m[1] || null }
  m = s.match(/^give ([a-z0-9_]{1,16}) (\d+) ([a-z0-9_]+)$/)
  if (m) return { type: 'exchange', peer: m[1], give: item(m[3], m[2]) }
  m = s.match(/^give (\d+) ([a-z0-9_]+) to ([a-z0-9_]{1,16})$/)
  if (m) return { type: 'exchange', peer: m[3], give: item(m[2], m[1]) }
  m = s.match(/^trade (?:with )?([a-z0-9_]{1,16}) (\d+) ([a-z0-9_]+) for (\d+) ([a-z0-9_]+)$/)
  if (m) {
    if (m[3] === m[5]) throw new Error('Choose different items for a trade.')
    return { type: 'exchange', peer: m[1], give: item(m[3], m[2]), receive: item(m[5], m[4]) }
  }
  if (/^(give|trade|exchange)\b/.test(s))
    throw new Error(
      'Use exchange with Jerry, give Jerry 16 dirt, or trade Jerry 16 wheat for 8 oak_log (1–64 items).',
    )
  return null
}
function item(name, quantity) {
  const count = Number(quantity)
  if (!Number.isInteger(count) || count < 1 || count > 64)
    throw new Error('Exchange 1–64 items per direction.')
  return { name, count }
}
const total = (bot, name) =>
  bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + i.count, 0)
function wanted(agent, name) {
  const needs = workingNeeds(agent),
    role = needs.profession
  if (needs.supplies?.[name]) return needs.supplies[name]
  if (name === 'dirt') return reserve({ name, count: 1 }, { bot: agent.bot })
  if (name === 'torch' || name === 'bread') return 16
  if (name === 'wheat_seeds') return role === 'farmer' ? 32 : 0
  if (/_log$/.test(name)) return 16
  if (/_sapling$/.test(name)) return role === 'tree farmer' ? 8 : 0
  return 0
}
function capacity(bot, source) {
  const fingerprint = describe(source).fingerprint
  const size = source.stackSize || bot.registry.itemsByName[source.name]?.stackSize || 64
  return (
    bot.inventory.emptySlotCount() * size +
    bot.inventory
      .items()
      .filter((i) => describe(i).fingerprint === fingerprint)
      .reduce((n, i) => n + Math.max(0, size - i.count), 0)
  )
}
function validateLeg(from, to, leg, automatic = false) {
  const stocks = from.bot.inventory.items().filter((i) => i.name === leg.name)
  const source = stocks[0]
  if (!from.bot.registry.itemsByName[leg.name] || !source || total(from.bot, leg.name) < leg.count)
    throw new Error(`${from.username} does not have ${leg.count} ${leg.name}.`)
  // toss(type, metadata, count) cannot select NBT: refuse ambiguous or modified stock.
  if (stocks.some((i) => !plain(i) || describe(i).fingerprint !== describe(source).fingerprint))
    throw new Error(
      `${from.username}'s ${leg.name} has differing metadata, damage, or custom data; it stays in inventory.`,
    )
  if (capacity(to.bot, source) < leg.count)
    throw new Error(`${to.username} needs more inventory space for ${leg.name}.`)
  if (
    automatic &&
    total(from.bot, leg.name) - leg.count <
      Math.max(wanted(from, leg.name), reserve(source, { bot: from.bot }))
  )
    throw new Error(`${from.username} needs to keep its working reserve of ${leg.name}.`)
  return source
}
function offer(from, to) {
  for (const stock of from.bot.inventory.items()) {
    if (!plain(stock)) continue
    const keep = Math.max(wanted(from, stock.name), reserve(stock, { bot: from.bot }))
    const count = Math.min(
      64,
      total(from.bot, stock.name) - keep,
      wanted(to, stock.name) - total(to.bot, stock.name),
    )
    if (count <= 0) continue
    const leg = { name: stock.name, count }
    try {
      validateLeg(from, to, leg, true)
      return leg
    } catch {
      /* Check another supply. */
    }
  }
  return null
}
function plan(a, b, command) {
  const automatic = !command.give
  const give = command.give || offer(a, b),
    receive = command.receive || (automatic ? offer(b, a) : null)
  if (!give && !receive)
    throw new Error(
      'Neither bot has surplus supplies the other needs. Use give or trade to choose items explicitly.',
    )
  const legs = []
  if (give) {
    validateLeg(a, b, give, automatic)
    legs.push({ from: a, to: b, ...give })
  }
  if (receive) {
    validateLeg(b, a, receive, automatic)
    legs.push({ from: b, to: a, ...receive })
  }
  return { legs, automatic }
}
function eligible(a, b) {
  const portA = a.bot?._client?.socket?.remotePort,
    portB = b.bot?._client?.socket?.remotePort
  if (portA && portB && portA !== portB) return false
  return (
    b !== a &&
    b.state.connection === 'ready' &&
    b.bot?.game.gameMode === 'survival' &&
    a.state.world === b.state.world &&
    a.state.dimension === b.state.dimension &&
    a.bot.players?.[b.username]?.entity?.id === b.bot?.entity?.id &&
    b.bot.players?.[a.username]?.entity?.id === a.bot.entity.id &&
    a.bot.entity.position.distanceTo(b.bot.entity.position) <= 32 &&
    !b.workActive &&
    !b.bot.currentWindow &&
    !b.bot.inventory.selectedItem
  )
}
function safe(work) {
  work.check()
  const bot = work.bot
  if (
    bot.game.gameMode !== 'survival' ||
    bot.health <= 6 ||
    bot.food <= 5 ||
    bot.entity.isInLava ||
    bot.oxygenLevel < 12
  )
    throw new Error(`${work.agent.username} needs safety, food, or air before exchanging.`)
  if (
    Object.values(bot.entities || {}).some(
      (e) => HOSTILES.has(e.name) && e.position?.distanceTo(bot.entity.position) < 8,
    )
  )
    throw new Error(`A hostile mob is too close to ${work.agent.username}.`)
}
function dry(bot, p) {
  const cell = p.floored(),
    ground = bot.blockAt(cell.offset(0, -1, 0))
  return (
    ground?.boundingBox === 'block' &&
    ground.shapes?.some((s) => s[4] === 1) &&
    !/magma|cactus|campfire|leaves/.test(ground.name) &&
    [cell, cell.offset(0, 1, 0)].every((p) =>
      ['air', 'cave_air', 'void_air'].includes(bot.blockAt(p)?.name),
    )
  )
}
class Exchange extends Work {
  constructor(agent, id) {
    super(agent, id)
    this.task.skill = 'EXCHANGE'
    this.counts = { given: 0, received: 0 }
    this.session = null
    this.sync()
  }
  get outstandingOperationIds() {
    return (this.session?.records || [])
      .filter((record) => record.status !== 'planned' && record.status !== 'confirmed')
      .map((record) => record.id)
  }
  async journal(record, status) {
    const operation = {
      id: record.id,
      kind: 'exchange',
      status,
      exchangeId: this.session.id,
      from: record.from,
      to: record.to,
      item: record.name,
      count: record.count,
      fromRunId: record.fromRunId,
      toRunId: record.toRunId,
      world: this.session.world,
      dimension: this.session.dimension,
      position: record.position,
      updatedAt: Date.now(),
    }
    // Each participant can recover independently after restart. A confirmed
    // transfer cannot be followed by another leg until both records are durable.
    for (const work of this.session.works) await work.agent.runtime.saveOperation(work, operation)
  }
  cancel() {
    super.cancel()
    // Both work locks stay held until the leader has settled all side effects.
    for (const work of this.session?.works || []) {
      if (!work.controller.signal.aborted) Work.prototype.cancel.call(work)
      if (work.agent.bot === work.bot && work.agent.nav === work.id) {
        work.bot.pathfinder.setGoal(null)
        work.bot.clearControlStates()
      }
    }
  }
  publishExchange() {
    for (const w of this.session.works) {
      w.task.exchange = {
        partner: this.session.works.find((other) => other !== w)?.agent.username,
        transfers: this.session.records.map((record) => ({ ...record })),
      }
      w.agent.publish()
    }
  }
  async move(goal, label, limit = 30000) {
    await new Travel(this, limit, { optional: true }).go(goal, label)
    this.check()
  }
  verifyPair() {
    const s = this.session
    for (const work of s.works) {
      safe(work)
      if (work.agent.state.world !== s.world || work.agent.state.dimension !== s.dimension)
        throw new Error('A bot changed world or dimension.')
    }
  }
  async meet(other) {
    const destination = other.bot.entity.position.clone()
    if (!dry(other.bot, destination))
      throw new Error('The receiving bot needs to stand on dry, level ground.')
    const spots = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ]
      .map(([x, z]) => destination.floored().offset(x, 0, z))
      .filter((p) => dry(this.bot, p))
      .sort(
        (a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position),
      )
    if (!spots.length) throw new Error('No clear, dry meeting spot beside the other bot.')
    const p = spots[0]
    await this.move(new goals.GoalBlock(p.x, p.y, p.z), `Meet ${other.agent.username}`)
    this.verifyPair()
    if (
      other.bot.entity.position.distanceTo(destination) > 0.75 ||
      !dry(this.bot, this.bot.entity.position) ||
      this.bot.entity.position.distanceTo(other.bot.entity.position) > 3.5
    )
      throw new Error('The meeting positions changed or could not be reached.')
  }
  async transfer(leg) {
    this.verifyPair()
    const s = this.session,
      from = s.works.find((w) => w.agent === leg.from),
      to = s.works.find((w) => w.agent === leg.to)
    for (const w of s.works)
      if (w.bot.currentWindow || w.bot.inventory.selectedItem)
        throw new Error(`${w.agent.username} has an inventory action open.`)
    const source = validateLeg(leg.from, leg.to, leg, s.automatic)
    if (
      !dry(from.bot, from.bot.entity.position) ||
      !dry(to.bot, to.bot.entity.position) ||
      from.bot.entity.position.distanceTo(to.bot.entity.position) > 3.5
    )
      throw new Error('Both bots must be close together on dry ground before a handoff.')
    // Check the short throw corridor, not only the two standing cells.
    const start = from.bot.entity.position.offset(0, 1.2, 0),
      end = to.bot.entity.position.offset(0, 0.4, 0)
    for (let step = 0; step <= 8; step++) {
      const p = start.plus(end.minus(start).scaled(step / 8))
      if (!['air', 'cave_air', 'void_air'].includes(from.bot.blockAt(p)?.name))
        throw new Error('The handoff is obstructed. Move both bots to clear ground.')
    }
    const beforeSource = total(from.bot, leg.name),
      beforeTarget = total(to.bot, leg.name)
    const existing = new Set(Object.keys(to.bot.entities || {}).map(Number)),
      candidates = new Map(),
      collected = new Set()
    const origin = from.bot.entity.position.clone()
    let collecting = false
    const observe = (entity) => {
      if (
        !collecting ||
        existing.has(entity.id) ||
        !entity.position ||
        entity.position.distanceTo(origin) > 4
      )
        return
      let dropped
      try {
        dropped = entity.getDroppedItem?.()
      } catch {
        return
      }
      if (dropped && describe(dropped).fingerprint === describe(source).fingerprint)
        candidates.set(entity.id, entity)
    }
    const onCollect = (collector, entity) => {
      observe(entity)
      if (collector.id === to.bot.entity.id && candidates.has(entity.id)) collected.add(entity.id)
    }
    const record = {
      id: randomUUID(),
      from: leg.from.username,
      to: leg.to.username,
      name: leg.name,
      count: leg.count,
      status: 'planned',
      fromRunId: from.task.runId,
      toRunId: to.task.runId,
      position: { x: origin.x, y: origin.y, z: origin.z },
    }
    s.records.push(record)
    this.publishExchange()
    to.bot.on('playerCollect', onCollect)
    to.bot.on('entitySpawn', observe)
    to.bot.on('entityUpdate', observe)
    let failure
    try {
      from.progress(`Giving ${leg.count} ${leg.name} to ${leg.to.username}`)
      to.progress(`Receiving ${leg.count} ${leg.name} from ${leg.from.username}`)
      await from.timed(
        () => from.bot.lookAt(to.bot.entity.position.offset(0, 0.4, 0), true),
        3000,
        'Face exchange partner',
      )
      this.verifyPair()
      record.status = 'intent'
      await this.journal(record, 'intent')
      this.verifyPair()
      // From this point a cancellation can leave items on the ground: never silently retry.
      collecting = true
      record.status = 'unconfirmed'
      this.publishExchange()
      await from.timed(
        () => from.bot.toss(source.type, source.metadata ?? null, leg.count),
        5000,
        `Hand over ${leg.name}`,
      )
      const until = Date.now() + 8000
      while (Date.now() < until) {
        this.verifyPair()
        for (const entity of Object.values(to.bot.entities || {})) observe(entity)
        if (
          collected.size &&
          total(to.bot, leg.name) - beforeTarget >= leg.count &&
          beforeSource - total(from.bot, leg.name) >= leg.count
        ) {
          await this.journal(record, 'confirmed')
          record.status = 'confirmed'
          from.counts.given += leg.count
          to.counts.received += leg.count
          const effect = {
            kind: 'item_transfer',
            operationId: record.id,
            item: leg.name,
            count: leg.count,
            from: leg.from.username,
            to: leg.to.username,
            position: record.position,
          }
          from.recordEffect({ ...effect, direction: 'given' })
          to.recordEffect({ ...effect, direction: 'received' })
          from.sync()
          to.sync()
          this.publishExchange()
          return
        }
        const drop = [...candidates.values()].find((e) => to.bot.entities[e.id])
        if (drop && !collected.has(drop.id) && dry(to.bot, drop.position)) {
          // Only pursue newly observed matching drops, never unrelated nearby items.
          // Fresh tosses start above head height; wait for them to fall to dry ground.
          await to.move(
            new PickupGoal(to.bot, drop),
            `Collect ${leg.name} from ${leg.from.username}`,
            4000,
          )
        }
        await this.pause(100)
      }
      throw new Error(
        `Pickup of ${leg.count} ${leg.name} by ${leg.to.username} was not confirmed. Check both inventories and the ground before retrying.`,
      )
    } catch (error) {
      failure = error
    } finally {
      to.bot.off('playerCollect', onCollect)
      to.bot.off('entitySpawn', observe)
      to.bot.off('entityUpdate', observe)
    }
    if (record.status !== 'planned' && record.status !== 'confirmed') {
      record.status = 'uncertain'
      this.publishExchange()
      try {
        await this.journal(record, 'uncertain')
      } catch (error) {
        for (const work of s.works) work.task.reasonCode = 'REQUIRES_RECONCILIATION'
        throw Object.assign(
          new AggregateError(
            [failure, error],
            `${failure.message} Recording the uncertain handoff also failed: ${error.message}`,
            { cause: failure },
          ),
          { code: 'REQUIRES_RECONCILIATION', fatal: true },
        )
      }
    }
    throw failure
  }
  async run(command = {}) {
    const before = this.bot.pathfinder.movements
    this.bot.pathfinder.setMovements(new TravelMovements(this.bot))
    let monitor,
      leader = false
    try {
      if (command.invitation) {
        this.session = command.invitation
        this.session.works.push(this)
        this.progress(
          `Exchange agreed with ${this.session.works[0].agent.username}; waiting to meet.`,
        )
        await this.session.done
        return
      }
      safe(this)
      if (this.bot.currentWindow || this.bot.inventory.selectedItem)
        throw new Error('Close the inventory action before starting an exchange.')
      const s = (this.session = directoryFor(this.agent).requestExchange(
        this,
        command.peer,
        command,
        { eligible, plan },
      ))
      leader = true
      const chosen = s.works[1].agent
      this.publishExchange()
      this.verifyPair()
      this.agent.coordination?.say(
        chosen.username,
        `Exchange proposal: ${s.legs.map((l) => `${l.from.username} gives ${l.count} ${l.name}`).join('; ')}.`,
      )
      chosen.coordination?.say(this.agent.username, 'Agreed. Let’s meet and confirm each handoff.')
      monitor = setInterval(() => {
        try {
          this.verifyPair()
        } catch (error) {
          s.failure ||= error
          this.cancel()
        }
      }, 100)
      await this.meet(s.works[1])
      // Revalidate BOTH sides after travel, before releasing the first item.
      for (const leg of s.legs) validateLeg(leg.from, leg.to, leg, s.automatic)
      for (let i = 0; i < s.legs.length; i++) {
        if (i) await this.meet(s.works[1])
        await this.transfer(s.legs[i])
      }
      for (const w of s.works) {
        w.task.status = 'succeeded'
        w.progress(
          `Exchange complete: gave ${w.counts.given}, received ${w.counts.received} items.`,
        )
      }
      chosen.coordination?.say(this.agent.username, 'Exchange complete; all handoffs confirmed.')
    } catch (caught) {
      const error =
        caught.code === 'REQUIRES_RECONCILIATION' ? caught : this.session?.failure || caught
      const uncertain = this.outstandingOperationIds.length > 0
      const partial = uncertain || this.session?.records.some((r) => r.status === 'confirmed')
      for (const w of this.session?.works || [this]) {
        w.task.status = partial ? 'partial' : error.code === 'CANCELLED' ? 'cancelled' : 'failed'
        w.task.label = `Exchange stopped: ${error.message}${uncertain ? ' A handoff may be on the ground; check inventories before retrying.' : ''}`
        w.addIssue(w.task.label)
        w.sync()
      }
    } finally {
      clearInterval(monitor)
      if (leader) this.session.resolve()
      if (this.agent.bot === this.bot && this.agent.nav === this.id) {
        this.bot.pathfinder.setGoal(null)
        this.bot.clearControlStates()
        this.bot.pathfinder.setMovements(before)
      }
      this.agent.publish()
    }
  }
}
module.exports = { Exchange, parseExchange, plan, offer, validateLeg, eligible, total, capacity }
