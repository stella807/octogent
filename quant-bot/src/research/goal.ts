/**
 * How big an account has to be to pay a daily amount, and how long it takes to
 * get there by reinvesting. It is arithmetic on an assumed yearly return, not a
 * forecast: no strategy tested here has shown a return it can be trusted to
 * repeat, and a real year can be negative.
 */

export function targetCapital(dailyUsd: number, annualReturnPct: number): number {
  if (!(annualReturnPct > 0)) throw new RangeError('annual return must be positive to size an account');
  return (dailyUsd * 365) / (annualReturnPct / 100);
}

const MAX_MONTHS = 1200;

/** Whole months of monthly-compounded growth plus a deposit each month until `target`; null if it takes over a century. */
export function monthsToTarget(start: number, target: number, annualReturnPct: number, monthlyDeposit: number): number | null {
  if (start >= target) return 0;
  const monthly = (1 + annualReturnPct / 100) ** (1 / 12) - 1;
  if (!(monthly > 0) && !(monthlyDeposit > 0)) return null;
  let balance = start;
  for (let month = 1; month <= MAX_MONTHS; month += 1) {
    balance = balance * (1 + (monthly > 0 ? monthly : 0)) + monthlyDeposit;
    if (balance >= target) return month;
  }
  return null;
}

const usd = (v: number): string => `$${Math.round(v).toLocaleString('en-US')}`;

function span(months: number | null): string {
  if (months === null) return 'over 100 years';
  if (months === 0) return 'already there';
  return months < 24 ? `${months} months` : `${(months / 12).toFixed(1)} years`;
}

export function formatGoal(opts: { daily: number; start: number; monthlyDeposit: number; returns: readonly number[] }): string {
  const lines = [
    `GOAL  ${usd(opts.daily)} a day, starting from ${usd(opts.start)}, everything reinvested${opts.monthlyDeposit > 0 ? `, plus ${usd(opts.monthlyDeposit)} a month` : ''}`,
    '='.repeat(78),
    `${'yearly return'.padEnd(15)} ${'account needed'.padEnd(16)} ${'time with no deposits'.padEnd(23)} time with deposits`,
  ];
  for (const r of opts.returns) {
    const need = targetCapital(opts.daily, r);
    lines.push(
      `${`${r}%`.padEnd(15)} ${usd(need).padEnd(16)} ${span(monthsToTarget(opts.start, need, r, 0)).padEnd(23)} ${opts.monthlyDeposit > 0 ? span(monthsToTarget(opts.start, need, r, opts.monthlyDeposit)) : '-'}`,
    );
  }
  lines.push(
    '',
    'This is arithmetic on an assumed return, not a forecast. The best rule tested made about 35% a year in history, mostly in bull markets;',
    'no strategy here has shown a return it can repeat, a losing year pushes every date back, and 50-80% drops are normal in crypto.',
    'Deposits move the date far more than strategy does.',
  );
  return lines.join('\n');
}
