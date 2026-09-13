// Builds public/textures from the Minecraft 1.21.1 client jar that the launcher already
// downloaded on this Mac. Nothing is fetched from the network and the output folder is
// ignored by Git, because the textures belong to Mojang's installed game, not this repo.
//
// For every item known to minecraft-data, the item model chain from the jar decides how
// the control room should draw it:
//   - item/generated or item/handheld models -> the flat inventory sprite (layer0, layer1…)
//   - block models with a box element         -> a small three-face cube (top + two sides)
//   - block models with only crossed planes    -> the flat plant/crop texture
//   - builtin/entity models (chests, beds…)    -> the model's particle texture
//
// Usage: node scripts/extract-textures.cjs [path/to/1.21.1.jar] [--force]
// The web server also calls ensureTextures() once on startup when the folder is missing.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const VERSION = '1.21.1'
const OUTPUT = path.join(__dirname, '..', 'public', 'textures')
const MANIFEST = path.join(OUTPUT, 'manifest.json')
// Default biome colors used by the game for tinted textures (plains grass and oak foliage).
const GRASS_TINT = '#91bd59', FOLIAGE_TINT = '#77ab2f'
const LEAF_TINTS = { spruce_leaves: '#619961', birch_leaves: '#80a755' }
const CODE_TINTED = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'vine', 'lily_pad'])
const CHESTS = { chest: 'entity/chest/normal', trapped_chest: 'entity/chest/trapped', ender_chest: 'entity/chest/ender' }

function candidateJars(explicit) {
  const home = os.homedir()
  return [
    explicit,
    process.env.MINECRAFT_JAR,
    path.join(home, 'Library', 'Application Support', 'minecraft', 'versions', VERSION, `${VERSION}.jar`),
    path.join(home, 'minecraft-agent-worlds', 'versions', VERSION, `${VERSION}.jar`),
    path.join(home, '.minecraft', 'versions', VERSION, `${VERSION}.jar`),
    process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'versions', VERSION, `${VERSION}.jar`),
  ].filter(Boolean)
}

function findJar(explicit) {
  return candidateJars(explicit).find(file => { try { return fs.statSync(file).isFile() } catch { return false } })
}

function strip(ref) { return String(ref).replace(/^minecraft:/, '') }

function tintFor(name) {
  if (LEAF_TINTS[name]) return LEAF_TINTS[name]
  if (/leaves$/.test(name)) return FOLIAGE_TINT
  return GRASS_TINT
}

function extract(jar, log = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walkbot-textures-'))
  try {
    // unzip performs its own wildcard matching; no shell is involved.
    execFileSync('unzip', ['-q', '-o', jar, 'assets/minecraft/models/item/*', 'assets/minecraft/models/block/*',
      'assets/minecraft/textures/item/*', 'assets/minecraft/textures/block/*', 'assets/minecraft/textures/entity/chest/*', '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'] })
    const assets = path.join(tmp, 'assets', 'minecraft')
    const modelCache = new Map()
    const loadModel = ref => {
      ref = strip(ref)
      if (modelCache.has(ref)) return modelCache.get(ref)
      let model = null
      if (!ref.startsWith('builtin/')) {
        try { model = JSON.parse(fs.readFileSync(path.join(assets, 'models', `${ref}.json`), 'utf8')) } catch { model = null }
      }
      modelCache.set(ref, model)
      return model
    }
    // Walk the parent chain (leaf first) and merge textures so child values win.
    const resolveChain = itemName => {
      const chain = [], textures = {}
      let ref = `item/${itemName}`
      for (let depth = 0; ref && depth < 24; depth++) {
        const name = strip(ref), model = loadModel(name)
        chain.push({ name, model })
        if (!model) break
        for (const [key, value] of Object.entries(model.textures || {})) if (!(key in textures)) textures[key] = value
        ref = model.parent
      }
      const lookup = value => {
        for (let hops = 0; typeof value === 'string' && value.startsWith('#') && hops < 12; hops++) value = textures[value.slice(1)]
        return typeof value === 'string' && !value.startsWith('#') ? strip(value) : null
      }
      return { chain, textures, lookup }
    }
    const copied = new Map()
    const texture = ref => {
      // Only item/ and block/ textures are extracted; entity textures are not sprites.
      if (!ref || !/^(item|block)\/[\w./-]+$/.test(ref)) return null
      if (copied.has(ref)) return copied.get(ref)
      const source = path.join(assets, 'textures', `${ref}.png`)
      let result = null
      if (fs.existsSync(source)) {
        const target = path.join(OUTPUT, `${ref}.png`)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
        result = `${ref}.png`
      }
      copied.set(ref, result)
      return result
    }
    // Chests are drawn from their 64×64 entity atlas: lid top, then lid + base strips
    // stacked into one 14×14 face (the lid overlaps the base by one pixel in the model).
    const chestFace = (file, x) => ({ file, size: [14, 14], draw: [[x, 33, 14, 10, 0, 4], [x, 14, 14, 5, 0, 0]] })
    const chest = itemName => {
      const ref = CHESTS[itemName]
      const source = path.join(assets, 'textures', `${ref}.png`)
      if (!fs.existsSync(source)) return null
      const target = path.join(OUTPUT, `${ref}.png`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      const file = `${ref}.png`
      return { type: 'cube', w: 0.875, h: 0.875, d: 0.875, top: { file, size: [14, 14], draw: [[28, 0, 14, 14, 0, 0]] }, front: chestFace(file, 42), side: chestFace(file, 28) }
    }
    const describe = itemName => {
      if (CHESTS[itemName]) return chest(itemName)
      const { chain, textures, lookup } = resolveChain(itemName)
      if (!chain[0].model) return null
      const names = chain.map(entry => entry.name)
      if (names.some(name => /^(item\/generated|item\/handheld|builtin\/generated)/.test(name))) {
        const layers = Object.keys(textures).filter(key => /^layer\d+$/.test(key)).sort()
          .map(key => texture(lookup(textures[key]))).filter(Boolean)
        if (!layers.length) return null
        // These grayscale plant sprites are colored by game code, not by a model tintindex.
        return CODE_TINTED.has(itemName) ? { type: 'flat', layers, tint: tintFor(itemName) } : { type: 'flat', layers }
      }
      const withElements = chain.find(entry => Array.isArray(entry.model?.elements) && entry.model.elements.length)
      if (withElements) {
        const box = withElements.model.elements.map(element => {
          const size = element.to.map((value, axis) => Math.abs(value - element.from[axis]))
          return { element, size, volume: size[0] * size[1] * size[2], area: size[0] * size[1] + size[1] * size[2] + size[0] * size[2] }
        }).sort((a, b) => b.volume - a.volume || b.area - a.area)[0]
        const faces = box.element.faces || {}
        const side = faces.north || faces.south || faces.west || faces.east
        const sideTexture = texture(lookup(side?.texture))
        if (faces.up && box.size[0] >= 8 && box.size[2] >= 8 && box.size[1] >= 1) {
          const top = texture(lookup(faces.up.texture))
          if (top || sideTexture) {
            const entry = { type: 'cube', top: top || sideTexture, side: sideTexture || top }
            for (const [key, axis] of [['w', 0], ['h', 1], ['d', 2]]) if (box.size[axis] !== 16) entry[key] = Math.round(box.size[axis] / 16 * 100) / 100
            if (faces.up.tintindex !== undefined) entry.tintTop = tintFor(itemName)
            if (side?.tintindex !== undefined) entry.tintSide = tintFor(itemName)
            return entry
          }
        }
        const flat = sideTexture || texture(lookup(faces.up?.texture)) || texture(lookup(faces.down?.texture))
        if (flat) {
          const entry = { type: 'flat', layers: [flat] }
          if ((side || faces.up)?.tintindex !== undefined) entry.tint = tintFor(itemName)
          return entry
        }
      }
      const particle = texture(lookup(textures.particle))
      return particle ? { type: 'flat', layers: [particle] } : null
    }

    const registry = require('minecraft-data')(VERSION)
    fs.rmSync(OUTPUT, { recursive: true, force: true })
    fs.mkdirSync(OUTPUT, { recursive: true })
    const items = {}, missing = []
    for (const item of registry.itemsArray) {
      const entry = describe(item.name)
      if (entry) items[item.name] = entry
      else missing.push(item.name)
    }
    const manifest = { version: VERSION, generatedAt: new Date().toISOString(), source: jar, items, missing }
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest))
    log(`Item icons: ${Object.keys(items).length} of ${registry.itemsArray.length} items from ${path.basename(jar)}; ${missing.length} without a sprite.`)
    return manifest
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Creates the texture folder when it is missing. Never throws: the control room works
// without icons, it just shows labelled tiles instead.
function ensureTextures({ force = false, jar, log = () => {} } = {}) {
  try {
    if (!force && fs.existsSync(MANIFEST)) return { ok: true, existing: true }
    const found = findJar(jar)
    if (!found) {
      log(`Item icons unavailable: no Minecraft ${VERSION} client jar found. Set MINECRAFT_JAR or run: node scripts/extract-textures.cjs /path/to/${VERSION}.jar`)
      return { ok: false, reason: 'missing-jar' }
    }
    return { ok: true, manifest: extract(found, log) }
  } catch (error) {
    log(`Item icons unavailable: ${error.message}`)
    return { ok: false, reason: error.message }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const result = ensureTextures({ force: true, jar: args.find(arg => !arg.startsWith('--')), log: console.log })
  if (result.existing) console.log(`Item icons already present in ${OUTPUT}.`)
  process.exitCode = result.ok ? 0 : 1
}

module.exports = { ensureTextures, findJar, extract, OUTPUT, MANIFEST }
