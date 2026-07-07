import { APICallError } from 'ai';

const REPETITIVE_TOOL_CALL_MESSAGE_PATTERN = /repetitive tool calls?/i;

/**
 * DashScope 等が「同一 tool-call の連続」をガードレールで検知して 400 を返した場合を判定する。
 * message / responseBody のどちらに文言が載るかはプロバイダ実装依存のため両方見る。
 */
export function isRepetitiveToolCallError(error: unknown): error is APICallError {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode !== 400) return false;
  const haystack = `${error.message}\n${error.responseBody ?? ''}`;
  return REPETITIVE_TOOL_CALL_MESSAGE_PATTERN.test(haystack);
}
