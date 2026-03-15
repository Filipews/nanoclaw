import { NewMessage } from './types.js';

export type Complexity = 'simple' | 'complex';

const GREETING_PATTERN =
  /^(hi|hey|hello|oi|olá|ola|bom dia|boa tarde|boa noite|e aí|eai|fala|salve|yo|sup|gm|good morning|good afternoon|good evening|thanks|obrigado|obrigada|valeu|ok|okay|tudo bem|tudo certo|beleza|blz)\b/i;

const MULTI_STEP_PATTERN =
  /\b(then|after that|also|and then|depois|também|primeiro|em seguida)\b/i;

const TOOL_USE_PATTERN =
  /\b(search|create|run|build|deploy|check|file|send|delete|update|install|configure|setup|write|read|fix|debug|test|refactor|move|copy|rename|schedule|cancel|enviar|criar|apagar|verificar|rodar|mandar)\b/i;

const PATH_PATTERN = /(?:\/[\w.-]+){2,}|\.\w{2,4}\b/;

const CODE_BLOCK_PATTERN = /```/;

export function classifyComplexity(messages: NewMessage[]): Complexity {
  if (messages.length > 2) return 'complex';

  // Check for image attachments (content contains image reference markers)
  for (const msg of messages) {
    if (msg.content.includes('[image:') || msg.content.includes('[photo:')) {
      return 'complex';
    }
  }

  const totalContent = messages.map((m) => m.content).join(' ');

  if (totalContent.length >= 200) return 'complex';
  if (CODE_BLOCK_PATTERN.test(totalContent)) return 'complex';
  if (PATH_PATTERN.test(totalContent)) return 'complex';
  if (MULTI_STEP_PATTERN.test(totalContent)) return 'complex';
  if (TOOL_USE_PATTERN.test(totalContent)) return 'complex';

  // Simple: greeting or short single question
  if (messages.length === 1) {
    const content = messages[0].content.trim();
    if (GREETING_PATTERN.test(content)) return 'simple';
    // Short question (under 80 chars, single sentence)
    if (content.length < 80 && !content.includes('\n')) return 'simple';
  }

  // 2 messages, both short and no complex indicators — still simple
  if (messages.length === 2) {
    const allShort = messages.every((m) => m.content.trim().length < 60);
    if (allShort) return 'simple';
  }

  return 'complex';
}
