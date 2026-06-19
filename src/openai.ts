const whisperUrl = "https://api.openai.com/v1/audio/transcriptions";
const polishModel = "gpt-4o-mini";

export interface TranscribeOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface PolishOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  options: TranscribeOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new FormData();
  body.append("model", "whisper-1");
  body.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");

  const response = await fetchImpl(whisperUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body,
  });

  await ensureOk(response, "transcription");
  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not contain text.");
  }

  return payload.text;
}

export async function polishTranscript(
  rawTranscript: string,
  options: PolishOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: polishModel,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are a text cleanup step.",
            "Fix only punctuation, grammar, and spoken list formatting.",
            "Do not remove, reorder, merge, or rewrite any content.",
            "Do not infer self-corrections.",
            "Preserve the speaker's tone and vocabulary.",
          ].join(" "),
        },
        {
          role: "user",
          content: rawTranscript,
        },
      ],
    }),
  });

  await ensureOk(response, "Polish");
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("OpenAI Polish response did not contain text.");
  }

  return content;
}

async function ensureOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const detail = await safeResponseText(response);
  throw new Error(`OpenAI ${operation} failed: ${response.status} ${response.statusText}${detail}`);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? ` - ${text}` : "";
  } catch {
    return "";
  }
}
