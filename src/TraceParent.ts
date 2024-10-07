import { getAsyncStore } from './asyncStore';
import { HttpHeader } from './models';

export class TraceParent {
  public static getHeaders():
    | { traceparent: string; baggage?: string }
    | object {
    const store = getAsyncStore();
    if (!store?.traceParent) return {};
    const headers: any = {
      [HttpHeader.TraceParent]: store.traceParent
    };
    if (store.baggage) {
      headers[HttpHeader.Baggage] = store.baggage;
    }
    return headers;
  }

  public static getTraceId(): string | undefined {
    const store = getAsyncStore();
    const traceParent = store?.traceParent;
    if (traceParent) {
      return traceParent.split('-')?.[1];
    }
  }

  public static getSyncSpanId(): string | undefined {
    const store = getAsyncStore();
    const baggage = store?.baggage;
    if (!baggage) {
      return;
    }
    const properties = baggage.split(';');
    const baggageObj = properties?.reduce(
      (acc, curr) => ({
        ...acc,
        [curr.split('=')[0]]: curr.split('=')[1]
      }),
      {}
    );
    return (baggageObj as any)?.syncSpanId;
  }
}
