import { ValidationTypes } from '@hyperproof/hypersync-models';
import createHttpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { CredentialFieldType, CustomAuthCredentials, ICredentialField, ICredentialsMetadata } from '../models';

/**
 * Server-side enforcement of the SSRF-relevant parts of a connector's declared credential-field schema.
 *
 * A connector's `credentialsMetadata` is otherwise consumed only by the React UI. Without server-side enforcement an
 * attacker can POST connection config off-menu with values the UI would never produce - e.g. a `region`/`instance`/
 * `domain` token containing `#`, `?`, `/`, or `@` that breaks out of a hardcoded vendor-URL template
 * (`https://${region}.api.vendor.com` -> `https://evil.com#.api.vendor.com`). The IP-based egress guard does not catch
 * that case because the breakout host can be a public attacker host.
 *
 * Lives in integration-sdk so every custom-auth connection write path can enforce it: the Hypersync connector
 * (`HypersyncAppConnector.validateCredentials`) and the Task connector (`TaskConnector.validateCredentials`).
 *
 * This intentionally enforces only what the SSRF threat requires - it is NOT a general schema validator:
 *  - Select fields must hold one of their declared option values (the value can never be an off-menu host).
 *  - Free-text fields that get interpolated into a URL must not contain host-breakout characters.
 * It deliberately does NOT re-enforce declared `alphaNumeric`/`uuid`/etc. formats: those are UI hints, several
 * connectors declare them more strictly than their real values (hyphenated slugs, non-UUID account ids, vendor
 * secrets), and enforcing them server-side would reject legitimate existing connections. URL/host/email fields are
 * exempt from the breakout check because they legitimately contain those characters and are not template tokens -
 * their SSRF exposure is handled by the egress guard, not here. Secret (`Password`) fields are never inspected.
 */

// Characters that can break a value out of the host when it is interpolated into a URL template: fragment/query/path
// delimiters, backslash (treated as '/' by the WHATWG parser), userinfo '@', and whitespace. Hyphens and dots are
// intentionally allowed - they are legal in hostnames and subdomains.
const HOST_BREAKOUT_PATTERN = /[#?/\\@\s]/;

// A value that is itself a full URL (carries a scheme) is a complete connection URL - e.g. an on-prem `gitLabUrl`
// stored in a plain Text field - not a vendor-template token. Its SSRF exposure is handled by the egress guard, so it
// is exempt from the host-breakout check (which would otherwise reject the URL's own '/' and ':').
const FULL_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// Validation types whose values legitimately contain URL/host/email punctuation and are not vendor-template tokens.
const URLISH_VALIDATION_TYPES: ReadonlySet<string> = new Set([
  ValidationTypes.url,
  ValidationTypes.urlOrHost,
  ValidationTypes.email
]);

const validateField = (field: ICredentialField, credentials: CustomAuthCredentials): void => {
  if (field.type === CredentialFieldType.Group) {
    for (const subField of field.fields ?? []) {
      validateField(subField, credentials);
    }
    return;
  }
  // Secrets are vendor-controlled in format and are never interpolated into a host, so we do not inspect them.
  if (field.type === CredentialFieldType.Hidden || field.type === CredentialFieldType.Password) {
    return;
  }

  const rawValue = credentials[field.name];
  // Required-ness is enforced by the connector's own validateCredentials; only constrain values that are present.
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return;
  }
  const value = String(rawValue);

  if (field.type === CredentialFieldType.Select) {
    const allowedValues = (field.options ?? []).map(option => String(option.value));
    if (!allowedValues.includes(value)) {
      throw createHttpError(StatusCodes.BAD_REQUEST, `Invalid value for '${field.name}'.`);
    }
    return;
  }

  if (field.validation && URLISH_VALIDATION_TYPES.has(field.validation.type)) {
    return;
  }

  if (FULL_URL_PATTERN.test(value)) {
    return;
  }

  if (HOST_BREAKOUT_PATTERN.test(value)) {
    throw createHttpError(StatusCodes.BAD_REQUEST, `Invalid value for '${field.name}'.`);
  }
};

/**
 * Enforces the SSRF-relevant field constraints of a connector's `credentialsMetadata` against submitted connection
 * values. Throws a 400 on the first violation. No-op when there is no field metadata.
 */
export const validateCredentialFields = (credentials: CustomAuthCredentials, metadata?: ICredentialsMetadata): void => {
  if (!metadata?.fields) {
    return;
  }
  for (const field of metadata.fields) {
    validateField(field, credentials);
  }
};
