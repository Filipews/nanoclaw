import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function transcribeAudio(
  buffer: Buffer,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set in .env, cannot transcribe audio');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(buffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    const text = (transcription as unknown as string).trim();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'Audio transcription failed');
    return null;
  }
}
