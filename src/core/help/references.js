// The bibliography: every published method WebSfM implements or follows, written once
// and cited by key — from a glossary entry's `refs:` frontmatter (its "Sources" list),
// the About dialog's acknowledgments and the Quality Report's "Methods used". A test
// checks every cited key resolves and every entry here is cited somewhere.
//
// Add an entry when code implements a published method: the key is first author +
// year (+ a letter when one author has two that year), `authors` as they appear on the
// paper, a DOI where one exists (else `url`). Cite only what the code actually does —
// the comment at the implementation names the paper too.

/**
 * @typedef {{ authors: string[], year: number, title: string, venue: string, doi?: string, url?: string }} Reference
 * @type {Record<string, Reference>}
 */
export const REFERENCES = {
  // ── Features and matching ──
  lowe2004: {
    authors: ['David G. Lowe'],
    year: 2004,
    title: 'Distinctive image features from scale-invariant keypoints',
    venue: 'International Journal of Computer Vision 60(2), 91–110',
    doi: '10.1023/B:VISI.0000029664.99615.94',
  },
  arandjelovic2012: {
    authors: ['Relja Arandjelović', 'Andrew Zisserman'],
    year: 2012,
    title: 'Three things everyone should know to improve object retrieval',
    venue: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
    doi: '10.1109/CVPR.2012.6248018',
  },
  detone2018: {
    authors: ['Daniel DeTone', 'Tomasz Malisiewicz', 'Andrew Rabinovich'],
    year: 2018,
    title: 'SuperPoint: self-supervised interest point detection and description',
    venue: 'CVPR Workshops',
    url: 'https://arxiv.org/abs/1712.07629',
  },
  tyszkiewicz2020: {
    authors: ['Michał J. Tyszkiewicz', 'Pascal Fua', 'Eduard Trulls'],
    year: 2020,
    title: 'DISK: learning local features with policy gradient',
    venue: 'Advances in Neural Information Processing Systems (NeurIPS) 33',
    url: 'https://arxiv.org/abs/2006.13566',
  },
  zhao2023: {
    authors: ['Xiaoming Zhao', 'Xingming Wu', 'Weihai Chen', 'Peter C. Y. Chen', 'Qingsong Xu', 'Zhengguo Li'],
    year: 2023,
    title: 'ALIKED: a lighter keypoint and descriptor extraction network via deformable transformation',
    venue: 'IEEE Transactions on Instrumentation and Measurement 72',
    url: 'https://arxiv.org/abs/2304.03608',
  },
  lindenberger2023: {
    authors: ['Philipp Lindenberger', 'Paul-Edouard Sarlin', 'Marc Pollefeys'],
    year: 2023,
    title: 'LightGlue: local feature matching at light speed',
    venue: 'IEEE/CVF International Conference on Computer Vision (ICCV)',
    url: 'https://arxiv.org/abs/2306.13643',
  },
  fischler1981: {
    authors: ['Martin A. Fischler', 'Robert C. Bolles'],
    year: 1981,
    title:
      'Random sample consensus: a paradigm for model fitting with applications to image analysis and automated cartography',
    venue: 'Communications of the ACM 24(6), 381–395',
    doi: '10.1145/358669.358692',
  },
  barath2020: {
    authors: ['Daniel Barath', 'Jana Noskova', 'Maksym Ivashechkin', 'Jiří Matas'],
    year: 2020,
    title: 'MAGSAC++, a fast, reliable and accurate robust estimator',
    venue: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)',
    url: 'https://arxiv.org/abs/1912.05909',
  },

  // ── Two-view geometry, pose, bundle adjustment ──
  hartley1997: {
    authors: ['Richard I. Hartley'],
    year: 1997,
    title: 'In defense of the eight-point algorithm',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 19(6), 580–593',
    doi: '10.1109/34.601246',
  },
  hartley2004: {
    authors: ['Richard Hartley', 'Andrew Zisserman'],
    year: 2004,
    title: 'Multiple View Geometry in Computer Vision (2nd edition)',
    venue: 'Cambridge University Press',
    doi: '10.1017/CBO9780511811685',
  },
  nister2004: {
    authors: ['David Nistér'],
    year: 2004,
    title: 'An efficient solution to the five-point relative pose problem',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 26(6), 756–770',
    doi: '10.1109/TPAMI.2004.17',
  },
  stewenius2006: {
    authors: ['Henrik Stewénius', 'Christopher Engels', 'David Nistér'],
    year: 2006,
    title: 'Recent developments on direct relative orientation',
    venue: 'ISPRS Journal of Photogrammetry and Remote Sensing 60(4), 284–294',
    doi: '10.1016/j.isprsjprs.2006.03.005',
  },
  persson2018: {
    authors: ['Mikael Persson', 'Klas Nordberg'],
    year: 2018,
    title: 'Lambda Twist: an accurate fast robust perspective three point (P3P) solver',
    venue: 'European Conference on Computer Vision (ECCV)',
    doi: '10.1007/978-3-030-01225-0_20',
  },
  triggs2000: {
    authors: ['Bill Triggs', 'Philip F. McLauchlan', 'Richard I. Hartley', 'Andrew W. Fitzgibbon'],
    year: 2000,
    title: 'Bundle adjustment — a modern synthesis',
    venue: 'Vision Algorithms: Theory and Practice, LNCS 1883, 298–372',
    doi: '10.1007/3-540-44480-7_21',
  },
  agarwal2010: {
    authors: ['Sameer Agarwal', 'Noah Snavely', 'Steven M. Seitz', 'Richard Szeliski'],
    year: 2010,
    title: 'Bundle adjustment in the large',
    venue: 'European Conference on Computer Vision (ECCV)',
    doi: '10.1007/978-3-642-15552-9_3',
  },
  schonberger2016: {
    authors: ['Johannes L. Schönberger', 'Jan-Michael Frahm'],
    year: 2016,
    title: 'Structure-from-motion revisited',
    venue: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
    doi: '10.1109/CVPR.2016.445',
  },
  brown1966: {
    authors: ['Duane C. Brown'],
    year: 1966,
    title: 'Decentering distortion of lenses',
    venue: 'Photogrammetric Engineering 32(3), 444–462',
  },
  kannala2006: {
    authors: ['Juho Kannala', 'Sami S. Brandt'],
    year: 2006,
    title: 'A generic camera model and calibration method for conventional, wide-angle, and fish-eye lenses',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 28(8), 1335–1340',
    doi: '10.1109/TPAMI.2006.153',
  },
  horn1987: {
    authors: ['Berthold K. P. Horn'],
    year: 1987,
    title: 'Closed-form solution of absolute orientation using unit quaternions',
    venue: 'Journal of the Optical Society of America A 4(4), 629–642',
    doi: '10.1364/JOSAA.4.000629',
  },

  // ── Dense reconstruction ──
  bleyer2011: {
    authors: ['Michael Bleyer', 'Christoph Rhemann', 'Carsten Rother'],
    year: 2011,
    title: 'PatchMatch stereo — stereo matching with slanted support windows',
    venue: 'British Machine Vision Conference (BMVC)',
    doi: '10.5244/C.25.14',
  },
  galliani2015: {
    authors: ['Silvano Galliani', 'Katrin Lasinger', 'Konrad Schindler'],
    year: 2015,
    title: 'Massively parallel multiview stereopsis by surface normal diffusion',
    venue: 'IEEE International Conference on Computer Vision (ICCV)',
    doi: '10.1109/ICCV.2015.106',
  },
  schonberger2016b: {
    authors: ['Johannes L. Schönberger', 'Enliang Zheng', 'Jan-Michael Frahm', 'Marc Pollefeys'],
    year: 2016,
    title: 'Pixelwise view selection for unstructured multi-view stereo',
    venue: 'European Conference on Computer Vision (ECCV)',
    doi: '10.1007/978-3-319-46487-9_31',
  },
  xu2019: {
    authors: ['Qingshan Xu', 'Wenbing Tao'],
    year: 2019,
    title: 'Multi-scale geometric consistency guided multi-view stereo',
    venue: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)',
    url: 'https://arxiv.org/abs/1904.08103',
  },
  rusu2008: {
    authors: ['Radu Bogdan Rusu', 'Zoltan Csaba Marton', 'Nico Blodow', 'Mihai Dolha', 'Michael Beetz'],
    year: 2008,
    title: 'Towards 3D point cloud based object maps for household environments',
    venue: 'Robotics and Autonomous Systems 56(11), 927–941',
    doi: '10.1016/j.robot.2008.08.005',
  },

  // ── Meshes and texture ──
  kazhdan2013: {
    authors: ['Michael Kazhdan', 'Hugues Hoppe'],
    year: 2013,
    title: 'Screened Poisson surface reconstruction',
    venue: 'ACM Transactions on Graphics 32(3), 29',
    doi: '10.1145/2487228.2487237',
  },
  garland1997: {
    authors: ['Michael Garland', 'Paul S. Heckbert'],
    year: 1997,
    title: 'Surface simplification using quadric error metrics',
    venue: 'SIGGRAPH 97, 209–216',
    doi: '10.1145/258734.258849',
  },
  taubin1995: {
    authors: ['Gabriel Taubin'],
    year: 1995,
    title: 'A signal processing approach to fair surface design',
    venue: 'SIGGRAPH 95, 351–358',
    doi: '10.1145/218380.218473',
  },
  waechter2014: {
    authors: ['Michael Waechter', 'Nils Moehrle', 'Michael Goesele'],
    year: 2014,
    title: 'Let there be color! Large-scale texturing of 3D reconstructions',
    venue: 'European Conference on Computer Vision (ECCV)',
    doi: '10.1007/978-3-319-10602-1_54',
  },

  // ── Orthophoto, rasters, point-cloud tools ──
  burt1983: {
    authors: ['Peter J. Burt', 'Edward H. Adelson'],
    year: 1983,
    title: 'A multiresolution spline with application to image mosaics',
    venue: 'ACM Transactions on Graphics 2(4), 217–236',
    doi: '10.1145/245.247',
  },
  brown2007: {
    authors: ['Matthew Brown', 'David G. Lowe'],
    year: 2007,
    title: 'Automatic panoramic image stitching using invariant features',
    venue: 'International Journal of Computer Vision 74(1), 59–73',
    doi: '10.1007/s11263-006-0002-3',
  },
  boykov2001: {
    authors: ['Yuri Boykov', 'Olga Veksler', 'Ramin Zabih'],
    year: 2001,
    title: 'Fast approximate energy minimization via graph cuts',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 23(11), 1222–1239',
    doi: '10.1109/34.969114',
  },
  boykov2004: {
    authors: ['Yuri Boykov', 'Vladimir Kolmogorov'],
    year: 2004,
    title: 'An experimental comparison of min-cut/max-flow algorithms for energy minimization in vision',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 26(9), 1124–1137',
    doi: '10.1109/TPAMI.2004.60',
  },
  zhang2016: {
    authors: ['Wuming Zhang', 'Jianbo Qi', 'Peng Wan', 'Hongtao Wang', 'Donghui Xie', 'Xiaoyan Wang', 'Guangjian Yan'],
    year: 2016,
    title: 'An easy-to-use airborne LiDAR data filtering method based on cloth simulation',
    venue: 'Remote Sensing 8(6), 501',
    doi: '10.3390/rs8060501',
  },
  horn1981: {
    authors: ['Berthold K. P. Horn'],
    year: 1981,
    title: 'Hill shading and the reflectance map',
    venue: 'Proceedings of the IEEE 69(1), 14–47',
    doi: '10.1109/PROC.1981.11918',
  },
  mark1992: {
    authors: ['Robert K. Mark'],
    year: 1992,
    title: 'Multidirectional, oblique-weighted, shaded-relief image of the Island of Hawaii',
    venue: 'U.S. Geological Survey Open-File Report 92-422',
    url: 'https://pubs.usgs.gov/of/1992/of92-422/',
  },
  shepard1968: {
    authors: ['Donald Shepard'],
    year: 1968,
    title: 'A two-dimensional interpolation function for irregularly-spaced data',
    venue: 'Proceedings of the 23rd ACM National Conference, 517–524',
    doi: '10.1145/800186.810616',
  },
  besl1992: {
    authors: ['Paul J. Besl', 'Neil D. McKay'],
    year: 1992,
    title: 'A method for registration of 3-D shapes',
    venue: 'IEEE Transactions on Pattern Analysis and Machine Intelligence 14(2), 239–256',
    doi: '10.1109/34.121791',
  },
  chen1992: {
    authors: ['Yang Chen', 'Gérard Medioni'],
    year: 1992,
    title: 'Object modelling by registration of multiple range images',
    venue: 'Image and Vision Computing 10(3), 145–155',
    doi: '10.1016/0262-8856(92)90066-C',
  },
}

const surname = (name) => name.trim().split(/\s+/).at(-1)

/** "Lowe 2004", "Kazhdan & Hoppe 2013", "Bleyer et al. 2011". */
export function citeShort(key) {
  const r = REFERENCES[key]
  if (!r) return key
  const a = r.authors
  const who =
    a.length === 1 ? surname(a[0]) : a.length === 2 ? `${surname(a[0])} & ${surname(a[1])}` : `${surname(a[0])} et al.`
  return `${who} ${r.year}`
}

/** The link a reference opens: its DOI, else its URL, else null. */
export function referenceUrl(key) {
  const r = REFERENCES[key]
  if (!r) return null
  return r.doi ? `https://doi.org/${r.doi}` : (r.url ?? null)
}

/** "Lowe, D. G. (2004). Title. Venue." — a full citation as plain text, with its DOI or
 * URL appended unless `link` is false (a caller that renders the link itself). */
export function formatReference(key, { link = true } = {}) {
  const r = REFERENCES[key]
  if (!r) return key
  const initials = (name) => {
    const parts = name.trim().split(/\s+/)
    const last = parts.pop()
    const ini = parts
      .map((p) =>
        p
          .split('-')
          .map((s) => `${s[0]}.`)
          .join('-'),
      )
      .join(' ')
    return ini ? `${last}, ${ini}` : last
  }
  const names = r.authors.map(initials)
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0]
  const tail = !link ? '' : r.doi ? ` https://doi.org/${r.doi}` : r.url ? ` ${r.url}` : ''
  return `${who} (${r.year}). ${r.title}. ${r.venue}.${tail}`
}

/** Keys from a comma-separated `refs:` list, in order, de-duplicated. */
export function parseRefKeys(text) {
  return [
    ...new Set(
      String(text ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}
