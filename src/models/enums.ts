export enum ALERT_CARD_STYLE {
  Success = 'success',
  Info = 'info',
  Warning = 'warning',
  Failure = 'failure',
  Danger = 'danger'
}

export enum CriteriaPageMessageLevel {
  Success = 'success',
  Info = 'info',
  Warning = 'warning',
  Failure = 'failure',
  Danger = 'danger'
}

export enum AuthorizationType {
  OAUTH = 'oauth',
  CUSTOM = 'custom'
}

export enum AppId {
  ASANA = 'asana',
  AWS = 'aws',
  AZURE = 'azure',
  GITHUB = 'gitHub',
  JIRA = 'jira',
  JIRA_HS = 'jiraHs',
  SLACK = 'slack'
}

export enum InstanceType {
  JiraCloud = 'jiraCloud',
  JiraServer = 'jiraServer'
}

export enum LogContextKey {
  ApiUrl = 'apiUrl',
  Category = 'category',
  ExtendedMessage = 'extendedMessage',
  Headers = 'headers',
  HttpVersion = 'httpVersion',
  HypersyncCriteria = 'hypersyncCriteria',
  HypersyncSettings = 'hypersyncSettings',
  HypersyncStage = 'hypersyncStage',
  IntegrationId = 'integrationId',
  Level = 'level',
  Message = 'message',
  Payload = 'payload',
  Referrer = 'referrer',
  RemoteAddress = 'remoteAddress',
  RequestMethod = 'requestMethod',
  RequestPath = 'requestPath',
  ResponseContentLength = 'responseContentLength',
  ResponseTime = 'responseTime',
  StackTrace = 'stackTrace',
  StatusCode = 'statusCode',
  Subscribers = 'subscribers',
  Timestamp = '@timestamp',
  TraceId = 'traceId',
  Url = 'url',
  UserAgent = 'userAgent',
  UserId = 'userId'
}

export enum MimeType {
  APPLICATION_JSON = 'application/json',
  CSV_MIME = 'text/csv',
  FORM_URL_ENCODED = 'application/x-www-form-urlencoded',
  HTML = 'text/html',
  HYPERSYNC_DATA = 'application/vnd.hyperproof.hypersync.data',
  OCTET_MIME_APP = 'application/octet-stream',
  OCTET_MIME_BINARY = 'binary/octet-stream'
}

export enum ObjectType {
  CONTROL = 'control',
  LABEL = 'label',
  ORGANIZATION = 'organization',
  TASK = 'task',
  USER = 'user',
  USER_ACCESS_CAMPAIGN_SOURCE = 'userAccessCampaignSource'
}

export enum ObjectStatus {
  Active = 'active',
  Archived = 'archived',
  Pending = 'pending',
  Canceled = 'canceled',
  Deleted = 'deleted'
}

export enum ProofLinkState {
  ACCEPTED = 'accepted',
  ACTIVE = 'active',
  OUTDATED = 'outdated',
  REJECTED = 'rejected',
  SUBMITTED = 'submitted',
  UNSUBMITTED = 'unsubmitted'
}

export enum ProofSyncResult {
  NO_UPDATE_NEEDED = 'noUpdateNeeded',
  UPDATED = 'updated',
  MISSING_TOKEN = 'missingToken',
  UNAUTHORIZED = 'unauthorized',
  MISSING_FILE = 'missingFile',
  OTHER_ERROR = 'otherError'
}

export enum Priority {
  Highest = 'highest',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
  Lowest = 'lowest'
}

export enum HttpMethod {
  DELETE = 'DELETE',
  GET = 'GET',
  HEAD = 'HEAD',
  PATCH = 'PATCH',
  POST = 'POST',
  PUT = 'PUT'
}

export enum HttpHeader {
  Authorization = 'Authorization',
  Baggage = 'baggage',
  ContentLength = 'Content-Length',
  ContentType = 'Content-Type',
  ExternalServiceHeaders = 'hp-external-service-headers',
  HyperproofClientSecret = 'hp-client-secret',
  SubscriptionKey = 'hyperproof-subscription-key',
  TraceParent = 'traceparent'
}

export enum HealthStatus {
  Healthy = 'healthy',
  Unhealthy = 'unhealthy',
  Unknown = 'unknown',
  NotImplemented = 'notImplemented'
}

export const HYPERPROOF_VENDOR_KEY = 'hyperproof';

export const FOREIGN_VENDOR_USER = 'foreign-vendor-user';
