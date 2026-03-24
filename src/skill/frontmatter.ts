import type { SkillDefinition } from './types.js';

const FRONTMATTER_DELIMITER = '---';
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const QUOTED_VALUE_PATTERN = /^("([\s\S]*)"|'([\s\S]*)')$/;

export type ParsedSkill = Omit<SkillDefinition, 'systemOnly'>;

export function parseSkillMarkdown(markdown: string): ParsedSkill {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new Error('SKILL.md must start with frontmatter');
  }

  const closingIndex = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, FRONTMATTER_DELIMITER.length + 1);
  if (closingIndex < 0) {
    throw new Error('SKILL.md frontmatter must end with a closing delimiter');
  }

  const frontmatterBlock = normalized.slice(FRONTMATTER_DELIMITER.length + 1, closingIndex);
  const body = normalized.slice(closingIndex + `\n${FRONTMATTER_DELIMITER}\n`.length).trim();

  if (body.length === 0) {
    throw new Error('SKILL.md body must not be empty');
  }

  const metadata = parseFrontmatter(frontmatterBlock);
  const name = parseRequiredString(metadata, 'name');
  const description = parseRequiredString(metadata, 'description');
  const allowedTools = parseOptionalCsvList(metadata, 'allowed-tools');

  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Skill name must match /^[a-z0-9][a-z0-9-]*$/');
  }

  assertNoUnknownKeys(metadata);

  return {
    name,
    description,
    instructions: body,
    ...(allowedTools != null ? { allowedTools } : {}),
  };
}

function parseFrontmatter(frontmatterBlock: string): Map<string, string> {
  const metadata = new Map<string, string>();

  for (const rawLine of frontmatterBlock.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid frontmatter line: ${rawLine}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (value.length === 0) {
      throw new Error(`Frontmatter value is required for ${key}`);
    }

    if (metadata.has(key)) {
      throw new Error(`Duplicate frontmatter key: ${key}`);
    }

    metadata.set(key, unwrapQuotedValue(value));
  }

  return metadata;
}

function parseRequiredString(metadata: Map<string, string>, key: string): string {
  const value = metadata.get(key)?.trim();
  if (value == null || value.length === 0) {
    throw new Error(`Frontmatter ${key} is required`);
  }

  return value;
}

function parseOptionalCsvList(metadata: Map<string, string>, key: string): string[] | undefined {
  const value = metadata.get(key)?.trim();
  if (value == null || value.length === 0) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  for (const item of items) {
    if (!TOOL_NAME_PATTERN.test(item)) {
      throw new Error(`Invalid tool name in ${key}: "${item}" must match /^[a-z][a-z0-9_]*$/`);
    }
  }

  return items.length > 0 ? items : undefined;
}

function assertNoUnknownKeys(metadata: Map<string, string>): void {
  for (const key of metadata.keys()) {
    if (!['name', 'description', 'allowed-tools'].includes(key)) {
      throw new Error(`Unknown frontmatter key: ${key}`);
    }
  }
}

function unwrapQuotedValue(value: string): string {
  const match = QUOTED_VALUE_PATTERN.exec(value);
  if (match == null) {
    return value;
  }

  return match[2] ?? match[3] ?? '';
}
