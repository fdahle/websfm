// Scalar point attributes, kept separate from coordinates/RGB and packed into
// one project sidecar. The whitelist also validates persisted array types.
const TYPES = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array }

export function packAttributes(attributes = {}, count) {
  const fields = []
  let size = 0
  for (const [name, values] of Object.entries(attributes)) {
    const type = values.constructor.name
    if (!Object.hasOwn(TYPES, type) || values.length !== count) throw new Error(`Invalid cloud attribute: ${name}`)
    size = Math.ceil(size / 8) * 8
    fields.push({ name, type, offset: size })
    size += values.byteLength
  }
  const bytes = new Uint8Array(size)
  for (const field of fields) {
    const values = attributes[field.name]
    bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), field.offset)
  }
  return { fields, buffer: fields.length ? bytes.buffer : null }
}

export function unpackAttributes(fields = [], buffer, count) {
  const attributes = Object.create(null)
  for (const { name, type, offset } of fields) {
    const ArrayType = Object.hasOwn(TYPES, type) ? TYPES[type] : null
    if (!ArrayType || !buffer || !Number.isSafeInteger(offset) || offset < 0
        || offset % ArrayType.BYTES_PER_ELEMENT || offset + count * ArrayType.BYTES_PER_ELEMENT > buffer.byteLength) {
      throw new Error(`Invalid saved cloud attribute: ${name}`)
    }
    attributes[name] = new ArrayType(buffer, offset, count)
  }
  return attributes
}

export function attributeBuffers(cloud) {
  return [...new Set(Object.values(cloud.attributes || {}).map(values => values.buffer))]
}
