// DASH mp4 의 조각 색인(sidx) 을 읽어 "시간 ↔ 바이트" 표를 만든다.
//
// 유튜브가 주는 mp4 포맷에는 initRange(=ftyp+moov)와 indexRange(=sidx)가 함께 온다.
// sidx 하나가 2KB 남짓이라, 이것만 받아보면 1.3GB 짜리 영상에서도
// 원하는 구간이 어느 바이트에 있는지 바로 알 수 있다.

/** mp4 박스를 훑어 원하는 타입의 시작 위치를 찾는다. */
export function findBox(bytes, type, from = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = from;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    const name = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (name === type) return { start: offset, size };
    if (size < 8) break; // 크기가 망가진 박스. 더 읽어도 의미 없다.
    offset += size;
  }
  return null;
}

/**
 * sidx 박스를 해석한다.
 *
 * 결과의 `segments` 는 조각마다 {start, end, time, duration} 을 담는다.
 * start/end 는 파일 전체 기준 바이트 위치(양끝 포함), time/duration 은 초 단위다.
 *
 * @param bytes  indexRange 를 포함해 받은 앞부분 바이트
 * @param indexEnd  indexRange.end (조각 바이트는 그 다음부터 시작한다)
 */
export function parseSidx(bytes, indexEnd) {
  const box = findBox(bytes, "sidx");
  if (!box) throw new Error("sidx 박스를 찾지 못했습니다");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = box.start + 8;
  const version = view.getUint8(offset);
  offset += 4; // version(1) + flags(3)
  offset += 4; // reference_ID

  const timescale = view.getUint32(offset);
  offset += 4;

  let earliestPresentationTime;
  let firstOffset;
  if (version === 0) {
    earliestPresentationTime = view.getUint32(offset);
    offset += 4;
    firstOffset = view.getUint32(offset);
    offset += 4;
  } else {
    earliestPresentationTime = Number(view.getBigUint64(offset));
    offset += 8;
    firstOffset = Number(view.getBigUint64(offset));
    offset += 8;
  }

  offset += 2; // reserved
  const count = view.getUint16(offset);
  offset += 2;

  // 첫 조각은 sidx 가 끝난 바로 다음부터 시작한다.
  let bytePos = indexEnd + 1 + firstOffset;
  let timePos = earliestPresentationTime;
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const first = view.getUint32(offset);
    offset += 4;
    const duration = view.getUint32(offset);
    offset += 4;
    offset += 4; // SAP 정보. 유튜브 조각은 모두 키프레임으로 시작한다.

    // 최상위 비트가 1이면 다른 sidx 를 가리킨다(유튜브는 쓰지 않는다).
    const referenceType = first >>> 31;
    const size = first & 0x7fffffff;
    if (referenceType === 1) throw new Error("계층형 sidx 는 지원하지 않습니다");

    segments.push({
      start: bytePos,
      end: bytePos + size - 1,
      time: timePos / timescale,
      duration: duration / timescale,
    });
    bytePos += size;
    timePos += duration;
  }

  return { timescale, segments, totalDuration: timePos / timescale };
}

/**
 * [start, end] 초 구간을 담는 조각들을 고른다.
 *
 * 조각은 통째로 받아야 하므로 실제 결과는 요청보다 조금 넓다.
 *
 * 마지막 조각이 요청 구간에 아주 조금만 걸치면 버린다. 소리 조각은 10초씩이라
 * 0.1초를 더 담자고 10초를 끌고 오면 영상보다 한참 길어진 파일이 나온다.
 * 그 0.1초를 포기하는 편이 낫다(`tailTolerance` 초까지 포기한다).
 */
export function segmentsForRange(segments, start, end, tailTolerance = 1) {
  if (!segments.length) return [];
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  let picked = segments.filter(
    (segment) => segment.time + segment.duration > from && segment.time < to,
  );
  while (picked.length > 1 && picked[picked.length - 1].time > to - tailTolerance) {
    picked = picked.slice(0, -1);
  }
  // 요청 구간이 조각 사이에 끼어 아무것도 안 걸리면 가장 가까운 것 하나라도 준다.
  if (!picked.length) {
    const nearest = segments.reduce((best, segment) =>
      Math.abs(segment.time - from) < Math.abs(best.time - from) ? segment : best,
    );
    return [nearest];
  }
  return picked;
}

/** 고른 조각들을 이어붙는 바이트 구간으로 묶는다(요청 수를 줄인다). */
export function mergeRanges(segments, maxBytesPerRequest = 8 * 1024 * 1024) {
  const ranges = [];
  for (const segment of segments) {
    const last = ranges[ranges.length - 1];
    const wouldBe = last ? segment.end - last.start + 1 : 0;
    if (last && last.end + 1 === segment.start && wouldBe <= maxBytesPerRequest) {
      last.end = segment.end;
    } else {
      ranges.push({ start: segment.start, end: segment.end });
    }
  }
  return ranges;
}
