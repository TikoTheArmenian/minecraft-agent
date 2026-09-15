/** Task-owned melee mechanics using mineflayer-pvp's weapon data.
 * Pursuit and target policy stay in the skill. No background attack loop can
 * outlive Work, and every delayed look/shield action rechecks its authority.
 */
const { getAttackSpeed } = require('mineflayer-pvp')

function attackTicks(bot) {
  if (bot.supportFeature?.('hasAttackCooldown') === false) return 4
  // Upstream getCooldown floors fractional ticks and its default solver adds
  // jitter. Round up instead so axes and swords get their full base cooldown.
  return Math.ceil(20 / getAttackSpeed(bot.heldItem?.name))
}

function waitTicks(work, ticks) {
  return work.timed(
    () =>
      new Promise((resolve, reject) => {
        const signal = work.controller.signal
        const finish = (error) => {
          work.bot.off('physicsTick', tick)
          signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve()
        }
        const abort = () => finish(signal.reason)
        const tick = () => {
          try {
            work.check()
            if (--ticks <= 0) finish()
          } catch (error) {
            finish(error)
          }
        }
        work.bot.on('physicsTick', tick)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    Math.max(2000, ticks * 150),
    'Wait for melee cooldown',
  )
}

class MeleeCombat {
  constructor(work) {
    this.work = work
    this.busy = false
    this.shieldRaised = false
  }
  hasShield() {
    const bot = this.work.bot
    if (bot.supportFeature?.('doesntHaveOffHandSlot')) return false
    const slot = bot.getEquipmentDestSlot?.('off-hand')
    return bot.inventory.slots?.[slot]?.name === 'shield'
  }
  releaseShield() {
    const work = this.work
    if (this.shieldRaised && work.agent.bot === work.bot && work.agent.nav === work.id)
      work.bot.deactivateItem()
    this.shieldRaised = false
  }
  pauseTicks(ticks) {
    return waitTicks(this.work, ticks)
  }
  async strike(entity, { canAttack, aimPoint }) {
    const work = this.work,
      bot = work.bot
    work.check()
    if (this.busy) throw new Error('A melee action already owns this task.')
    this.busy = true
    const permitted = () => {
      work.check()
      // Identity matters: an entity ID may be reused after despawn.
      return bot.entities[entity.id] === entity && canAttack(entity)
    }
    const abort = () => this.releaseShield()
    work.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      if (!permitted()) return false
      const shield = this.hasShield()
      if (shield) {
        bot.deactivateItem()
        await this.pauseTicks(2)
        if (!permitted()) return false
      }
      await work.timed(() => bot.lookAt(aimPoint(entity), true), 1500, 'Aim at hostile mob')
      if (!permitted()) return false
      const cooldown = attackTicks(bot)
      bot.attack(entity)
      if (shield) {
        await this.pauseTicks(3)
        if (permitted() && this.hasShield()) {
          this.shieldRaised = true
          bot.activateItem(true)
        }
        await this.pauseTicks(Math.max(1, cooldown - 3))
      } else await this.pauseTicks(cooldown)
      return true
    } finally {
      work.controller.signal.removeEventListener('abort', abort)
      this.releaseShield()
      this.busy = false
    }
  }
}

module.exports = { MeleeCombat, attackTicks, waitTicks }
