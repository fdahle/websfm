export function createImage(file) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    url: URL.createObjectURL(file),
    file,
    meta: null,
    loading: true,
    keypoints: [],
    kpStatus: 'idle', // 'idle' | 'running' | 'done' | 'error'
    kpCount: 0,
    kpMs: 0,
    mask: null, // { dataUrl: string } | null
  }
}
