import { OAuthConnector } from './OAuthConnector';

const makeCtx = (configuration: Record<string, string> = {}) => ({ configuration } as any);

// Access the method via the prototype directly — no need to instantiate the full connector.
// Bind `this` to the prototype so `this.resolveVariant` resolves to the base identity passthrough.
const withVariantConfig = (ctx: any, variantId?: string) =>
  OAuthConnector.prototype.withVariantConfig.call(OAuthConnector.prototype, ctx, variantId);

describe('withVariantConfig', () => {
  it('returns ctx unchanged when no variant is resolved', () => {
    const ctx = makeCtx({ oauth_client_id: 'base-id', fusebit_allowed_return_to: 'https://example.com' });
    expect(withVariantConfig(ctx, undefined)).toBe(ctx);
  });

  it('returns ctx unchanged when no prefixed keys match the resolved variant', () => {
    const ctx = makeCtx({ oauth_client_id: 'base-id' });
    expect(withVariantConfig(ctx, 'gov')).toBe(ctx);
  });

  it('overlays matching-variant prefixed keys onto the plain configuration keys', () => {
    const ctx = makeCtx({
      commercial_oauth_client_id: 'commercial-id',
      commercial_oauth_authorization_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      gov_oauth_client_id: 'gov-id',
      gov_oauth_authorization_url: 'https://login.microsoftonline.us/common/oauth2/v2.0/authorize',
      oauth_scope: 'shared-scope'
    });
    const result = withVariantConfig(ctx, 'gov');

    expect(result.configuration.oauth_client_id).toBe('gov-id');
    expect(result.configuration.oauth_authorization_url).toBe(
      'https://login.microsoftonline.us/common/oauth2/v2.0/authorize'
    );
    expect(result.configuration.oauth_scope).toBe('shared-scope');
  });

  it('does not mutate the original ctx', () => {
    const ctx = makeCtx({ gov_oauth_client_id: 'gov-id' });
    withVariantConfig(ctx, 'gov');

    expect(ctx.configuration.gov_oauth_client_id).toBe('gov-id');
    expect(ctx.configuration.oauth_client_id).toBeUndefined();
  });

  it('leaves unrelated configuration keys with underscores untouched', () => {
    const ctx = makeCtx({
      gov_oauth_client_id: 'gov-id',
      fusebit_allowed_return_to: 'https://example.com/callback',
      integration_type: 'azureAD'
    });
    const result = withVariantConfig(ctx, 'gov');

    expect(result.configuration.fusebit_allowed_return_to).toBe('https://example.com/callback');
    expect(result.configuration.integration_type).toBe('azureAD');
  });
});
