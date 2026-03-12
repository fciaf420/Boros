export function fmtApr(v: number): string {
  return (v * 100).toFixed(2) + "%";
}

export function fmtUsd(v: number, opts?: { signed?: boolean }): string {
  if (opts?.signed) {
    const prefix = v >= 0 ? "+$" : "-$";
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return prefix + (abs / 1_000_000).toFixed(2) + "M";
    if (abs >= 1_000) return prefix + (abs / 1_000).toFixed(1) + "K";
    return prefix + abs.toFixed(2);
  }
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function fmtDays(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  return days + "d";
}

export function fmtTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString();
}
