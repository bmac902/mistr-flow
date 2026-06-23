import type { VocabularyConfig } from "./config";

export function buildWhisperVocabularyPrompt(vocabulary: VocabularyConfig | null): string | null {
  if (!vocabulary) return null;

  const items = [...vocabulary.terms, ...vocabulary.phrases];
  if (items.length === 0) return null;

  return `Prefer these spellings and phrases when they match the audio: ${items.join("; ")}.`;
}

export function buildPolishVocabularyInstruction(vocabulary: VocabularyConfig | null): string | null {
  if (!vocabulary) return null;

  const hasTerms = vocabulary.terms.length > 0 || vocabulary.phrases.length > 0;
  const hasReplacements = vocabulary.replacements.length > 0;

  if (!hasTerms && !hasReplacements) return null;

  const parts: string[] = ["Vocabulary correction context:"];

  if (hasTerms) {
    const items = [...vocabulary.terms, ...vocabulary.phrases];
    parts.push(
      `Preserve these spellings and phrases when the transcript appears to refer to them: ${items.join("; ")}.`,
    );
  }

  if (hasReplacements) {
    const pairs = vocabulary.replacements.map((r) => `"${r.wrong}" -> "${r.right}"`).join("; ");
    parts.push(
      `If a transcript contains an obvious mishearing from this list, replace only that span: ${pairs}.`,
    );
  }

  parts.push(
    "Use vocabulary context only to fix spelling or obvious transcription confusions; do not introduce a term unless the transcript appears to contain that spoken term.",
  );

  return parts.join(" ");
}
