export function createImage(file) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    uuid: crypto.randomUUID(),
    name: file.name,
    url: URL.createObjectURL(file),
    file,
    meta: null,
    loading: true,
    keypoints: [],
    descriptors: null, // Float32Array (N×128) kept in-memory for matching
    kpStatus: 'idle', // 'idle' | 'running' | 'done' | 'error'
    kpCount: 0,
    kpMs: 0,
    mask: null, // { dataUrl: string } | null
  }
}
