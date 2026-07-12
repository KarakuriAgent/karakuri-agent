export interface UserRecord {
  userId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserAlias {
  aliasUserId: string;
  primaryUserId: string;
  linkedAt: string;
  linkedBy: string | null;
  note: string | null;
}

export interface UserSearchOptions {
  limit?: number;
  offset?: number;
}

export interface LinkUserAliasOptions {
  note?: string | undefined;
  linkedBy?: string | undefined;
}

export interface IUserStore {
  getUser(userId: string): Promise<UserRecord | null>;
  ensureUser(userId: string, displayName: string): Promise<UserRecord>;
  searchUsers(query: string, options?: UserSearchOptions): Promise<UserRecord[]>;
  linkUserAlias?(aliasUserId: string, primaryUserId: string, opts?: LinkUserAliasOptions): Promise<void>;
  unlinkUserAlias?(aliasUserId: string): Promise<void>;
  listAliases?(primaryUserId: string): Promise<UserAlias[]>;
  listAliasesByPrimaryIds?(ids: string[]): Promise<Map<string, UserAlias[]>>;
  resolveAlias?(userId: string): Promise<{ primaryUserId: string; aliasOf: UserAlias | null }>;
  close(): Promise<void>;
}
