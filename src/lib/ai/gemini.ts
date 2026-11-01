export interface JsonRequest {
  system?: string;
  prompt: string;
  images?: { base64: string; mimeType: string }[];
  schema: object;
}

export interface GeminiDeps {
  generateContent: (params: { model: string; contents: unknown[]; config: unknown }) => Promise<{ text?: string }>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  model?: string;
  timeoutMs?: number;
}

export interface JsonClient {
  generateJson<T>(request: JsonRequest): Promise<T>;
}

export function createGeminiClient(deps: GeminiDeps): JsonClient {
  return {
    generateJson: async (request) => {
      const retries = deps.maxRetries ?? 4;
      const delay = deps.baseDelayMs ?? 2000;
      const model = deps.model ?? 'gemini-flash-latest';
      const timeoutMs = deps.timeoutMs ?? 180000;
      const sleep = deps.sleep || ((ms: number) => new Promise(r => setTimeout(r, ms)));

      let lastError: any = null;
      for (let i = 0; i <= retries; i++) {
        try {
          const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
            { text: request.prompt },
          ];
          for (const image of request.images ?? []) {
            parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } });
          }
          const response = await withTimeout(
            deps.generateContent({
              model,
              contents: [{ role: 'user', parts }],
              config: {
                responseMimeType: 'application/json',
                responseSchema: request.schema,
              },
            }),
            timeoutMs,
            () => new Error('UNAVAILABLE: tiempo de espera agotado en la IA')
          );
          if (!response.text) throw new Error('Respuesta vacía');
          try {
            return JSON.parse(response.text) as never;
          } catch {
            throw new Error('UNAVAILABLE: la IA devolvió un JSON inválido');
          }
        } catch (e: any) {
          const msg = e?.message || '';
          const isTransient = msg.includes('503') || msg.includes('429') || msg.includes('UNAVAILABLE') || msg.includes('high demand');
          lastError = e;
          if (i < retries && isTransient) {
            await sleep(delay * Math.pow(2, i));
            continue;
          }
          throw e;
        }
      }
      throw lastError || new Error('Fallo tras reintentos');
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  const guarded = promise.then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (error) => {
      clearTimeout(timer);
      throw error;
    }
  );
  return Promise.race([guarded, timeout]);
}
