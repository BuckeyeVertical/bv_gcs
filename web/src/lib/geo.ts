const R_EARTH_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(a));
}

export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Fraction of the way from start to end, projected onto the local path line. */
export function segmentFraction(
  latitude: number,
  longitude: number,
  start: [number, number],
  end: [number, number],
): number {
  const meanLat = toRad((start[0] + end[0]) / 2);
  const x = toRad(longitude - start[1]) * Math.cos(meanLat) * R_EARTH_M;
  const y = toRad(latitude - start[0]) * R_EARTH_M;
  const dx = toRad(end[1] - start[1]) * Math.cos(meanLat) * R_EARTH_M;
  const dy = toRad(end[0] - start[0]) * R_EARTH_M;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;
  return Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared));
}
