import React, { useEffect, useMemo, useState, Component } from 'react'
import { createRoot } from 'react-dom/client'
import { cropVolume, ironBarConnections } from './volume-view.mjs'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Vector3, TextureLoader, NearestFilter, SRGBColorSpace, DoubleSide } from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
const h = React.createElement
const colors = {
  green: '#749e50',
  earth: '#896044',
  wood: '#b58a58',
  stone: '#889296',
  water: '#429cdb',
  iron: '#d7b399',
  ore: '#79baba',
  crop: '#e1c75c',
  danger: '#f47943',
  pale: '#e1d7b7',
}
// Share decoded client textures across blocks and snapshot refreshes.
const textureCache = new Map()
function loadTexture(file) {
  if (!textureCache.has(file))
    textureCache.set(
      file,
      new Promise((resolve) => {
        new TextureLoader().load(
          `/textures/${file}`,
          (texture) => {
            texture.colorSpace = SRGBColorSpace
            texture.magFilter = texture.minFilter = NearestFilter
            texture.generateMipmaps = false
            // Minecraft animation PNGs are vertical strips; display the first square frame.
            if (texture.image.height > texture.image.width) {
              const frame = texture.image.width / texture.image.height
              texture.repeat.set(1, frame)
              texture.offset.set(0, 1 - frame)
            }
            resolve(texture)
          },
          undefined,
          () => resolve(null),
        )
      }),
    )
  return textureCache.get(file)
}
function useBlockTextures(palette, manifest) {
  const [loaded, setLoaded] = useState({})
  const filesKey = JSON.stringify(
    [
      ...new Set(
        palette.flatMap((entry) => (manifest?.blocks?.[entry.name] || []).map((face) => face.file)),
      ),
    ].sort(),
  )
  useEffect(() => {
    let active = true
    Promise.all(JSON.parse(filesKey).map(async (file) => [file, await loadTexture(file)])).then(
      (entries) => {
        if (active) setLoaded(Object.fromEntries(entries))
      },
    )
    return () => {
      active = false
    }
  }, [filesKey])
  return loaded
}
class ViewBoundary extends Component {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    return this.state.error
      ? h(
          'p',
          { className: 'voxel-empty' },
          '3D is unavailable. Enable WebGL or use the top-down map below.',
        )
      : this.props.children
  }
}
function Camera({ size, reset }) {
  const { camera, gl } = useThree()
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl])
  useEffect(() => {
    controls.enableDamping = true
    controls.minDistance = 2
    controls.maxDistance = size * 5
    return () => controls.dispose()
  }, [controls, size])
  useEffect(() => {
    camera.position.set(size * 1.2, size * 0.9, size * 1.2)
    controls.target.set(0, 0, 0)
    controls.update()
  }, [camera, controls, size, reset])
  useFrame(() => controls.update())
  return null
}
// Clip each segment independently: never join waypoints across an off-screen detour.
function Route({ data }) {
  const viewport = useThree((state) => state.size)
  const line = useMemo(() => {
    const points = [],
      half = data.size / 2,
      halfY = (data.height || data.size) / 2
    const local = (p) =>
      new Vector3(
        p.x - data.origin.x - half,
        p.y - data.origin.y - halfY + 0.15,
        p.z - data.origin.z - half,
      )
    for (let i = 1; i < data.path.points.length; i++) {
      const a = local(data.path.points[i - 1]),
        b = local(data.path.points[i]),
        delta = b.clone().sub(a)
      let lo = 0,
        hi = 1
      for (const axis of ['x', 'y', 'z']) {
        const extent = axis === 'y' ? halfY : half
        if (Math.abs(delta[axis]) < 1e-9) {
          if (Math.abs(a[axis]) > extent) hi = -1
          continue
        }
        const t1 = (-extent - a[axis]) / delta[axis],
          t2 = (extent - a[axis]) / delta[axis]
        lo = Math.max(lo, Math.min(t1, t2))
        hi = Math.min(hi, Math.max(t1, t2))
      }
      if (lo <= hi)
        points.push(a.clone().addScaledVector(delta, lo), a.clone().addScaledVector(delta, hi))
    }
    const geometry = new LineSegmentsGeometry().setPositions(
      points.length ? points.flatMap((p) => p.toArray()) : [0, 0, 0, 0, 0, 0],
    )
    const material = new LineMaterial({
      color: '#ff80dc',
      linewidth: 3,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
    const result = new LineSegments2(geometry, material)
    result.visible = points.length > 0
    result.renderOrder = 10
    return result
  }, [data])
  useEffect(() => {
    line.material.resolution.set(viewport.width, viewport.height)
  }, [line, viewport])
  useEffect(
    () => () => {
      line.geometry.dispose()
      line.material.dispose()
    },
    [line],
  )
  return h('primitive', { object: line, dispose: null })
}
function Scene({ data, reset, cutaway, inspect, manifest }) {
  const textures = useBlockTextures(data.palette, manifest)
  const half = data.size / 2
  const halfY = (data.height || data.size) / 2
  const local = (p) => [
    p.x - data.origin.x - half,
    p.y - data.origin.y - halfY,
    p.z - data.origin.z - half,
  ]
  return h(
    React.Fragment,
    null,
    h('color', { attach: 'background', args: ['#101c25'] }),
    h('ambientLight', { intensity: 1.4 }),
    h('directionalLight', { position: [8, 15, 5], intensity: 2.4 }),
    h(Camera, { size: data.size, reset }),
    h('gridHelper', {
      args: [data.size, data.size, '#638193', '#304854'],
      position: [0, -halfY - 0.02, 0],
    }),
    h('axesHelper', { args: [2], position: [-half, -halfY, -half] }),
    ...data.blocks
      .filter((b) => !cutaway || b.y + data.origin.y <= Math.floor(data.center.y))
      .flatMap((b) => {
        const entry = data.palette[b.block]
        const water = entry.category === 'water'
        const shapes = water
          ? [[0, 0, 0, 1, 0.9, 1]]
          : entry.name === 'farmland'
            ? [[0, 0, 0, 1, 15 / 16, 1]]
            : b.shapes.length
              ? b.shapes
              : [[0.2, 0, 0.2, 0.8, 0.7, 0.8]]
        const faces = manifest?.blocks?.[entry.name] || Array(6).fill(null)
        const gap = water ? 0 : 0.008
        if (entry.name === 'iron_bars') {
          const map = textures[faces[0]?.file] || null
          return h(
            'group',
            {
              key: `${b.x}:${b.y}:${b.z}:bars`,
              position: [b.x - half, b.y - halfY, b.z - half],
              onClick: (e) => {
                e.stopPropagation()
                inspect(
                  `iron bars · ${b.x + data.origin.x}, ${b.y + data.origin.y}, ${b.z + data.origin.z}`,
                )
              },
            },
            h(
              'mesh',
              { position: [0.5, 0.5, 0.5] },
              h('boxGeometry', { args: [1 / 16, 1, 1 / 16] }),
              h('meshStandardMaterial', { color: '#a8a8a4', metalness: 0.35, roughness: 0.65 }),
            ),
            ...ironBarConnections(b.shapes).map((panel, i) =>
              h(
                'mesh',
                {
                  key: i,
                  position: [panel.x, 0.5, panel.z],
                  rotation: [0, panel.angle, 0],
                },
                h('planeGeometry', {
                  args: [0.5, 1],
                  onUpdate: (geometry) => {
                    const uv = geometry.attributes.uv
                    for (let vertex = 0; vertex < 4; vertex++)
                      uv.setX(vertex, panel.uv + (vertex % 2) * 0.5)
                    uv.needsUpdate = true
                  },
                }),
                h('meshStandardMaterial', {
                  key: String(Boolean(map)),
                  map,
                  side: DoubleSide,
                  alphaTest: 0.5,
                  color: map ? '#ffffff' : '#a8a8a4',
                  metalness: 0.15,
                  roughness: 0.8,
                }),
              ),
            ),
          )
        }
        // Plants and torches use upright cutouts, with no horizontal cap.
        if (
          [
            'wheat',
            'carrots',
            'potatoes',
            'beetroots',
            'nether_wart',
            'sugar_cane',
            'sweet_berry_bush',
            'short_grass',
            'tall_grass',
            'fern',
            'large_fern',
            'dead_bush',
          ].includes(entry.name) ||
          /(?:^|_)torch$/.test(entry.name)
        ) {
          const map = textures[faces[0]?.file] || null
          return [Math.PI / 4, -Math.PI / 4].map((angle, i) =>
            h(
              'mesh',
              {
                key: `${b.x}:${b.y}:${b.z}:plant:${i}`,
                position: [b.x - half + 0.5, b.y - halfY + 0.5, b.z - half + 0.5],
                rotation: [0, angle, 0],
                onClick: (e) => {
                  e.stopPropagation()
                  inspect(
                    `${entry.name.replaceAll('_', ' ')} · ${b.x + data.origin.x}, ${b.y + data.origin.y}, ${b.z + data.origin.z}`,
                  )
                },
              },
              h('planeGeometry', { args: [1, 1] }),
              h('meshStandardMaterial', {
                key: String(Boolean(map)),
                map,
                side: DoubleSide,
                alphaTest: 0.5,
                color: map ? faces[0]?.tint || '#ffffff' : colors[entry.category] || colors.crop,
                roughness: 1,
              }),
            ),
          )
        }
        return shapes.map((shape, i) =>
          h(
            'mesh',
            {
              key: `${b.x}:${b.y}:${b.z}:${i}`,
              position: [
                b.x - half + (shape[0] + shape[3]) / 2,
                b.y - halfY + (shape[1] + shape[4]) / 2,
                b.z - half + (shape[2] + shape[5]) / 2,
              ],
              onClick: (e) => {
                e.stopPropagation()
                inspect(
                  `${entry.name.replaceAll('_', ' ')} · ${b.x + data.origin.x}, ${b.y + data.origin.y}, ${b.z + data.origin.z}`,
                )
              },
            },
            h('boxGeometry', {
              args: [
                Math.max(0.02, shape[3] - shape[0] - gap),
                Math.max(0.02, shape[4] - shape[1] - gap),
                Math.max(0.02, shape[5] - shape[2] - gap),
              ],
            }),
            ...faces.map((face, index) =>
              h('meshStandardMaterial', {
                key: `${index}:${Boolean(textures[face?.file])}`,
                attach: `material-${index}`,
                map: textures[face?.file] || null,
                color: textures[face?.file]
                  ? face.tint || '#ffffff'
                  : colors[entry.category] || colors.stone,
                roughness: 1,
                alphaTest: water ? 0 : 0.1,
                transparent: water,
                opacity: water ? 0.72 : 1,
              }),
            ),
          ),
        )
      }),
    ...data.entities.map((e, i) =>
      h(
        'group',
        {
          key: i,
          position: local(e),
          onClick: (event) => {
            event.stopPropagation()
            inspect(`${e.name}${e.bot ? ' · controlled bot' : ''}`)
          },
        },
        h(
          'mesh',
          { position: [0, 0.65, 0], renderOrder: 11 },
          h('boxGeometry', { args: [0.45, 1.3, 0.45] }),
          h('meshBasicMaterial', {
            color: e.bot ? '#c6f696' : e.player ? '#7bd6ff' : e.hostile ? '#ff796b' : '#e4d9b2',
            depthTest: false,
            transparent: true,
          }),
        ),
        h(
          'mesh',
          { position: [0, 1.55, 0], renderOrder: 11 },
          h('boxGeometry', { args: [0.5, 0.5, 0.5] }),
          h('meshBasicMaterial', {
            color: e.bot ? '#c6f696' : '#7bd6ff',
            depthTest: false,
            transparent: true,
          }),
        ),
      ),
    ),
    h(Route, { data }),
  )
}
function Viewer() {
  const [manifest, setManifest] = useState(null)
  useEffect(() => {
    let active = true
    fetch('/textures/manifest.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((value) => {
        if (active) setManifest(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const [data, setData] = useState(null),
    [message, setMessage] = useState('Connect a bot to load nearby blocks.')
  const [size, setSize] = useState('11x5x11'),
    [reset, setReset] = useState(0),
    [cutaway, setCutaway] = useState(false),
    [detail, setDetail] = useState('Click a block or player to inspect it.')
  useEffect(() => {
    let disposed = false
    let state = null,
      connected = false,
      scene = '',
      generation = 0,
      controller = null
    const focus = document.getElementById('map-focus')
    const clear = () => {
      generation++
      controller?.abort()
      controller = null
      setData(null)
      setDetail('Click a block or player to inspect it.')
    }
    const refresh = async () => {
      if (!connected || state?.connection !== 'ready' || controller || document.hidden) return
      const expected = generation,
        request = new AbortController()
      controller = request
      const timer = setTimeout(() => request.abort(), 10000)
      try {
        const res = await fetch(
          botUrl(
            `/api/map/volume?focus=${encodeURIComponent(focus.value)}&size=${size.split('x')[0]}&height=${size.split('x')[1]}`,
          ),
          { signal: request.signal },
        )
        const next = await res.json()
        if (!res.ok) throw new Error(next.error || 'Map unavailable')
        if (expected !== generation) return
        setData(cropVolume(next, Number(size.split('x')[1])))
        setMessage(
          `${next.focus} · ${next.dimension} · updated ${new Date(next.at).toLocaleTimeString()}`,
        )
      } catch (error) {
        if (expected === generation) {
          setData(null)
          setMessage(
            error.name === 'AbortError' ? 'Map request timed out. Retrying…' : error.message,
          )
        }
      } finally {
        clearTimeout(timer)
        if (controller === request) controller = null
      }
    }
    const receive = (e) => {
      if (disposed) return
      state = e.detail.state
      connected = e.detail.connected
      const next = `${botUrl('')}:${state.username}:${state.world}:${state.dimension}:${state.connection}:${connected}`
      if (next !== scene) {
        scene = next
        clear()
        setReset((n) => n + 1)
        setMessage(
          connected && state.connection === 'ready'
            ? 'Loading nearby blocks…'
            : 'Connect a bot to load nearby blocks.',
        )
        refresh()
      }
    }
    const follow = () => {
      clear()
      setReset((n) => n + 1)
      setMessage('Loading nearby blocks…')
      refresh()
    }
    document.addEventListener('walkbot-state', receive)
    focus.addEventListener('change', follow)
    // The current state is also requested so mounting after the first SSE event works.
    fetch(botUrl('/api/state'))
      .then((r) => {
        if (!r.ok) throw new Error('Offline')
        return r.json()
      })
      .then((s) => {
        if (!state) receive({ detail: { state: s, connected: true } })
      })
      .catch(() => {})
    const interval = setInterval(refresh, 1000)
    return () => {
      disposed = true
      clear()
      clearInterval(interval)
      document.removeEventListener('walkbot-state', receive)
      focus.removeEventListener('change', follow)
    }
  }, [size])
  return h(
    'section',
    { className: 'voxel-view', 'aria-label': '3D surroundings' },
    h(
      'div',
      { className: 'voxel-toolbar' },
      h('strong', null, '3D surroundings'),
      h(
        'label',
        null,
        'View size ',
        h(
          'select',
          { value: size, onChange: (e) => setSize(e.target.value) },
          ...['11x5x11', '17x5x17', '7x7x7', '11x11x11', '15x15x15'].map((n) =>
            h('option', { key: n, value: n }, n.replaceAll('x', ' × ')),
          ),
        ),
      ),
      h(
        'label',
        { className: 'voxel-toggle' },
        h('input', {
          type: 'checkbox',
          checked: cutaway,
          onChange: (e) => setCutaway(e.target.checked),
        }),
        'Hide overhead blocks',
      ),
      h(
        'button',
        { className: 'secondary', onClick: () => setReset((n) => n + 1) },
        'Reset camera',
      ),
    ),
    h('p', { className: 'muted small', role: 'status' }, message),
    h(
      'div',
      {
        className: 'voxel-canvas',
        role: 'img',
        'aria-label':
          'Rotatable 3D block surroundings. Drag to orbit, scroll to zoom, right-drag to pan.',
      },
      data
        ? h(
            ViewBoundary,
            null,
            h(
              Canvas,
              {
                camera: { fov: 45, near: 0.1, far: 250 },
                dpr: [1, 2],
                fallback: h(
                  'p',
                  { className: 'voxel-empty' },
                  'WebGL unavailable. Use the top-down map below.',
                ),
              },
              h(Scene, { data, reset, cutaway, inspect: setDetail, manifest }),
            ),
          )
        : h('p', { className: 'voxel-empty' }, message),
    ),
    h(
      'p',
      { className: 'muted small' },
      'Drag to rotate · scroll / pinch to zoom · right-drag to pan · axes: X red, Y green, Z blue',
    ),
    h(
      'p',
      { className: 'voxel-legend' },
      '● Lime: bot   ● Blue: player   ━ Pink: planned path (visible through blocks)',
    ),
    h('p', { className: 'map-detail', 'aria-live': 'polite' }, detail),
    data &&
      h(
        'p',
        { className: 'muted small' },
        `${data.blocks.length} blocks · ${data.unknown.length} unknown positions${data.unknown.length ? ' (unloaded, shown empty)' : ''} · ${data.path.points.length ? `Path: ${data.path.status}, clipped to this view` : 'No active path'}. ${manifest?.blocks ? 'Minecraft client textures' : 'Color fallback — client textures unavailable'}; plants and fluids use simplified shapes.`,
      ),
  )
}
createRoot(document.getElementById('map-3d-root')).render(h(Viewer))
