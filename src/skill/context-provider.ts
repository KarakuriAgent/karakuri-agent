import { createLogger } from '../utils/logger.js';

const logger = createLogger('SkillContextRegistry');

export interface SkillContextResult {
  text: string;
  onSuccess?: (() => Promise<void>) | undefined;
  onAbort?: (() => Promise<void>) | undefined;
}

export interface SkillContextProvider {
  getContext(): Promise<SkillContextResult>;
}

export class SkillContextScope {
  private readonly onSuccessCallbacks: Array<() => Promise<void>> = [];
  private readonly onAbortCallbacks: Array<() => Promise<void>> = [];

  constructor(private readonly providers: ReadonlyMap<string, SkillContextProvider>) {}

  async getContext(skillName: string): Promise<string | null> {
    const provider = this.providers.get(skillName);
    if (provider == null) {
      return null;
    }

    try {
      const result = await provider.getContext();
      if (result.onSuccess != null) {
        this.onSuccessCallbacks.push(result.onSuccess);
      }
      if (result.onAbort != null) {
        this.onAbortCallbacks.push(result.onAbort);
      }
      return result.text;
    } catch (error) {
      logger.error(`Context provider for skill "${skillName}" failed`, error);
      return `[WARNING: "${skillName}" の動的コンテキスト取得に失敗しました。直近の活動データが利用できません。]`;
    }
  }

  async commit(): Promise<void> {
    for (const callback of this.onSuccessCallbacks) {
      try {
        await callback();
      } catch (error) {
        logger.error('Skill context success hook failed', error);
      }
    }
    this.clearCallbacks();
  }

  async abort(): Promise<void> {
    for (const callback of this.onAbortCallbacks) {
      try {
        await callback();
      } catch (error) {
        logger.error('Skill context abort hook failed', error);
      }
    }
    this.clearCallbacks();
  }

  private clearCallbacks(): void {
    this.onSuccessCallbacks.length = 0;
    this.onAbortCallbacks.length = 0;
  }
}

export class SkillContextRegistry {
  private readonly providers = new Map<string, SkillContextProvider>();

  register(skillName: string, provider: SkillContextProvider): void {
    if (this.providers.has(skillName)) {
      throw new Error(`Context provider already registered for skill "${skillName}"`);
    }
    this.providers.set(skillName, provider);
  }

  createScope(): SkillContextScope {
    return new SkillContextScope(this.providers);
  }
}
