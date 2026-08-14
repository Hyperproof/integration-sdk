import { Logger } from './Logger';

jest.mock('../add-on-sdk', () => ({ debug: jest.fn() }));
jest.mock('../asyncStore', () => ({ getAsyncStore: jest.fn(() => undefined) }));
jest.mock('../TraceParent', () => ({
  TraceParent: {
    getTraceId: jest.fn(() => undefined),
    getSyncSpanId: jest.fn(() => undefined)
  }
}));

describe('Logger console output', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it.each([
    ['info', 'INFO'],
    ['warning', 'WARNING'],
    ['error', 'ERROR']
  ])('should output %s level as uppercase %s', (method, expectedLevel) => {
    if (method === 'info') Logger.info('test message');
    else if (method === 'warning') Logger.warn('test message');
    else if (method === 'error') Logger.error('test message');

    const spy = method === 'error' || method === 'warning' ? consoleErrorSpy : consoleSpy;
    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe(expectedLevel);
  });

  it('should output debug level as uppercase DEBUG', () => {
    const origDebug = process.env.debug;
    process.env.debug = '1';
    try {
      Logger.debug('test message');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.level).toBe('DEBUG');
    } finally {
      process.env.debug = origDebug;
    }
  });

  it('should not include a timestamp property', () => {
    Logger.info('test message');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output).not.toHaveProperty('timestamp');
  });

  it('should route error and warning to console.error', () => {
    Logger.error('error msg');
    Logger.warn('warning msg');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('should route info to console.log', () => {
    Logger.info('info msg');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should not return a promise from any log method', () => {
    expect(Logger.info('msg')).toBeUndefined();
    expect(Logger.warn('msg')).toBeUndefined();
    expect(Logger.error('msg')).toBeUndefined();
    expect(Logger.debug('msg')).toBeUndefined();
  });
});
