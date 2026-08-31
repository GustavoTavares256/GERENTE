// Provedor LLM configurável por ambiente, com interface compatível com a
// maioria das APIs (OpenAI, Groq, Together, Ollama, etc.).
// Sem API key configurada, `isConfigured()` retorna false e o sistema usa o
// fallback por regras.

export interface LLMOptions {
  /** Chave de API. Padrão: OPENAI_API_KEY */
  apiKey?: string;
  /** URL base da API (OpenAI-compatible). Padrão: OPENAI_BASE_URL */
  baseUrl?: string;
  /** Modelo. Padrão: OPENAI_MODEL */
  model?: string;
  /** Temperatura. Padrão: 0.4 */
  temperature?: number;
}

export class LLMError extends Error {}

function envFromOptions(
  opts: LLMOptions,
  keyName: string,
  baseName: string,
  modelName: string
): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: opts.apiKey ?? process.env[keyName] ?? "",
    baseUrl: opts.baseUrl ?? process.env[baseName] ?? "https://api.openai.com/v1",
    model: opts.model ?? process.env[modelName] ?? "gpt-4o-mini",
  };
}

export class LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;

  constructor(options: LLMOptions = {}) {
    const cfg = envFromOptions(
      options,
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL"
    );
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.model = cfg.model;
    this.temperature = options.temperature ?? Number(process.env.OPENAI_TEMPERATURE ?? "0.4");
  }

  /** true se há API key configurada (habilita chamada real ao LLM). */
  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Envia um prompt de texto e devolve a resposta.
   * @param system Instrução de sistema.
   * @param user Conteúdo do usuário.
   */
  async complete(system: string, user: string): Promise<string> {
    if (!this.isConfigured) {
      throw new LLMError("LLMProvider não configurado (falta OPENAI_API_KEY)");
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LLMError(`LLM API ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMError("LLM retornou resposta vazia");
    }
    return content.trim();
  }
}
