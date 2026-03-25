export type SnsVisibility = 'public' | 'unlisted' | 'private' | 'direct';

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
  getNotifications(params?: NotificationParams): Promise<SnsNotification[]>;
  uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult>;
  getThread(postId: string): Promise<ThreadResult>;
  getUserPosts(params: UserPostsParams): Promise<SnsPost[]>;
  getTrends(limit?: number): Promise<SnsPost[]>;
}
