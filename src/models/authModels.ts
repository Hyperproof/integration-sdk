import { CredentialFieldType } from './credentials';
import { AuthorizationType } from './enums';
import { ISelectOption, IValidation } from './hyperproofApiModels';

/**
 * Metadata for a field that is used to provide credentials in a custom
 * auth application.
 */
export interface ICredentialField {
  name: string;
  type: CredentialFieldType;
  label: string;
  placeholder?: string;
  options?: ISelectOption[];
  fields?: ICredentialField[];
  value?: string;
  isDisabled?: boolean;
  validation?: IValidation;
}

export interface ICredentialsMetadata {
  instructionHeader?: string;
  instructionBody?: string;
  fields: ICredentialField[];
}

/**
 * Type of the object that is used to store the access keys, API keys,
 * etc. that are used to authenticate in a custom authentication Hypersync.
 */
export type CustomAuthCredentials = {
  [key: string]: string | boolean | number | object;
};

export interface IAuthorizationConfigBase {
  integrationType: string;
  appId?: string;
  authorizationType: AuthorizationType;
  authUrl?: string;
  outboundOnly: boolean;
  vendorPrefix: string;
  credentialsMetadata?: ICredentialsMetadata;
}

export interface IAuthorizationConfig extends IAuthorizationConfigBase {
  hyperproofClientId: string;
  hyperproofRedirectUrl: string;
  hyperproofScopes: string[];
}
