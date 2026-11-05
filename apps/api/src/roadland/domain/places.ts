import { tileForLatLng } from "./hex";

/** 특별 구간. 지나가면 기록 화면의 수집 목록이 채워진다. */
export const SPECIALS: { id: string; name: string }[] = [
  { name: "서울숲", at: [37.5444, 127.0374] as const },
  { name: "성수대교", at: [37.5378, 127.035] as const },
  { name: "한강 뚝섬", at: [37.5296, 127.0705] as const },
  { name: "강남역", at: [37.4979, 127.0276] as const },
].map((s) => ({ id: tileForLatLng(s.at[0], s.at[1]), name: s.name }));

export const SPECIAL_BY_ID = new Map(SPECIALS.map((s) => [s.id, s.name]));

/** 시연용 출퇴근 경로(성수동 집 → 서울숲 → 성수대교 → 강남역 회사). 위도, 경도. */
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
  return [...new Set(sampleRoute(route).map(([lat, lng]) => tileForLatLng(lat, lng)))];
}
