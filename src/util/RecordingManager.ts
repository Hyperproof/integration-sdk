import NodeHttpAdapter from '@pollyjs/adapter-node-http';
import { Polly } from '@pollyjs/core';
import FsPersister from '@pollyjs/persister-fs';

import { IntegrationContext } from '../add-on-sdk';
import { TraceParent } from '../TraceParent';

Polly.register(FsPersister);
Polly.register(NodeHttpAdapter);

export class RecordingManager {
  private static canRecordForEnv: boolean;
  private recorder: Polly | null;

  constructor(integrationContext: IntegrationContext) {
    this.recorder = null;
    RecordingManager.canRecordForEnv =
      !!process.env['recording_enabled'] &&
      integrationContext.subscriptionId === 'hplocaldevfr';
  }

  public start() {
    if (!RecordingManager.canRecordForEnv) return;
    const recordingName = TraceParent.getTraceId();
    if (recordingName) {
      this.recorder = new Polly(recordingName, {
        adapters: ['node-http'],
        persister: 'fs',
        mode: 'record',
        recordFailedRequests: true,
        persisterOptions: {
          fs: {
            recordingsDir: '_http_recordings'
          }
        }
      });
    }
  }

  public async stop() {
    if (this.recorder) {
      await this.recorder.stop();
      this.recorder = null;
    }
  }
}
