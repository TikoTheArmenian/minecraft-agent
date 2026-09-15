/** Mineflayer private placement boundary, verified against the pinned 4.39.0 API.
 * Callers must finish their cancellable look before using forceLook: 'ignore'.
 * These adapters neither turn nor retry and preserve the original return/promise.
 * genericPlace sends an interaction; it does not confirm a world change. Each
 * caller retains its existing server acknowledgement and postcondition checks.
 * Recheck this boundary and its installed-plugin tests when upgrading Mineflayer.
 */
const SUPPORTED_MINEFLAYER_VERSION = '4.39.0'

function invoke(bot, method, args) {
  if (typeof bot?.[method] !== 'function') {
    throw Object.assign(
      new Error(
        `Unsupported Mineflayer placement API: ${method} is unavailable. This adapter was verified with Mineflayer ${SUPPORTED_MINEFLAYER_VERSION}.`,
      ),
      {
        code: 'MINECRAFT_ADAPTER_UNSUPPORTED',
        method,
      },
    )
  }
  return Reflect.apply(bot[method], bot, args)
}

// Forward referenceBlock, faceVector and options without copying or supplying defaults.
function placeBlockWithOptions(bot, ...args) {
  return invoke(bot, '_placeBlockWithOptions', args)
}
function genericPlace(bot, ...args) {
  return invoke(bot, '_genericPlace', args)
}

module.exports = { placeBlockWithOptions, genericPlace, SUPPORTED_MINEFLAYER_VERSION }
