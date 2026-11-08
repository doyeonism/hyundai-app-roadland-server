// 도로를 나누는 육각 타일. 차량 앱의 HexGrid.kt와 같은 계산을 해야 한다(둘 다 테스트에 같은 좌표·ID를 쓴다).
// 웹 메르카토르 평면 위의 뾰족한 위쪽 육각형, 축 좌표 (q, r). ID는 "q:r".

export const HEX_SIZE_M = 12.5; // 메르카토르 미터. 서울 위도에서 실제 약 10m.
const R = 6378137;
const TILE_ID = /^-?\d{1,7}:-?\d{1,7}$/;

export interface Axial {
  q: number;
  r: number;
}

export function toMercator(lat: number, lng: number) {
  const x = (R * lng * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x, y };
}

export function tileId(q: number, r: number) {
  return `${q}:${r}`;
}

export function isTileId(id: unknown): id is string {
  return typeof id === "string" && TILE_ID.test(id);
}

export function parseTileId(id: string): Axial {
  const [q, r] = id.split(":").map(Number);
  return { q, r };
}

export function tileForLatLng(lat: number, lng: number) {
  const { x, y } = toMercator(lat, lng);
  const fq = ((Math.sqrt(3) / 3) * x - y / 3) / HEX_SIZE_M;
  const fr = ((2 / 3) * y) / HEX_SIZE_M;
  // 큐브 좌표 반올림
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return tileId(q, r);
}

/** 두 타일 사이 칸 수. */
export function hexDistance(a: string, b: string) {
  const p = parseTileId(a);
  const o = parseTileId(b);
  const dq = p.q - o.q;
  const dr = p.r - o.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}
