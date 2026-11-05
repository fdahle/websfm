// Fixed facts the code shares: properties of the Earth models and of the statistics it
// uses. Not settings and never tuned (those are in defaults.user.js and tuning.js); each
// is defined here once so two copies cannot drift apart. Format constants (a LAS header
// size, a tag family's code table) stay with their reader or writer.
//
// Pure data module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged.

// The WGS84 ellipsoid (EPSG:7030): semi-major axis (m), flattening, first eccentricity².
export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)

// Web Mercator (EPSG:3857) projects a sphere of radius WGS84_A and stops at the latitude
// where its map is square, atan(sinh(π)).
export const WEB_MERCATOR_MAX_LAT = 85.0511287798066

// Metres in one degree of latitude, and of longitude at the equator: the scale for a
// rough size or margin in degrees, not for a survey measurement.
export const METRES_PER_DEGREE = 111320

// The normalized median absolute deviation: NMAD = NMAD_K · median |x − median x|,
// which equals σ for normally distributed x and ignores a share of blunders.
export const NMAD_K = 1.4826
