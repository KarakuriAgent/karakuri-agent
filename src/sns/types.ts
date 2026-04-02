export type SnsVisibility = 'public' | 'unlisted' | 'private' | 'direct';
export type SnsActivityType = SnsActivity['type'];

export interface SnsPostActivity {
  id: number;
  type: 'post';
  postId: string;
  text: string;
  replyToId?: string | undefined;
  quotePostId?: string | undefined;
  createdAt: string;
}

export interface SnsLikeActivity {
  id: number;
  type: 'like';
  postId: string;
  createdAt: string;
}

export interface SnsRepostActivity {
  id: number;
  type: 'repost';
  postId: string;
  createdAt: string;
}

export type SnsActivity = SnsPostActivity | SnsLikeActivity | SnsRepostActivity;

export interface ISnsActivityStore {
  recordPost(postId: string, text: string, replyToId?: string, quotePostId?: string): Promise<void>;
  recordLike(postId: string): Promise<void>;
  recordRepost(postId: string): Promise<void>;
  hasLiked(postId: string): Promise<boolean>;
  hasReposted(postId: string): Promise<boolean>;
  hasReplied(replyToId: string): Promise<boolean>;
  hasQuoted(postId: string): Promise<boolean>;
  getRecentActivities(limit?: number): Promise<SnsActivity[]>;
  getLastNotificationId(): Promise<string | null>;
  setLastNotificationId(notificationId: string): Promise<void>;
  reserveLastNotificationId?(notificationId: string): Promise<string>;
  commitLastNotificationReservation?(reservationToken: string): Promise<void>;
  releaseLastNotificationReservation?(reservationToken: string): Promise<void>;
  close(): Promise<void>;
}

export interface ScheduledPostParams {
  text: string;
  replyToId?: string | undefined;
  quotePostId?: string | undefined;
  mediaIds?: string[] | undefined;
  visibility: SnsVisibility;
}

export interface ScheduledLikeParams {
  postId: string;
}

export interface ScheduledRepostParams {
  postId: string;
}

export type ScheduledActionInput =
  | { actionType: 'post'; scheduledAt: Date; params: ScheduledPostParams }
  | { actionType: 'like'; scheduledAt: Date; params: ScheduledLikeParams }
  | { actionType: 'repost'; scheduledAt: Date; params: ScheduledRepostParams };

export type ScheduledAction = ScheduledActionInput & {
  id: number;
  status: 'pending' | 'executing';
  createdAt: string;
  recoveredFromExecuting?: boolean | undefined;
};

export type ActivityRecord =
  | {
      type: 'post';
      postId: string;
      text: string;
      replyToId?: string | undefined;
      quotePostId?: string | undefined;
      createdAt?: Date | undefined;
    }
  | {
      type: 'like';
      postId: string;
      createdAt?: Date | undefined;
    }
  | {
      type: 'repost';
      postId: string;
      createdAt?: Date | undefined;
    };

export interface ISnsScheduleStore {
  schedule(action: ScheduledActionInput): Promise<number>;
  claimPendingActions(now: Date, limit?: number): Promise<ScheduledAction[]>;
  completeWithRecord(id: number, record: ActivityRecord): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
  recoverStaleExecuting(before?: Date): Promise<number>;
  getPendingAndExecuting(): Promise<ScheduledAction[]>;
  close(): Promise<void>;
}

export interface SnsPost {
  id: string;
  timelineEntryId?: string | undefined;
  text: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  createdAt: string;
  url: string;
  visibility: SnsVisibility;
  inReplyToId?: string | undefined;
  repostCount: number;
  likeCount: number;
  replyCount: number;
  mediaUrls?: string[] | undefined;
  liked?: boolean | undefined;
  reposted?: boolean | undefined;
}

export interface SnsNotification {
  id: string;
  type: 'mention' | 'like' | 'repost' | 'follow' | 'reply' | 'other';
  createdAt: string;
  accountId: string;
  accountName: string;
  accountHandle: string;
  post?: SnsPost | undefined;
}

export interface PostParams {
  text: string;
  replyToId?: string | undefined;
  quotePostId?: string | undefined;
  mediaIds?: string[] | undefined;
  visibility?: SnsVisibility | undefined;
  idempotencyKey?: string | undefined;
}

export interface TimelineParams {
  limit?: number | undefined;
  sinceId?: string | undefined;
  maxId?: string | undefined;
}

export interface SearchParams {
  query: string;
  type?: 'posts' | 'users' | undefined;
  limit?: number | undefined;
}

export interface SnsUserSummary {
  id: string;
  name: string;
  handle: string;
  url: string;
}

export interface SearchResult {
  posts: SnsPost[];
  users: SnsUserSummary[];
}

export interface NotificationParams {
  limit?: number | undefined;
  types?: Array<'mention' | 'like' | 'repost' | 'follow' | 'reply' | 'other'> | undefined;
  sinceId?: string | undefined;
  maxId?: string | undefined;
}

export interface NotificationFetchResult {
  notifications: SnsNotification[];
  /**
   * 取得可能な通知をすべて取得できたかどうか。
   * `false` の場合（レート制限やページネーション上限など）、呼び出し側は通知カーソルを進めるべきではない。
   */
  complete: boolean;
}

export interface UploadMediaParams {
  url: string;
  altText?: string | undefined;
}

export interface UploadMediaResult {
  mediaId: string;
}

export interface ThreadResult {
  ancestors: SnsPost[];
  descendants: SnsPost[];
}

export interface UserPostsParams {
  userHandle: string;
  limit?: number | undefined;
  excludeReplies?: boolean | undefined;
}

export interface SnsProvider {
  post(params: PostParams): Promise<SnsPost>;
  getPost(postId: string): Promise<SnsPost>;
  getTimeline(params?: TimelineParams): Promise<SnsPost[]>;
  search(params: SearchParams): Promise<SearchResult>;
  like(postId: string): Promise<SnsPost>;
  repost(postId: string): Promise<SnsPost>;
  getNotifications(params?: NotificationParams): Promise<NotificationFetchResult>;
  uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult>;
  getThread(postId: string): Promise<ThreadResult>;
  getUserPosts(params: UserPostsParams): Promise<SnsPost[]>;
  getTrends(limit?: number): Promise<SnsPost[]>;
}
