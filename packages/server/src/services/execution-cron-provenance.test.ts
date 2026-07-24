import { describe, expect, it } from 'vitest';
import { mergeCronRunProvenance } from './execution.service.js';

describe('mergeCronRunProvenance', () => {
  it('hydrates historical executions from their durable cron run record', () => {
    const rows = [
      { id: 'exec-1', meta: { origin: 'chat' } },
      { id: 'exec-2', meta: {} },
    ];

    mergeCronRunProvenance(rows, [
      {
        executionId: 'exec-1',
        cronJobName: 'repo-scanner',
        triggeredBy: 'schedule',
      },
    ]);

    expect(rows[0]).toMatchObject({
      meta: {
        origin: 'cron',
        cronJobName: 'repo-scanner',
        triggeredBy: 'schedule',
      },
    });
    expect(rows[1]).toEqual({ id: 'exec-2', meta: {} });
  });

  it('preserves explicit execution metadata while normalizing cron origin', () => {
    const rows = [{
      id: 'exec-1',
      meta: {
        origin: 'workflow',
        cronJobName: 'explicit-job',
        triggeredBy: 'manual',
      },
    }];

    mergeCronRunProvenance(rows, [{
      executionId: 'exec-1',
      cronJobName: 'historical-job',
      triggeredBy: 'schedule',
    }]);

    expect(rows[0]).toMatchObject({
      meta: {
        origin: 'cron',
        cronJobName: 'explicit-job',
        triggeredBy: 'manual',
      },
    });
  });

  it('does not guess that a legacy run was scheduled when trigger provenance is absent', () => {
    const rows = [{ id: 'exec-1', meta: {} }];

    mergeCronRunProvenance(rows, [{
      executionId: 'exec-1',
      cronJobName: 'repo-scanner',
    }]);

    expect(rows[0]).toEqual({
      id: 'exec-1',
      meta: {
        origin: 'cron',
        cronJobName: 'repo-scanner',
      },
    });
  });
});
