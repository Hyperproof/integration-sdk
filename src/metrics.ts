import client, { collectDefaultMetrics, Registry } from 'prom-client';
import { safeMetric } from './util/safeMetric';

export const register: Registry = client.register;

let defaultMetricsStarted = false;
export function initMetrics() {
  if (!defaultMetricsStarted) {
    collectDefaultMetrics({ prefix: 'integration_' });
    defaultMetricsStarted = true;
  }
}

const integrationType = process.env.integration_type ?? 'unknown';

export const httpRequestDuration = new client.Histogram({
  name: 'integration_http_request_duration_seconds',
  help: 'Duration of outbound HTTP requests in seconds',
  labelNames: ['integration_type', 'method', 'target_host', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

export const httpRequestErrors = new client.Counter({
  name: 'integration_http_request_errors_total',
  help: 'Total number of outbound HTTP request errors',
  labelNames: ['integration_type', 'error_code', 'target_host'] as const
});

export const httpActiveRequests = new client.Gauge({
  name: 'integration_http_active_requests',
  help: 'Number of active outbound HTTP requests',
  labelNames: ['integration_type', 'target_host'] as const
});

export const integrationUp = new client.Gauge({
  name: 'integration_up',
  help: 'Whether the integration is up and running',
  labelNames: ['integration_type'] as const
});

/**
 * Extracts the hostname from a URL string, returning 'unknown' for malformed URLs.
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Wraps an async function with histogram/counter recording for SDK-based calls
 * (e.g. integrations that call vendor SDKs directly instead of HTTP).
 */
export async function trackSdkCall<T>(method: string, region: string, fn: () => Promise<T>): Promise<T> {
  const end = safeMetric(() =>
    httpRequestDuration.startTimer({
      integration_type: integrationType,
      method,
      target_host: region
    })
  );
  safeMetric(() => httpActiveRequests.inc({ integration_type: integrationType, target_host: region }));

  try {
    const result = await fn();
    safeMetric(() => end?.({ status: 'ok' }));
    return result;
  } catch (err) {
    safeMetric(() => {
      end?.({ status: 'error' });
      // Prefer .code (AWS SDK + Node syscall errors set descriptive codes
      // like 'ThrottlingException', 'ECONNRESET'); fall back to error name.
      const errorCode =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any)?.code ?? (err instanceof Error ? err.name : 'unknown');
      httpRequestErrors.inc({
        integration_type: integrationType,
        error_code: errorCode,
        target_host: region
      });
    });
    throw err;
  } finally {
    safeMetric(() => httpActiveRequests.dec({ integration_type: integrationType, target_host: region }));
  }
}
