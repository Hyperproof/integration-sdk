import { validateCredentialFields } from './validateCredentialFields';

import { ValidationTypes } from '@hyperproof/hypersync-models';

import { CredentialFieldType, ICredentialsMetadata } from '../models';

const metadata = (fields: ICredentialsMetadata['fields']): ICredentialsMetadata => ({ fields });

describe('validateCredentialFields', () => {
  it('is a no-op when there is no metadata', () => {
    expect(() => validateCredentialFields({ region: 'anything' })).not.toThrow();
  });

  describe('Select fields', () => {
    const meta = metadata([
      {
        name: 'region',
        type: CredentialFieldType.Select,
        label: 'Region',
        options: [
          { value: 'us', label: 'US' },
          { value: 'eu', label: 'EU' }
        ]
      }
    ]);

    it('accepts a declared option value', () => {
      expect(() => validateCredentialFields({ region: 'eu' }, meta)).not.toThrow();
    });

    it('rejects an off-menu value (template-breakout attempt)', () => {
      expect(() => validateCredentialFields({ region: 'evil.com#' }, meta)).toThrow();
    });

    it('accepts a hidden option value (valid but not offered in the UI dropdown)', () => {
      const metaWithHidden = metadata([
        {
          name: 'region',
          type: CredentialFieldType.Select,
          label: 'Region',
          options: [
            { value: 'us-gov', label: 'US-GOV' },
            { value: 'https://api.crowdstrike.com', label: 'US-1', hidden: true }
          ]
        }
      ]);
      expect(() => validateCredentialFields({ region: 'https://api.crowdstrike.com' }, metaWithHidden)).not.toThrow();
    });
  });

  describe('free-text fields interpolated into a vendor-URL template', () => {
    const meta = metadata([
      {
        name: 'jiraCloudDomain',
        type: CredentialFieldType.Text,
        label: 'Domain',
        validation: { type: ValidationTypes.alphaNumeric }
      }
    ]);

    it.each(['mycompany', 'my-company', 'sub.example'])('allows a legitimate host token %s', value => {
      // Hyphens/dots are legal in hostnames; we no longer enforce the (over-strict, mis-declared) alphaNumeric format.
      expect(() => validateCredentialFields({ jiraCloudDomain: value }, meta)).not.toThrow();
    });

    it.each(['evil.com#', 'evil.com/x', 'evil.com?y', 'x@evil', 'has space', '127.0.0.1#'])(
      'rejects host-breakout value %s',
      value => {
        expect(() => validateCredentialFields({ jiraCloudDomain: value }, meta)).toThrow();
      }
    );
  });

  it('exempts url/host/email fields from the breakout check (handled by the egress guard)', () => {
    const meta = metadata([
      { name: 'siteUrl', type: CredentialFieldType.Text, label: 'Site', validation: { type: ValidationTypes.url } },
      { name: 'email', type: CredentialFieldType.Text, label: 'Email', validation: { type: ValidationTypes.email } }
    ]);
    expect(() =>
      validateCredentialFields({ siteUrl: 'https://example.com/path?q=1', email: 'a@b.com' }, meta)
    ).not.toThrow();
  });

  it('allows a full URL in a plain Text field (e.g. an on-prem gitLabUrl), http or https', () => {
    // gitLabUrl is CredentialFieldType.Text with no validation but holds a full URL; the breakout check must not
    // reject its own scheme/path characters.
    const meta = metadata([{ name: 'gitLabUrl', type: CredentialFieldType.Text, label: 'GitLab URL' }]);
    expect(() => validateCredentialFields({ gitLabUrl: 'https://gitlab.company.com/' }, meta)).not.toThrow();
    expect(() => validateCredentialFields({ gitLabUrl: 'http://hpgitlab.example.com/' }, meta)).not.toThrow();
  });

  it('never inspects Password (secret) or Hidden fields', () => {
    const meta = metadata([
      { name: 'apiKey', type: CredentialFieldType.Password, label: 'API Key' },
      { name: 'secret', type: CredentialFieldType.Hidden, label: 'Secret' }
    ]);
    // Secrets can legitimately contain '/', '@', '+', etc.
    expect(() => validateCredentialFields({ apiKey: 'abc/def+gh==@x', secret: 'anything#' }, meta)).not.toThrow();
  });

  it('recurses into Group fields', () => {
    const meta = metadata([
      {
        name: 'authChoice',
        type: CredentialFieldType.Group,
        label: 'Auth',
        fields: [
          {
            name: 'region',
            type: CredentialFieldType.Select,
            label: 'Region',
            options: [{ value: 'us', label: 'US' }]
          }
        ]
      }
    ]);
    expect(() => validateCredentialFields({ region: 'us' }, meta)).not.toThrow();
    expect(() => validateCredentialFields({ region: 'bad#' }, meta)).toThrow();
  });
});
