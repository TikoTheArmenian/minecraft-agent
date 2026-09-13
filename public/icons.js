// Inventory item icons drawn from the real Minecraft 1.21.1 textures in /textures
// (extracted from the installed client jar by scripts/extract-textures.cjs). Block items
// are three CSS-transformed faces of the actual block textures; other items use their
// inventory sprite. Until the manifest loads, or when it is missing, icons show a
// labelled tile so the inventory remains readable.
(() => {
  let manifest = null, settled = false
  const create = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el }
  const label = name => String(name || '').replaceAll('_', ' ')
  const initials = name => label(name).split(' ').filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || '?'

  const images = new Map()
  const loadImage = file => {
    if (!images.has(file)) images.set(file, new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = `/textures/${file}` }))
    return images.get(file)
  }
  // A face is either a sprite file name or a set of atlas crops drawn onto a small canvas.
  function face(cls, spec, tint) {
    const el = create('span', 'face ' + cls)
    if (typeof spec === 'string') el.style.setProperty('--img', `url("/textures/${spec}")`)
    else {
      const canvas = document.createElement('canvas')
      canvas.width = spec.size[0]; canvas.height = spec.size[1]
      el.append(canvas)
      loadImage(spec.file).then(img => {
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false
        for (const [sx, sy, sw, sh, dx, dy] of spec.draw) ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh)
      }).catch(() => {})
    }
    if (tint) { el.classList.add('tinted'); el.style.setProperty('--tint', tint) }
    return el
  }
  function paint(el) {
    const name = el.dataset.item, entry = manifest?.items?.[name]
    el.replaceChildren()
    el.classList.remove('cube', 'flat', 'missing', 'pending')
    if (!entry) { el.classList.add(settled ? 'missing' : 'pending'); el.textContent = settled ? initials(name) : ''; return }
    if (entry.type === 'cube') {
      const cube = create('span', 'cube')
      cube.style.setProperty('--w', entry.w ?? 1)
      cube.style.setProperty('--h', entry.h ?? 1)
      cube.style.setProperty('--d', entry.d ?? 1)
      cube.append(face('top', entry.top, entry.tintTop), face('front', entry.front ?? entry.side, entry.tintSide), face('right', entry.side, entry.tintSide))
      el.append(cube)
      el.classList.add('cube')
    } else {
      for (const layer of entry.layers) el.append(face('layer', layer, entry.tint))
      el.classList.add('flat')
    }
  }
  // Returns a decorative icon element; the item name stays in the surrounding text.
  function icon(name) {
    const el = create('span', 'item-icon')
    el.dataset.item = name
    el.setAttribute('aria-hidden', 'true')
    paint(el)
    return el
  }
  // A compact "icon + name × count" chip used by the sidebar and skills panels.
  function chip(item) {
    const el = create('span', 'inventory-chip' + (item.equipped ? ' equipped' : ''))
    el.append(icon(item.name), create('span', undefined, `${item.displayName || label(item.name)} × ${item.count}`))
    if (item.enchantments?.length) el.title = item.enchantments.map(e => `${label(e.name)} ${e.lvl ?? e.level ?? ''}`.trim()).join(', ')
    return el
  }
  fetch('/textures/manifest.json', { cache: 'force-cache' })
    .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
    .then(data => { manifest = data })
    .catch(() => { manifest = null })
    .finally(() => { settled = true; document.querySelectorAll('.item-icon').forEach(paint) })
  window.MarcIcons = { icon, chip, label, ready: () => settled, available: () => Boolean(manifest) }
})()
