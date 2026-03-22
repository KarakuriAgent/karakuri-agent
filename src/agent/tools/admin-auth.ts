export function isAdminUser(userId: string | undefined, adminUserIds: string[] = []): boolean {
  return userId != null && adminUserIds.includes(userId);
}

export function hasAdminToolAccess(userId: string | undefined, adminUserIds: string[] = []): boolean {
  return userId === 'system' || isAdminUser(userId, adminUserIds);
}

export function assertAdminUser(userId: string | undefined, adminUserIds: string[]): void {
  if (!hasAdminToolAccess(userId, adminUserIds)) {
    throw new Error('This tool is only available to administrator users.');
  }
}
