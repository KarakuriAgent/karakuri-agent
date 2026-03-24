export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  systemOnly: boolean;
}

export interface SkillFilterOptions {
  includeSystemOnly?: boolean;
}

export interface ISkillStore {
  listSkills(options?: SkillFilterOptions): Promise<SkillDefinition[]>;
  getSkill(name: string, options?: SkillFilterOptions): Promise<SkillDefinition | null>;
  close(): Promise<void>;
}
