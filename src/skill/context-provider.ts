import { createLogger } from '../utils/logger.js';

const logger = createLogger('SkillContextRegistry');

export interface SkillContextProvider {
  getContext(): Promise<string>;
}

export class SkillContextRegistry {
  private readonly providers = new Map<string, SkillContextProvider>();

  register(skillName: string, provider: SkillContextProvider): void {
    if (this.providers.has(skillName)) {
      throw new Error(`Context provider already registered for skill "${skillName}"`);
    }
    this.providers.set(skillName, provider);
  }

  async getContext(skillName: string): Promise<string | null> {
    const provider = this.providers.get(skillName);
    if (provider == null) {
      return null;
    }

    try {
      return await provider.getContext();
    } catch (error) {
      logger.error(`Context provider for skill "${skillName}" failed`, error);
      return `[WARNING: "${skillName}" の動的コンテキスト取得に失敗しました。直近の活動データが利用できません。]`;
    }
  }
}
