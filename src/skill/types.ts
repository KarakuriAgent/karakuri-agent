export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

export interface ISkillStore {
  listSkills(): Promise<SkillDefinition[]>;
  getSkill(name: string): Promise<SkillDefinition | null>;
  close(): Promise<void>;
}
