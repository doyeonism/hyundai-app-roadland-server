import { tileForLatLng } from "./hex";

/** 시연용 출퇴근 경로(성수동 집 → 성수대교 → 강남역 회사). 위도, 경도. */
export const COMMUTE: [number, number][] = [
  [37.5446, 127.0559],
  [37.5447, 127.0466],
  [37.5444, 127.0374],
  [37.5378, 127.035],
  [37.5303, 127.0336],
  [37.5226, 127.0318],
  [37.5135, 127.0297],
  [37.5049, 127.0272],
  [37.4979, 127.0276],
];

/** 주말에 한 번 다녀온 한강 쪽 길. */
export const RIVERSIDE: [number, number][] = [
  [37.5446, 127.0559],
  [37.5371, 127.0632],
  [37.5296, 127.0705],
];

/** 경로를 약 stepM 간격 점으로 펼친다. */
export function sampleRoute(route: [number, number][], stepM = 30): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const [a, b] = [route[i], route[i + 1]];
    const dLat = (b[0] - a[0]) * 111_320;
    const dLng = (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
    const n = Math.max(1, Math.ceil(Math.hypot(dLat, dLng) / stepM));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(route[route.length - 1]);
  return out;
}

export function routeTiles(route: [number, number][]) {
  // 타일(약 10m)보다 촘촘히 찍어야 칸을 건너뛰지 않는다.
  return [...new Set(sampleRoute(route, 4).map(([lat, lng]) => tileForLatLng(lat, lng)))];
}
