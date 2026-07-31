const env = process.env;
const apiKey = env.LLM_APPRAISAL_API_KEY ?? env.LLM_API_KEY;
const baseUrl = (env.LLM_APPRAISAL_BASE_URL ?? env.LLM_BASE_URL ?? '').replace(/\/$/, '');
const selector = env.LLM_APPRAISAL_MODEL ?? env.LLM_MODEL ?? '';
const model = selector.replace(/^openai\/chat\//, '').replace(/^openai\//, '');

if (!apiKey || !baseUrl || !model) {
  throw new Error('Missing appraisal API configuration');
}

const delta = {
  type: 'string',
  enum: ['large_down', 'down', 'small_down', 'none', 'small_up', 'up', 'large_up'],
};
const appraisalSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'valence_delta', 'energy_delta', 'hunger_delta', 'social_delta', 'sleep',
    'salience', 'relation_candidates', 'prospect_candidates', 'segmentation',
  ],
  properties: {
    valence_delta: delta,
    energy_delta: delta,
    hunger_delta: delta,
    social_delta: delta,
    sleep: { type: 'string', enum: ['fell_asleep', 'woke_up', 'no_change'] },
    salience: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    relation_candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'relation', 'object', 'note'],
        properties: {
          subject: { type: 'string' },
          relation: { type: 'string' },
          object: { type: 'string' },
          note: { type: ['string', 'null'] },
        },
      },
    },
    prospect_candidates: { type: 'array', items: { type: 'object' } },
    segmentation: { type: 'array', items: { type: 'object' } },
  },
};

const samples = [
  'Yamashita told Kanon that Alice was hurt after Kanon declined her invitation. Yamashita is Kanon\'s friend and cares about her relationships.',
  'Kanon ate a sandwich alone at the park. No other person interacted with her.',
  'Bob promised Kanon that he would meet her tomorrow morning, and Kanon felt happy about it.',
];

const system = 'Return a complete appraisal. Every relation candidate must contain subject, relation, object, and note. Use empty arrays when there are no candidates.';

function validate(value) {
  const missingTop = appraisalSchema.required.filter((key) => !(key in (value ?? {})));
  const relations = Array.isArray(value?.relation_candidates) ? value.relation_candidates : [];
  const badRelations = relations.flatMap((item, index) =>
    ['subject', 'relation', 'object', 'note']
      .filter((key) => !(key in (item ?? {})))
      .map((key) => `relation_candidates[${index}].${key}`));
  return [...missingTop, ...badRelations];
}

async function request(mode, sample, index) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: sample }],
    temperature: 0,
    max_tokens: 1200,
  };
  if (mode === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'appraisal', strict: true, schema: appraisalSchema },
    };
  } else {
    body.tools = [{
      type: 'function',
      function: {
        name: 'submit_appraisal',
        description: 'Submit the complete appraisal result',
        strict: true,
        parameters: appraisalSchema,
      },
    }];
    body.tool_choice = { type: 'function', function: { name: 'submit_appraisal' } };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    return { mode, sample: index + 1, http: response.status, error: json?.error?.message ?? json };
  }
  const message = json?.choices?.[0]?.message;
  const raw = mode === 'schema'
    ? message?.content
    : message?.tool_calls?.[0]?.function?.arguments;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode, sample: index + 1, http: response.status, calledTool: Boolean(message?.tool_calls?.length), parseError: true, raw };
  }
  return {
    mode,
    sample: index + 1,
    http: response.status,
    calledTool: Boolean(message?.tool_calls?.length),
    missing: validate(parsed),
    relationCandidates: parsed.relation_candidates,
    usage: json.usage,
  };
}

for (const mode of ['schema', 'tool']) {
  for (const [index, sample] of samples.entries()) {
    console.log(JSON.stringify(await request(mode, sample, index)));
  }
}
