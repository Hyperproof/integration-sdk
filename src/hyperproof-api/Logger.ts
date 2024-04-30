import fetch from 'node-fetch';

import { debug } from '../add-on-sdk';
import { getAsyncStore } from '../asyncStore';
import { HttpHeader, MimeType } from '../models';
import { TraceParent } from '../TraceParent';

export enum LoggerContextKey {
  IntegrationType = 'integrationType',
  OrgId = 'orgId',
  UserId = 'userId'
}

export type LoggerContext = { [key in LoggerContextKey]?: string };

enum EventType {
  Debug = 'debug',
  Information = 'info',
  Warning = 'warning',
  Error = 'error'
}

enum Originator {
  Client = 'client',
  Integrations = 'integrations'
}

interface ILogEvent {
  eventType: EventType;
  originator?: string;
  message: string;
  url?: string;
  status?: number;
  detail?: string;
  stack?: string;
  orgId?: string;
  userId?: string;
  integrationType?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var _hyperproof_api_subscription_key: string | undefined;
}

export class Logger {
  public static init(subscriptionKey: string) {
    global._hyperproof_api_subscription_key =
      subscriptionKey ?? global._hyperproof_api_subscription_key;
  }

  /**
   * Posts a DEBUG message to Hyperproof iff the debug environment variable is set to 1.
   *
   * @param {string} message Message to log.
   * @param {string} detail Additional detail to add to the log entry.
   */
  public static async debug(message: any, detail?: string) {
    debug(detail ? `${message}: ${detail}` : message);
    if (process.env.debug === '1') {
      console.log(detail ? `${message}: ${detail}` : message);
      return Logger.postLogEvent(EventType.Debug, message, detail);
    }
  }

  /**
   * Post an INFO message to Hyperproof.
   *
   * @param {string} message Message to log.
   * @param {string} detail Additional detail to add to the log entry.
   */
  public static async info(message: any, detail?: string) {
    console.log(detail ? `${message}: ${detail}` : message);
    return Logger.postLogEvent(EventType.Information, message, detail);
  }

  /**
   * Post a WARNING message to Hyperproof.
   *
   * @param {string} message Message to log.
   * @param {string} detail Additional detail to add to the log entry.
   */
  public static async warn(message: any, detail?: string) {
    console.error(detail ? `${message}: ${detail}` : message);
    return this.postLogEvent(EventType.Warning, message, detail);
  }

  /**
   * Post an ERROR log message to Hyperproof.
   *
   * @param {string} message Message to log.
   * @param {string} error Additional detail about the error or an Error object.
   */
  public static async error(message: any, errorInfo?: string | Error) {
    if (!errorInfo || typeof errorInfo === 'string') {
      console.error(errorInfo ? `${message}: ${errorInfo}` : message);
      return this.postLogEvent(EventType.Error, message, errorInfo);
    } else {
      console.error(message, '\n', errorInfo);
      return this.postLogEvent(
        EventType.Error,
        message,
        errorInfo.message,
        errorInfo.stack
      );
    }
  }

  /**
   * Log an event in the Hyperproof backend.
   *
   * @param {EventType} eventType Type (level) this log message,
   * @param {string} message Message to log.
   * @param {string} detail Additional detail to add to the log entry.
   * @param {string} stack Optional stack to associate with the entry.
   */
  private static async postLogEvent(
    eventType: EventType,
    message: any,
    detail?: string,
    stack?: string
  ) {
    const subscriptionKey =
      global._hyperproof_api_subscription_key ??
      process.env.hyperproof_api_subscription_key;
    // HYP-26951: Skip this for LocalDev due to microk8s issues.
    // See https://github.com/kubernetes/kubectl/issues/1169
    if (subscriptionKey?.includes('local_dev')) {
      return;
    }

    if (!process.env.hyperproof_api_url || !subscriptionKey) {
      console.error(
        `Unable to post log event. ${
          !process.env.hyperproof_api_url ? 'hyperproof_api_url' : ''
        } ${
          !subscriptionKey ? 'hyperproof_api_subscription_key' : ''
        } not set in environment.`
      );
      return;
    }

    try {
      const url = `${process.env.hyperproof_api_url}/beta/logs/events`;

      const store = getAsyncStore();
      const context = store?.loggerContext;
      const logEvent: ILogEvent = {
        eventType,
        originator: Originator.Integrations,
        message:
          typeof message === 'string' ? message : JSON.stringify(message),
        detail,
        orgId: context?.[LoggerContextKey.OrgId],
        userId: context?.[LoggerContextKey.UserId],
        integrationType: context?.[LoggerContextKey.IntegrationType],
        stack
      };

      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(logEvent),
        headers: {
          ...TraceParent.getHeaders(),
          [HttpHeader.SubscriptionKey]: subscriptionKey,
          [HttpHeader.ContentType]: MimeType.APPLICATION_JSON
        }
      });
      if (!response.ok) {
        // Swallow error. Failure to log should not take down the operation
        const text = await response.text();
        console.error(
          `Received ${response.status} status posting log message`,
          text
        );
      }
    } catch (e) {
      // Swallow error. Failure to log should not take down the operation
      console.error('Unexpected exception caught while posting log message', e);
    }
  }
}
