/** USD per million tokens. Exact model/tier matches only; never guess a model's price. */
const VERIFIED_AT = '2026-09-14'
const SOURCE = 'https://developers.openai.com/api/docs/pricing'
const luna = { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.20 }
const rates = {
  'gpt-5.6-luna': {
    default: luna,
    flex: { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.60 },
    priority: { input: 0.40, cached: 0.04, cacheWrite: 0.50, output: 2.40 },
    fast: { input: 0.40, cached: 0.04, cacheWrite: 0.50, output: 2.40 },
  },
}
function usageOf(usage) {
  if (!usage) return null
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e9
  const input = usage.input_tokens, output = usage.output_tokens,
    cached = usage.input_tokens_details?.cached_tokens,
    cacheWrite = usage.input_tokens_details?.cache_write_tokens,
    reasoning = usage.output_tokens_details?.reasoning_tokens
  if (![input, output].every(count) || [cached, cacheWrite, reasoning].some(n => n !== undefined && !count(n)) ||
      (cached ?? 0) + (cacheWrite ?? 0) > input || (reasoning ?? 0) > output) return null
  return { input, cached: cached ?? null, cacheWrite: cacheWrite ?? null, output, reasoning: reasoning ?? null }
}
function estimate(model, tier, usage) {
  if (!usage || usage.cached === null || usage.cacheWrite === null) return { pricingStatus: 'unknown_usage', costNano: null, price: null }
  if (!Object.hasOwn(rates, model)) return { pricingStatus: 'unknown_model', costNano: null, price: null }
  if (!Object.hasOwn(rates[model], tier)) return { pricingStatus: 'unknown_tier', costNano: null, price: null }
  const long = usage.input > 272000, base = rates[model][tier]
  const price = { ...base, input: base.input * (long ? 2 : 1), cached: base.cached * (long ? 2 : 1),
    cacheWrite: base.cacheWrite * (long ? 2 : 1), output: Number((base.output * (long ? 1.5 : 1)).toFixed(6)),
    context: long ? 'long' : 'short', verifiedAt: VERIFIED_AT, source: SOURCE }
  const costNano = Math.round(((usage.input - usage.cached - usage.cacheWrite) * price.input +
    usage.cached * price.cached + usage.cacheWrite * price.cacheWrite + usage.output * price.output) * 1000)
  // Reasoning is already included in output: adding it again would double-charge.
  return { pricingStatus: 'estimated', costNano, price }
}
module.exports = { usageOf, estimate, rates, VERIFIED_AT, SOURCE }
