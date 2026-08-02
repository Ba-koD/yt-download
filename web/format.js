// 시간·숫자 표시 도우미.


export function resolutionLabel(height) {
  const value = Number(height) || 0;
  if (value >= 4320) return "8K";
  if (value >= 2160) return "4K";
  if (value >= 1440) return "1440p";
  if (value >= 1080) return "1080p";
  if (value >= 720) return "720p";
  return `${Math.round(value)}p`;
}

export function parseTime(value) {
  const text = String(value).trim();
  if (!text) return NaN;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

export function formatClockPrecise(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${pad(Math.floor(total / 3600))}:${pad(minutes % 60)}:${secs.toFixed(1).padStart(4, "0")}`;
}

export function formatClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 큰 수는 한국식 단위로 줄여 읽는다. 23294157 -> "2329만"
export function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "";
  if (number >= 100_000_000) return `${trimZero(number / 100_000_000)}억`;
  if (number >= 10_000) return `${trimZero(number / 10_000)}만`;
  if (number >= 1_000) return number.toLocaleString("ko-KR");
  return String(Math.round(number));
}

function trimZero(value) {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}

/** 유닉스 초 -> "2026. 8. 2." */
export function formatDate(timestamp) {
  const date = toDate(timestamp);
  if (!date) return "";
  return date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

/** 유닉스 초 -> "3일 전" 처럼 지금으로부터 얼마나 됐는지. */
export function formatSince(timestamp) {
  const date = toDate(timestamp);
  if (!date) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 0) return "예정";
  if (days === 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

export function toDate(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

export function extractYouTubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0];
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
    const shorts = parsed.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
    const live = parsed.pathname.match(/\/live\/([^/?]+)/);
    if (live) return live[1];
  } catch {
    return null;
  }
  return null;
}
