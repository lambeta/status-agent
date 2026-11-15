/** Daily report scheduling (local time). */

export function parseReportTime(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`汇报时间格式应为 HH:MM：${value}`);
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** Next report time strictly after `now`, using the host's timezone. */
export function nextReportAt(times, now = new Date()) {
  const points = times
    .map(parseReportTime)
    .sort((a, b) => a.hours * 60 + a.minutes - (b.hours * 60 + b.minutes));
  if (!points.length) return null;
  for (let offset = 0; offset <= 1; offset += 1) {
    for (const point of points) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + offset);
      candidate.setHours(point.hours, point.minutes, 0, 0);
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }
  return null;
}

export function createReporter({ times, onReport, log = () => {} }) {
  let timer = null;
  let stopped = false;

  function arm() {
    if (stopped) return;
    const next = nextReportAt(times, new Date());
    if (!next) {
      log('没有可用的汇报时间，跳过调度');
      return;
    }
    const delay = Math.max(1000, next.getTime() - Date.now());
    log(`下次汇报：${next.toLocaleString('zh-CN', { hour12: false })}`);
    timer = setTimeout(async () => {
      try {
        await onReport();
      } catch (error) {
        log(`汇报失败：${error.message}`);
      }
      arm();
    }, delay);
  }

  arm();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    next: () => nextReportAt(times, new Date()),
  };
}
