import { describe, expect, it } from 'vitest';
import { cronDisplayName, humanizeCronSchedule } from '../CronManagerPage';

describe('humanizeCronSchedule', () => {
  it('turns common schedules into plain language', () => {
    expect(humanizeCronSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    expect(humanizeCronSchedule('0 9 * * *')).toMatch(/^Daily at 9:00/);
    expect(humanizeCronSchedule('30 5 * * 1')).toMatch(/^Every Monday at 5:30/);
  });

  it('keeps advanced cron syntax out of the primary cadence label', () => {
    expect(humanizeCronSchedule('0 5 1-7 * 1')).toBe('Custom schedule');
  });

  it('supports weekday schedules and removes cadence duplicated in names', () => {
    expect(humanizeCronSchedule('0 9 * * 1-5')).toMatch(/^Weekdays at 9:00/);
    expect(cronDisplayName('Repository health check (every 30 minutes)')).toBe('Repository health check');
  });
});
