import { HealthStatus, ObjectStatus, ObjectType, Priority } from './enums';

export interface IApiObject {
  id: string;
  permissions?: string[];
}

export interface ISystemObject extends IApiObject {
  createdBy: string;
  updatedBy: string;
  createdOn: string;
  updatedOn: string;
  status?: ObjectStatus;
}

export interface IOrgObject extends ISystemObject {
  orgId: string;
}

export interface IHyperproofUser extends ISystemObject, ILocalizable {
  id: string;
  email: string;
  givenName: string;
  surname: string;
  updatedOn: string;
}

export interface ILocalizable {
  language: string;
  locale: string;
  timeZone: string;
}

export interface IExternalUser {
  id: string;
  givenName: string;
  surname?: string;
  email?: string;
  resource?: string;
  avatarUrl?: string;
}

export interface IExternalGroup {
  id: string;
  name: string;
  avatarUrl?: string;
}

export type ExternalPrincipal = IExternalUser | IExternalGroup;

export interface IExternalGroupLink extends IOrgObject {
  groupId?: string;
  externalGroupId: string;
  externalName: string;
  instanceIntegrationId: string;
}

export interface ICommentBody {
  appId?: string;
  commentTextFormatted?: string;
  externalUser?: IExternalUser;
  mentionedExternalUsers?: IExternalUser[];
  sourceCommentId: string;
  sourceUpdatedOn: string;
}

export enum TaskSyncResult {
  Error = 'error',
  ErrorStatusUnmapped = 'errorStatusUnmapped',
  ErrorSurrogateAssignee = 'errorSurrogateAssignee',
  Updated = 'updated'
}

export interface ITaskSyncState {
  assignee: ITaskFieldSyncState;
  description: ITaskFieldSyncState;
  title: ITaskFieldSyncState;
  proof: ITaskFieldSyncState;
  status: ITaskFieldSyncState;
  dueDate: ITaskFieldSyncState;
  comment: ITaskFieldSyncState;
  group: ITaskFieldSyncState;
}

export interface ITaskFieldSyncState {
  syncedOn?: string;
  syncResult?: TaskSyncResult;
  externalGroupLinkId?: string;
  externalUserId?: string;
  failureMessage?: string;
}

export interface IObject {
  id: string;
  objectId: string;
}

export enum IntegrationSettingsClass {
  Hypersync = 'HypersyncIntegrationSettings',
  InstanceIntegrationSettings = 'InstanceIntegrationSettings',
  IntegrationSettings = 'IntegrationSettings',
  TaskIntegrationSettings = 'TaskIntegrationSettings'
}

export interface IIntegrationSettingsBase {
  class: IntegrationSettingsClass;
  isEnabled: boolean;
  externalConnectionId?: string;
  relatedSettingsId?: string;
}

export interface IIntegration<
  TIntegrationSettings extends IIntegrationSettingsBase
> extends IOrgObject {
  appId: string;
  objectId: string;
  objectType: ObjectType;
  settings: TIntegrationSettings;
}

export interface IIntegrationPostSystem {
  orgId: string;
  appId: string;
  settings: IIntegrationSettingsBase;
  parentObjectTypePlural: string;
  parentObjectId: string;
  exteralConnectionId?: string;
}

export interface IIntegrationFilterSystem {
  appId: string;
  orgId: string;
  parentObjectTypePlural: string;
  parentObjectId: string;
}

export interface IExternalConnectionPostSystem {
  externalUserId: string;
  appId: string;
  name: string;
  accountName: string;
  userId: string;
  hostUrl: string;
}
export interface IExternalConnectionFilterSystem {
  appIds: string[];
  externalUserId: string;
  ownedBy?: string;
  userId?: string;
  hostUrl?: string;
  includeArchived?: boolean;
}

export interface ITask extends IOrgObject {
  orgId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  targetId: string;
  targetType: string;
  targetObjectStatus: ObjectStatus;
  taskStatusId: string;
  priority: Priority;
  sortOrder: number;
  dueDate?: string;
  scopeName?: string;
  targetName: string;
  targetParentName?: string;
  targetParentId?: string;
  targetParentObjectType?: string;
  taskTemplateId?: string;
  closedOn?: string;
}

export interface ITaskStatus extends IOrgObject {
  name: string;
  type: TaskStatusType;
  sortOrder: number;
  icon: string;
  color: string;
}

export enum TaskStatusType {
  NotStarted = 'notStarted',
  InProgress = 'inProgress',
  Submitted = 'submitted',
  Closed = 'closed',
  Cancelled = 'cancelled'
}

// Used for updating a Hyperproof task
export interface ITaskPatch {
  clearDueDate?: boolean;
  clearGroupId?: boolean;
  comments?: IActivity[];
  description?: string;
  dueDate?: string;
  externalAssignee?: IExternalUser;
  externalFields?: any;
  externalGroup?: IExternalGroup;
  externalUser?: IExternalUser;
  groupId?: string;
  priority?: Priority;
  taskStatusId?: string;
  taskTemplateId?: string;
  ticketStatusId?: string;
  title?: string;
}

// Updates from the Hyperproof Task that should be applied to the external ticket
export interface ITicketPatch {
  clearAssigneeId?: boolean;
  clearDueDate?: boolean;
  comments?: IActivity[];
  description?: string;
  dueDate?: string;
  externalAssignee?: IExternalUser;
  externalFields?: any;
  externalGroupLink?: IExternalGroupLink;
  externalUser?: IExternalUser;
  externalUserLinkPairMap?: IExternalUserLinkPairMap;
  externalUserLinks?: IExternalUserLink[];
  group?: string;
  priority?: Priority;
  taskStatusId?: string;
  taskTemplateId?: string;
  ticketStatusId?: string;
  title?: string;
}

export interface IExternalFields {
  [id: string]: string | string[] | object | number;
}

export interface IExternalUserLinkPairMap {
  [userId: string]: {
    externalUserLink?: IExternalUserLink;
    organizationUser: IOrgUser;
  };
}

export interface IProofPost extends IProofPostBase {
  objectType: ObjectType;
  objectId: string;
}

export interface IProofVersionPost extends IProofPostBase {
  proofId: string;
}

export interface IProofPostBase {
  file: Buffer;
  filename: string;
  mimeType: string;
  sourceId?: string;
  sourceFileId: string;
  sourceModifiedOn?: string;
  sourceIntegrationId?: string;
  user?: IExternalUser;
  size?: number;
}

export interface IProof extends IOrgObject {
  version: number;
  ownedBy: string;
  uploadedOn: string;
  source: string;
  sourceId?: string;
  sourceIntegrationId?: string;
  integrationStatus: string;
  sourceFileId?: string;
  sourceModifiedOn?: string;
  providedByExternalUserLinkId?: string;
}

export interface IArchiveProofLinkPost {
  proofId: string;
  objectId: string;
  objectType: ObjectType;
  externalUser?: IExternalUser;
}

export interface IActivity extends IOrgObject {
  createdByAppId: string;
  commentTextFormatted: string;
  commentPlainText: string;
  editedOn: Date;
  event: string;
  newVersion: number;
  objectId: string;
  objectType: ObjectType;
  sourceCommentId: string;
  sourceUpdatedOn: Date;
  deletedOn: Date;
  isInternal: boolean;
}

export interface IExternalUserLink extends IOrgObject {
  orgUserId?: string;
  userId?: string;
  source: string;
  resource?: string;
  externalUserId: string;
  userUpdatedOn: string;
  givenName: string;
  surname: string;
}

export interface IOrgUser extends IOrgObject {
  userId: string;
  type: string;
  givenName: string;
  surname: string;
  externalUserLinks: IExternalUserLink[];
  roleIds: string[];
  lastLogin: string;
}

export interface IConnectionHealth {
  healthStatus: HealthStatus;
  statusCode: number;
  message?: string;
  details?: string;
}

export interface ICheckConnectionHealthInvocationPayload {
  hostUrl: string;
}

export interface ITestExternalPermissionsBody {
  appId: string;
  projectId?: string;
  hostUrl: string;
  externalConnectionId: string;
  adminExternalConnectionId: string;
  vendorUserId: string;
  adminVendorUserId: string;
  [key: string]: any;
}

export interface ITestExternalPermissionsResponse {
  permissions: IExternalPermission[];
}

/**
 * Object returned from the validateCredentials method.
 *
 * Ideally all validateCredentials implementers would return only the vendorUserId
 * and vendorUserProfile members.  But for historical reasons we also allow connectors
 * to return other, arbitrary values which will be blended into the persisted user context.
 */
export interface IValidateCredentialsResponse {
  vendorUserId: string;
  vendorUserProfile?: object;
  [key: string]: any;
}

export interface IExternalPermission {
  label: string;
  havePermission: boolean;
  required?: boolean;
}

/**
 * An option that may be chosen in a select control.
 *
 * Please keep this in sync with the same interface in
 * @hyperproof/hypersync-models.  We want to avoid a dependency
 * between the two libraries (hypersync-models is designed to
 * be small and light) but we definitely need the interface in
 * both places.
 */
export interface ISelectOption {
  value: string | number;
  label: string;
}

export interface IExTag {
  id: string;
  name: string;
}
