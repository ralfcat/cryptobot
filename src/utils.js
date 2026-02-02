export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs() {
  return Date.now();
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

export function avg(arr) {
  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

export function pctChange(a, b) {
  if (a === 0) return 0;
  return ((b - a) / a) * 100;
}
