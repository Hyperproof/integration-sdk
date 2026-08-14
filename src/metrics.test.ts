import { httpRequestErrors, register, trackSdkCall } from './metrics';

describe('trackSdkCall', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('records duration on success', async () => {
    const result = await trackSdkCall('listUsers', 'us-east-1', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('rethrows the original error and records error_code from err.code (AWS SDK style)', async () => {
    const awsError = Object.assign(new Error('Rate exceeded'), { code: 'ThrottlingException' });

    await expect(trackSdkCall('describeInstances', 'us-west-2', () => Promise.reject(awsError))).rejects.toBe(awsError);

    const errors = await httpRequestErrors.get();
    expect(errors.values).toContainEqual(
      expect.objectContaining({
        labels: expect.objectContaining({
          error_code: 'ThrottlingException',
          target_host: 'us-west-2'
        })
      })
    );
  });

  it('falls back to err.name when err.code is absent', async () => {
    class TimeoutError extends Error {
      constructor() {
        super('timed out');
        this.name = 'TimeoutError';
      }
    }

    await expect(trackSdkCall('getInventory', 'us-east-1', () => Promise.reject(new TimeoutError()))).rejects.toThrow(
      'timed out'
    );

    const errors = await httpRequestErrors.get();
    expect(errors.values).toContainEqual(
      expect.objectContaining({
        labels: expect.objectContaining({ error_code: 'TimeoutError' })
      })
    );
  });

  it('uses "unknown" when neither code nor name is available', async () => {
    await expect(trackSdkCall('searchAccountsByTag', 'us-east-1', () => Promise.reject('plain string'))).rejects.toBe(
      'plain string'
    );

    const errors = await httpRequestErrors.get();
    expect(errors.values).toContainEqual(
      expect.objectContaining({
        labels: expect.objectContaining({ error_code: 'unknown' })
      })
    );
  });
});
