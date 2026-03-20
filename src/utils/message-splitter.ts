export const DISCORD_MESSAGE_LIMIT = 2_000;

type Segment =
  | { type: 'text'; text: string }
  | { type: 'code'; fence: string; content: string };

function parseSegments(input: string): Segment[] {
  const lines = input.split('\n');
  const segments: Segment[] = [];
  let textBuffer = '';
  let codeBuffer = '';
  let currentFence: string | null = null;

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ type: 'text', text: textBuffer });
      textBuffer = '';
    }
  };

  for (const [index, line] of lines.entries()) {
    const suffix = index < lines.length - 1 ? '\n' : '';

    if (currentFence == null) {
      if (line.startsWith('```')) {
        flushText();
        currentFence = line;
        codeBuffer = '';
      } else {
        textBuffer += line + suffix;
      }
      continue;
    }

    if (line.startsWith('```')) {
      segments.push({ type: 'code', fence: currentFence, content: codeBuffer });
      currentFence = null;
      textBuffer = suffix;
      continue;
    }

    codeBuffer += line + suffix;
  }

  if (currentFence != null) {
    textBuffer += `${currentFence}\n${codeBuffer}`;
  }

  flushText();
  return segments;
}

function chooseSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return text.length;
  }

  const newlineIndex = text.lastIndexOf('\n', maxLength);
  if (newlineIndex > 0) {
    return newlineIndex + 1;
  }

  const spaceIndex = text.lastIndexOf(' ', maxLength);
  if (spaceIndex > 0) {
    return spaceIndex + 1;
  }

  return maxLength;
}

function splitPlainText(text: string, maxLength: number): string[] {
  if (text.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const splitIndex = chooseSplitIndex(remaining, maxLength);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitCodeBlock(fence: string, content: string, maxLength: number): string[] {
  const opening = `${fence}\n`;
  const closing = '```';
  const body = content.endsWith('\n') ? content : `${content}\n`;
  const overhead = opening.length + closing.length;

  if (overhead + body.length <= maxLength) {
    return [`${opening}${body}${closing}`];
  }

  const payloadLimit = maxLength - overhead - 1;
  if (payloadLimit <= 0) {
    return splitPlainText(`${opening}${body}${closing}`, maxLength);
  }

  return splitPlainText(content, payloadLimit).map((chunk) => {
    const chunkBody = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
    return `${opening}${chunkBody}${closing}`;
  });
}

export function splitMessageForDiscord(
  text: string,
  maxLength = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (text.length === 0) {
    return [];
  }

  const pieces = parseSegments(text).flatMap((segment) =>
    segment.type === 'text'
      ? splitPlainText(segment.text, maxLength)
      : splitCodeBlock(segment.fence, segment.content, maxLength),
  );

  const chunks: string[] = [];
  let currentChunk = '';

  for (const piece of pieces) {
    if (currentChunk.length === 0) {
      currentChunk = piece;
      continue;
    }

    if (currentChunk.length + piece.length <= maxLength) {
      currentChunk += piece;
      continue;
    }

    chunks.push(currentChunk);
    currentChunk = piece;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
