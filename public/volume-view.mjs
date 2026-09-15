// Crop a loaded cube vertically while preserving world coordinates for entities and routes.
export function cropVolume(data, height) {
  const originalHeight = data.height || data.size
  const shift = Math.floor((originalHeight - height) / 2)
  const inside = (y) => y >= shift && y < shift + height
  return {
    ...data,
    height,
    origin: { ...data.origin, y: data.origin.y + shift },
    blocks: data.blocks.filter((b) => inside(b.y)).map((b) => ({ ...b, y: b.y - shift })),
    unknown: data.unknown.filter((p) => inside(p[1])).map(([x, y, z]) => [x, y - shift, z]),
    entities: data.entities.filter((e) => inside(e.y - data.origin.y)),
  }
}

// Collision shapes already encode the server's bar connections, including solid neighbours.
export function ironBarConnections(shapes) {
  const connected = (axis, edge, compare) => shapes.some((shape) => compare(shape[axis], edge))
  return [
    connected(0, 0.4, (value, edge) => value < edge) && { x: 0.25, z: 0.5, angle: 0, uv: 0 },
    connected(3, 0.6, (value, edge) => value > edge) && { x: 0.75, z: 0.5, angle: 0, uv: 0.5 },
    connected(2, 0.4, (value, edge) => value < edge) && {
      x: 0.5,
      z: 0.25,
      angle: Math.PI / 2,
      uv: 0,
    },
    connected(5, 0.6, (value, edge) => value > edge) && {
      x: 0.5,
      z: 0.75,
      angle: Math.PI / 2,
      uv: 0.5,
    },
  ].filter(Boolean)
}
