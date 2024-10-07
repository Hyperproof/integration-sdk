import {
  AppId,
  HealthStatus,
  ObjectStatus,
  ObjectType,
  Priority
} from './enums';

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

export interface IHyperproofUser extends ISystemObject {
  id: string;
  email: string;
  givenName: string;
  surname: string;
  updatedOn: string;
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

export interface ICommentBody {
  appId: AppId;
  commentTextFormatted: string;
  externalUser: IExternalUser;
  mentionedExternalUsers: IExternalUser[];
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
}

export interface ITaskFieldSyncState {
  syncedOn?: string;
  syncResult?: TaskSyncResult;
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

export interface ITask extends IOrgObject {
  orgId: string;
  title: string;
  description?: string;
  assigneeId: string;
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

export interface ITaskPatch {
  taskStatusId?: string;
  priority?: Priority;
  dueDate?: string;
  clearDueDate?: boolean;
  description?: string;
  title?: string;
  externalUser?: IExternalUser;
  externalAssignee?: IExternalUser;
  externalFields?: any;
  taskTemplateId?: string;
  comments?: IActivity[];
  externalUserLinkPairMap?: {
    [userId: string]: {
      externalUserLink?: IExternalUserLink;
      organizationuser: IOrgUser;
    };
  };
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
  [key: string]: any;
}

export interface ITestExternalPermissionsResponse {
  permissions: IExternalPermission[];
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
