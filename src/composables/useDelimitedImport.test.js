import { describe, it, expect } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { guessMapping as guessGcps } from '../core/io/gcp.js'
import { SENSOR_ROLES, guessMapping as guessSensors } from '../core/io/sensor.js'
import { POSE_ROLES, guessMapping as guessPoses } from '../core/io/pose.js'
import {
  useDelimitedImport,
  rolesFromMapping,
  assignRole,
  mappingFromRoles,
  PREVIEW_ROW_COUNT,
} from './useDelimitedImport.js'

// The role ids GcpImportModal offers (its role <select>, minus 'ignore'), in order.
const GCP_ROLES = [
  'name',
  'x',
  'y',
  'z',
  'image',
  'px',
  'py',
  'role',
  'accuracyX',
  'accuracyY',
  'accuracyZ',
  'accuracyXY',
  'accuracyImgX',
  'accuracyImgY',
  'correlationXY',
  'correlationXZ',
  'correlationYZ',
]

function gcpImport(text) {
  const rawText = ref(text)
  return { rawText, ...useDelimitedImport({ rawText, guessMapping: guessGcps, roles: GCP_ROLES }) }
}

// CameraImportModal: the guesser and the role list follow the pose/sensor mode.
function cameraImport(text, initialMode = 'pose') {
  const mode = ref(initialMode)
  const imp = useDelimitedImport({
    rawText: () => text,
    guessMapping: computed(() => (mode.value === 'sensor' ? guessSensors : guessPoses)),
    roles: computed(() => (mode.value === 'sensor' ? SENSOR_ROLES : POSE_ROLES)),
  })
  return { mode, ...imp }
}

const GCP_FILE = [
  '# survey export',
  'Name,East,North,Height,photo,u,v,sigma_x',
  'A,1,2,3,img1.jpg,10,20,0.1',
  '',
  'B,4,5,6',
  'C,7,8,9,img2.jpg,1,2,0.2',
].join('\n')

describe('useDelimitedImport — parsing', () => {
  it('sniffs the delimiter, skips comments/blank lines and splits off the header row', () => {
    const imp = gcpImport(GCP_FILE)
    expect(imp.delimiter.value).toBe('comma')
    expect(imp.hasHeader.value).toBe(true)
    expect(imp.rows.value).toHaveLength(4)
    expect(imp.columnCount.value).toBe(8) // widest row, not the first data row
    expect(imp.headerCells.value).toEqual(['Name', 'East', 'North', 'Height', 'photo', 'u', 'v', 'sigma_x'])
    expect(imp.dataRows.value.map((r) => r[0])).toEqual(['A', 'B', 'C'])
    expect(imp.previewRows.value).toEqual(imp.dataRows.value)
  })

  it('treats the first row as data when there is no header', async () => {
    const imp = gcpImport(GCP_FILE)
    imp.hasHeader.value = false
    await nextTick()
    expect(imp.headerCells.value).toEqual([])
    expect(imp.dataRows.value.map((r) => r[0])).toEqual(['Name', 'A', 'B', 'C'])
  })

  it('previews at most the first eight data rows', () => {
    const text = ['name,x,y', ...Array.from({ length: 12 }, (_, i) => `P${i},${i},${i}`)].join('\n')
    const imp = gcpImport(text)
    expect(PREVIEW_ROW_COUNT).toBe(8)
    expect(imp.dataRows.value).toHaveLength(12)
    expect(imp.previewRows.value.map((r) => r[0])).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])
  })

  it('sniffs semicolon / tab / whitespace files', () => {
    expect(gcpImport('a;b;c\n1;2;3').delimiter.value).toBe('semicolon')
    expect(gcpImport('a\tb\tc\n1\t2\t3').delimiter.value).toBe('tab')
    expect(gcpImport('a  b   c\n1 2 3').delimiter.value).toBe('space')
  })

  it('handles an empty file', () => {
    const imp = gcpImport('')
    expect(imp.delimiter.value).toBe('comma')
    expect(imp.columnCount.value).toBe(0)
    expect(imp.columnRoles.value).toEqual([])
    expect(imp.previewRows.value).toEqual([])
  })

  it('re-parses when the text changes (without re-guessing)', async () => {
    const imp = gcpImport('name,x,y\nA,1,2')
    imp.rawText.value = 'name,x,y,z\nA,1,2,3\nB,4,5,6'
    await nextTick()
    expect(imp.columnCount.value).toBe(4)
    expect(imp.dataRows.value).toHaveLength(2)
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y'])
  })
})

describe('useDelimitedImport — role guessing', () => {
  it('guesses roles from the header immediately', () => {
    const imp = gcpImport(GCP_FILE)
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y', 'z', 'image', 'px', 'py', 'accuracyX'])
  })

  it('falls back to positional roles without a header (re-guessing on toggle)', async () => {
    const imp = gcpImport(GCP_FILE)
    imp.hasHeader.value = false
    await nextTick()
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y', 'z', 'ignore', 'ignore', 'ignore', 'ignore'])
  })

  it('falls back to positional roles for unrecognised header labels', () => {
    const imp = gcpImport('foo,bar,baz,qux,extra\n1,2,3,4,5')
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y', 'z', 'ignore'])
  })

  it('re-guesses when the delimiter changes', async () => {
    const imp = gcpImport('name;x;y\nA;1;2')
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y'])
    imp.delimiter.value = 'comma'
    await nextTick()
    expect(imp.columnCount.value).toBe(1)
    expect(imp.columnRoles.value).toEqual(['name'])
  })

  it('a re-guess discards manual role edits', async () => {
    const imp = gcpImport(GCP_FILE)
    imp.setRole(7, 'ignore')
    imp.hasHeader.value = false
    await nextTick()
    imp.hasHeader.value = true
    await nextTick()
    expect(imp.columnRoles.value[7]).toBe('accuracyX')
  })

  it('camera import: guesses pose roles, and re-guesses with the sensor guesser on a mode switch', async () => {
    const text = 'image;x;y;z;omega;phi;kappa;acc_x\nimg1.jpg;1;2;3;0;0;90;0.05'
    const imp = cameraImport(text, 'pose')
    expect(imp.columnRoles.value).toEqual(['image', 'x', 'y', 'z', 'omega', 'phi', 'kappa', 'accuracyX'])
    imp.mode.value = 'sensor'
    await nextTick()
    // With a header, only recognised columns get a role: x/y/z are not guessed as
    // width/height/focal by position.
    expect(imp.columnRoles.value).toEqual([
      'image',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
    ])
    expect(Object.keys(imp.mapping.value)).toEqual(SENSOR_ROLES)
  })

  it('camera import: sensor header detection', () => {
    const imp = cameraImport('label\twidth\theight\tfocal\tk1\ncam\t4000\t3000\t3500\t0.01', 'sensor')
    expect(imp.delimiter.value).toBe('tab')
    expect(imp.columnRoles.value).toEqual(['label', 'width', 'height', 'focal', 'k1'])
    expect(imp.mapping.value).toMatchObject({ label: 0, width: 1, height: 2, focal: 3, k1: 4, cx: null })
  })
})

describe('useDelimitedImport — role assignment and mapping', () => {
  it('maps every offered role, null when unassigned', () => {
    const imp = gcpImport(GCP_FILE)
    expect(Object.keys(imp.mapping.value)).toEqual(GCP_ROLES)
    expect(imp.mapping.value).toMatchObject({
      name: 0,
      x: 1,
      y: 2,
      z: 3,
      image: 4,
      px: 5,
      py: 6,
      accuracyX: 7,
      role: null,
      accuracyXY: null,
    })
  })

  it('each role is used at most once: assigning it elsewhere clears the old column', () => {
    const imp = gcpImport(GCP_FILE)
    imp.setRole(3, 'name')
    expect(imp.columnRoles.value.slice(0, 4)).toEqual(['ignore', 'x', 'y', 'name'])
    expect(imp.mapping.value.name).toBe(3)
    expect(imp.mapping.value.z).toBe(null)
  })

  it('"ignore" can be set on any number of columns', () => {
    const imp = gcpImport(GCP_FILE)
    imp.setRole(0, 'ignore')
    imp.setRole(1, 'ignore')
    expect(imp.columnRoles.value.slice(0, 3)).toEqual(['ignore', 'ignore', 'y'])
    expect(imp.mapping.value).toMatchObject({ name: null, x: null, y: 2 })
  })

  it('re-setting a column to its own role is a no-op', () => {
    const imp = gcpImport(GCP_FILE)
    imp.setRole(1, 'x')
    expect(imp.columnRoles.value).toEqual(['name', 'x', 'y', 'z', 'image', 'px', 'py', 'accuracyX'])
  })

  it('pure helpers', () => {
    expect(rolesFromMapping({ name: 2, x: 0, y: null }, 4)).toEqual(['x', 'ignore', 'name', 'ignore'])
    const roles = ['name', 'x', 'ignore']
    expect(assignRole(roles, 2, 'name')).toEqual(['ignore', 'x', 'name'])
    expect(roles).toEqual(['name', 'x', 'ignore']) // not mutated
    expect(assignRole(roles, 0, 'ignore')).toEqual(['ignore', 'x', 'ignore'])
    // The first column carrying a role wins (setRole never produces duplicates,
    // but a hand-built role list may).
    expect(mappingFromRoles(['x', 'x', 'ignore', 'y'], ['x', 'y', 'z'])).toEqual({ x: 0, y: 3, z: null })
  })
})
