export async function inflate(data) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate')
    const writer = ds.writable.getWriter()
    writer.write(data)
    writer.close()
    return new Response(ds.readable).arrayBuffer().then(buffer => new Uint8Array(buffer))
  } else {
    return import('pako').then(pako => pako.inflate(data))
  }
}

export async function deflate(data) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate')
    const writer = cs.writable.getWriter()
    writer.write(data)
    writer.close()
    return new Response(cs.readable).arrayBuffer().then(buffer => new Uint8Array(buffer))
  } else {
    return import('pako').then(pako => pako.deflate(data))
  }
}

export const process = { platform: 'browser' }
