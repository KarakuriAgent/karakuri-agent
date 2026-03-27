export const LEGACY_KARAKURI_WORLD_SKILL_NAME = 'karakuri-world' as const;

export function isReservedSkillName(name: string): boolean {
  return name === LEGACY_KARAKURI_WORLD_SKILL_NAME;
}
