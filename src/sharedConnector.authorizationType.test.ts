import { AuthorizationType } from './models';
import { OAuthConnector } from './oauth-connector/OAuthConnector';
import { createConnector } from './sharedConnector';

const TestConnector = createConnector(OAuthConnector);

describe('sharedConnector authorizationType detection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { integration_type: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('sets OAUTH when oauth_client_id is set', () => {
    process.env.oauth_client_id = 'some-client-id';
    expect(new TestConnector('test').authorizationType).toBe(AuthorizationType.OAUTH);
  });

  it('sets OAUTH when variants is set (no plain oauth_client_id)', () => {
    process.env.variants = 'commercial,gov';
    expect(new TestConnector('test').authorizationType).toBe(AuthorizationType.OAUTH);
  });

  it('sets CUSTOM when only hyperproof_oauth_client_id is set', () => {
    process.env.hyperproof_oauth_client_id = 'hp-client-id';
    expect(new TestConnector('test').authorizationType).toBe(AuthorizationType.CUSTOM);
  });

  it('sets CUSTOM when only variant-prefixed client id keys are set', () => {
    process.env.gov_oauth_client_id = 'gov-client-id';
    expect(new TestConnector('test').authorizationType).toBe(AuthorizationType.CUSTOM);
  });

  it('sets MERGE_LINK when merge keys are set', () => {
    process.env.merge_api_key = 'merge-key';
    process.env.merge_create_link_token_url = 'https://merge.dev/link';
    expect(new TestConnector('test').authorizationType).toBe(AuthorizationType.MERGE_LINK);
  });
});
