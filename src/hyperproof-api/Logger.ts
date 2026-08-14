import { inspect } from 'node:util';

import { debug } from '../add-on-sdk';
import { getAsyncStore } from '../asyncStore';
import { TraceParent } from '../TraceParent';

export enum LoggerContextKey {
  IntegrationId = 'integrationId',
  IntegrationType = 'integrationType',
  IntegrationVersion = 'integrationVersion',
  IsInitialPage = 'isInitialPage',
  OrgId = 'orgId',
  ProofType = 'proofType',
  UserId = 'userId',
  VendorUserId = 'vendorUserId'
}

// Values on the logger context are strings except where noted below.
export type LoggerContext = {
  [K in LoggerContextKey]?: K extends LoggerContextKey.IsInitialPage ? boolean : string;
};

function safeSerialize(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return inspect(value, { depth: null });
  }
}

export class Logger {
  /**
   * Posts a DEBUG message iff the debug environment variable is set to 1.
   *
   * @param message Message to log.
   * @param detail Additional detail to add to the log entry.
   */
  public static debug(message: any, detail?: string) {
    debug(detail ? `${message}: ${detail}` : message);
    if (process.env.debug === '1') {
      Logger.consoleLog('debug', message, detail);
    }
  }

  /**
   * Logs an INFO message.
   *
   * @param message Message to log.
   * @param detail Additional detail to add to the log entry.
   */
  public static info(message: any, detail?: string) {
    Logger.consoleLog('info', message, detail);
  }

  /**
   * Logs a WARNING message.
   *
   * @param message Message to log.
   * @param detail Additional detail to add to the log entry.
   */
  public static warn(message: any, detail?: string) {
    Logger.consoleLog('warning', message, detail);
  }

  /**
   * Logs an ERROR message.
   *
   * @param message Message to log.
   * @param errorInfo Additional detail about the error or an Error object.
   */
  public static error(message: any, errorInfo?: string | Error) {
    if (!errorInfo || typeof errorInfo === 'string') {
      Logger.consoleLog('error', message, typeof errorInfo === 'string' ? errorInfo : undefined);
    } else if (errorInfo instanceof Error) {
      Logger.consoleLog('error', message, errorInfo.message, errorInfo.stack);
    } else {
      Logger.consoleLog('error', message, safeSerialize(errorInfo));
    }
  }

  private static consoleLog(level: string, message: string, detail?: string, stack?: string) {
    const store = getAsyncStore();
    const context = store?.loggerContext;
    const entry = {
      level: level.toUpperCase(),
      message: safeSerialize(message),
      detail,
      stack,
      orgId: context?.[LoggerContextKey.OrgId],
      userId: context?.[LoggerContextKey.UserId],
      vendorUserId: context?.[LoggerContextKey.VendorUserId],
      integrationType: context?.[LoggerContextKey.IntegrationType],
      proofType: context?.[LoggerContextKey.ProofType],
      integrationId: context?.[LoggerContextKey.IntegrationId],
      traceId: TraceParent.getTraceId(),
      syncSpanId: TraceParent.getSyncSpanId()
    };
    const json = safeSerialize(entry);
    if (level === 'error' || level === 'warning') {
      console.error(json);
    } else {
      console.log(json);
    }
  }
}
