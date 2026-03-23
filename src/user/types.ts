export interface UserRecord {
  userId: string;
  displayName: string;
  profile: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserSearchOptions {
  limit?: number;
  offset?: number;
}

export interface IUserStore {
  getUser(userId: string): Promise<UserRecord | null>;
  ensureUser(userId: string, displayName: string): Promise<UserRecord>;
  updateProfile(userId: string, profile: string | null): Promise<void>;
  updateDisplayName(userId: string, displayName: string): Promise<void>;
  searchUsers(query: string, options?: UserSearchOptions): Promise<UserRecord[]>;
  close(): Promise<void>;
}
