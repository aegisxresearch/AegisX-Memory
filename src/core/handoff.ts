/**
 * Deterministic handoff extraction — the write half of the memory loop.
 *
 * Until now only the *read* half was deterministic: a hook injected the recall
 * block whether or not the model cooperated. Saving still depended on the model
 * obeying a nudge, so a session that ignored the reminder left no trace — the
 * common case, and the one that keeps the knowledge store empty.
 *
 * This module turns a transcript into a handoff using rules only: no model, no
 * network, no clock beyond the caller's. Same transcript in, same handoff out,
 * which is what makes the auto-save hook testable and safe to run on every turn.
 *
 * What is deliberately *not* here:
 *  - secrets are not screened; `Engine.saveSessionCheckpoint` does that, so the
 *    refusal contract lives in one place for both the manual and automatic path;
 *  - storage is not here either. This is a pure function of the transcript.
 *
 * The transcript shapes are whatever the agent sends: OpenAI `tool_calls`,
 * Anthropic `content` parts, or Hermes' flattened messages. Normalizing all of
 * them here means one extractor, not one per client.
 */
import type { SessionHandoffInput } from './types.js';

/** Longest a derived list item may be. Well under the store's
 *  `HANDOFF_STRING_MAX` (1_000): these are index lines, not sentences to read. */
export const HANDOFF_ITEM_MAX = 200;
/** Most items a derived list may carry. The store allows 20; a handoff is a
 *  summary, and 20 bullets recall nothing. */
export const HANDOFF_LIST_MAX = 6;
/** Most facts (commands + changed files) a derived handoff may carry. */
export const HANDOFF_FACTS_MAX = 8;
/** Longest goal line. The store allows 1_000; a goal is one line. */
export const HANDOFF_GOAL_MAX = 200;

/** One message as an agent hands it over, in any of the three dialects. */
export interface TranscriptInput {
  /** Message objects, oldest first, as the agent keeps them. */
  messages: unknown[];
  /** The turn's assistant reply, when the event carries it beside the history. */
  assistantResponse?: string;
  /** The turn's user message, when the event carries it beside the history. */
  userMessage?: string;
}

/** A message flattened to what extraction needs: prose, and any tool activity. */
interface NormalizedMessage {
  role: string;
  text: string;
  tools: ToolActivity[];
}

interface ToolActivity {
  name: string;
  args: Record<string, unknown>;
}

/** Markers a recall block is wrapped in. The block is injected *into* the user
 *  message, so a naive reader would mine our own prompt as if the user wrote
 *  it — the failure mode that makes an auto-save hook produce nonsense facts. */
const BLOCK_BEGIN = 'AEGISX-MEMORY:BEGIN';
const BLOCK_END = 'AEGISX-MEMORY:END';

/** Drop any injected memory block (marker lines included). */
export function stripInjectedMemory(text: string): string {
  if (!text.includes(BLOCK_BEGIN)) return text;
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.includes(BLOCK_BEGIN)) {
      inside = true;
      continue;
    }
    if (line.includes(BLOCK_END)) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Prose out of a message `content`, whichever shape it arrives in. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    const record = asRecord(part);
    if (record === null) continue;
    // Anthropic text parts; anything else (images, thinking) is not prose.
    if (typeof record['text'] === 'string') parts.push(record['text']);
  }
  return parts.join('\n');
}

/** Tool arguments arrive as an object (Anthropic/Hermes) or a JSON string
 *  (OpenAI). Unparseable arguments keep the call but drop its args. */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  const direct = asRecord(raw);
  if (direct !== null) return direct;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

/** Every tool call in one message, across the three dialects. */
function toolCallsOf(message: Record<string, unknown>): ToolActivity[] {
  const out: ToolActivity[] = [];
  const calls = message['tool_calls'];
  if (Array.isArray(calls)) {
    for (const entry of calls) {
      const record = asRecord(entry);
      if (record === null) continue;
      const fn = asRecord(record['function']);
      const name = typeof fn?.['name'] === 'string'
        ? fn['name']
        : typeof record['name'] === 'string'
          ? record['name']
          : '';
      const rawArgs = fn !== undefined && fn !== null ? fn['arguments'] : record['input'] ?? record['args'];
      if (name !== '') out.push({ name, args: parseToolArgs(rawArgs) });
    }
  }
  // Anthropic: tool_use parts live inside `content`.
  if (Array.isArray(message['content'])) {
    for (const part of message['content']) {
      const record = asRecord(part);
      if (record === null) continue;
      const type = record['type'];
      const name = record['name'];
      if ((type === 'tool_use' || type === 'tool_call') && typeof name === 'string' && name !== '') {
        out.push({ name, args: parseToolArgs(record['input'] ?? record['args']) });
      }
    }
  }
  return out;
}

function normalize(messages: unknown[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message === null) continue;
    const role = typeof message['role'] === 'string' ? message['role'] : '';
    // A tool *result* is machine output: it is the loudest, least useful text
    // in any transcript, so it contributes tool names but never prose.
    const text = role === 'tool' || role === 'tool_result' ? '' : stripInjectedMemory(contentText(message['content']));
    out.push({ role, text, tools: toolCallsOf(message) });
  }
  return out;
}

/** Split prose into candidate sentences, dropping code and markup noise. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    // Fenced code and inline code are implementation, not statements about the
    // project; keeping them makes every handoff a list of identifiers.
    const line = rawLine.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    for (const piece of line.split(/(?<=[.!?;])\s+/)) {
      // Strip list bullets, headings and blockquote markers before judging.
      const sentence = piece.replace(/^\s*(?:[-*+>]+|\d+[.)]|#{1,6})\s*/, '').replace(/\s+/g, ' ').trim();
      if (sentence !== '') out.push(sentence);
    }
  }
  return out;
}

/** A sentence worth keeping: a real statement, not a fragment, path or log line. */
function isStatement(sentence: string): boolean {
  if (sentence.length < 20 || sentence.length > 400) return false;
  if (!/[A-Za-z]{3}/.test(sentence)) return false;
  const words = sentence.split(' ').length;
  return words >= 4;
}

/**
 * Cues are deliberately spelled out rather than fuzzy-matched: an auto-save
 * hook that guesses wrong writes noise into every future session's recall, and
 * a wrong memory is worse than a missing one. Every pattern requires the cue as
 * a whole word, so "note" matches but "noted elsewhere" noise does not.
 *
 * Indonesian cues sit beside the English ones because the transcripts on this
 * machine are bilingual — the same reason the FTS synonym table carries both.
 */
const CUES: { kind: 'gotchas' | 'decisions' | 'conventions' | 'nextSteps'; pattern: RegExp }[] = [
  {
    kind: 'gotchas',
    // `do not` is deliberately absent: it is how prompts *instruct the agent*
    // ("do not call any tools"), not how a project's traps are described, and
    // it turned per-turn instructions into permanent gotchas.
    pattern: /\b(gotcha|caveat|pitfall|beware|watch out|breaks? if|breaks? when|fails? if|fails? when|must not|never|bug|regression|jangan|hati-hati|gagal|tidak boleh|jebakan)\b/i,
  },
  {
    kind: 'decisions',
    pattern: /\b(decided|decision|chose|choose|choosing|instead of|going with|went with|settled on|opted for|we'll use|we will use|switched to|memilih|memutuskan|dipilih|gunakan|menggunakan|solusinya|akhirnya)\b/i,
  },
  {
    kind: 'nextSteps',
    pattern: /\b(todo|to-do|next step|next up|remaining|follow[- ]up|belum|selanjutnya|berikutnya|lanjut|sisa|nanti)\b/i,
  },
  {
    kind: 'conventions',
    pattern: /\b(convention|by default|always|the rule is|style|format|standar|kebiasaan|aturan|selalu|defaultnya)\b/i,
  },
];

function firstMatchKind(sentence: string): 'gotchas' | 'decisions' | 'nextSteps' | 'conventions' | null {
  for (const cue of CUES) {
    if (cue.pattern.test(sentence)) return cue.kind;
  }
  return null;
}

/**
 * Sentences that shape the *reply* rather than state the work.
 *
 * Real prompts open with them constantly ("No tools, no file reads. For the
 * worker: cap retries."), and used as the goal they title a handoff with an
 * instruction instead of a task — which is exactly what the first live run did.
 * Kept deliberately small and anchored at the sentence start: a goal that
 * happens to contain "only" mid-sentence is still the goal.
 */
const META_INSTRUCTION =
  /^(?:no\b|do not\b|don't\b|dont\b|without\b|reply\b|answer\b|respond\b|acknowledge\b|just\b|be brief\b|keep it\b|only\b|ignore\b)/i;

/** The opening request: the first sentence that is about the work, falling back
 *  to the first sentence when every one of them is meta. */
function goalSentence(text: string): string {
  const sentences = sentencesOf(text).filter((sentence) => sentence !== '');
  return sentences.find((sentence) => !META_INSTRUCTION.test(sentence)) ?? sentences[0] ?? '';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Push without duplicates (case-insensitive) and without exceeding the caps. */
function addUnique(list: string[], value: string, max: number): void {
  if (list.length >= max) return;
  const key = value.toLowerCase();
  if (list.some((existing) => existing.toLowerCase() === key)) return;
  list.push(value);
}

/** Tool names that write to disk, so their path argument is worth recording. */
const WRITE_TOOLS = /write|edit|patch|create|apply|replace|save|update/i;

function factFromTool(tool: ToolActivity): string | null {
  const args = tool.args;
  const command = args['command'];
  if (typeof command === 'string' && command.trim() !== '') {
    return clip(`ran: ${command}`, HANDOFF_ITEM_MAX);
  }
  if (!WRITE_TOOLS.test(tool.name)) return null;
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'filename']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(`changed: ${value}`, HANDOFF_ITEM_MAX);
    }
  }
  return null;
}

/**
 * Derive a handoff from a transcript, or `null` when there is nothing worth
 * remembering.
 *
 * The null case is the point of the guard: a hook fires on *every* turn, and a
 * handoff written for a turn that only greeted the user would push a no-op row
 * into the dashboard and a worthless line into the next session's recall.
 */
export function deriveHandoff(input: TranscriptInput): SessionHandoffInput | null {
  const messages = normalize(input.messages);
  const facts: string[] = [];
  for (const message of messages) {
    for (const tool of message.tools) {
      const fact = factFromTool(tool);
      if (fact !== null) addUnique(facts, fact, HANDOFF_FACTS_MAX);
    }
  }

  const prose: { role: string; text: string }[] = [];
  for (const message of messages) {
    if (message.text.trim() !== '') prose.push({ role: message.role, text: message.text });
  }
  // Post-LLM events carry the finished turn beside the history. Append, never
  // prepend: prepending made the newest ask the "first" user turn, so a
  // two-turn session's goal came out as the last thing said instead of the
  // request the session was about.
  const userText = input.userMessage === undefined ? '' : stripInjectedMemory(input.userMessage).trim();
  if (userText !== '' && !prose.some((entry) => entry.role === 'user' && entry.text.trim() === userText)) {
    prose.push({ role: 'user', text: userText });
  }
  const assistant = input.assistantResponse === undefined ? '' : stripInjectedMemory(input.assistantResponse);
  if (assistant.trim() !== '') prose.push({ role: 'assistant', text: assistant });

  // A handoff describes work somebody asked for. A transcript with no human turn
  // — a subagent hop, a machine-only run, a payload we could not read — has no
  // goal to carry forward, so it remembers nothing no matter what it ran.
  const firstUser = prose.find((entry) => entry.role === 'user');
  if (firstUser === undefined) return null;
  // The goal is the opening request, held to a looser bar than the classified
  // sentences below: "Fix login bug" is a legitimate goal that is too short to
  // read as a statement *about* the project.
  const opening = goalSentence(firstUser.text);
  // An attachment-only or block-only user turn leaves nothing to quote, but the
  // turn still had a goal — fall back to any sentence rather than dropping a
  // handoff that holds real notes.
  const goalSource = opening !== '' ? opening : (prose.flatMap((entry) => sentencesOf(entry.text))[0] ?? '');
  if (goalSource === '') return null;
  const goal = clip(goalSource, HANDOFF_GOAL_MAX);

  const buckets: Record<'gotchas' | 'decisions' | 'conventions' | 'nextSteps', string[]> = {
    gotchas: [],
    decisions: [],
    conventions: [],
    nextSteps: [],
  };
  for (const entry of prose) {
    for (const sentence of sentencesOf(entry.text)) {
      if (!isStatement(sentence)) continue;
      const kind = firstMatchKind(sentence);
      if (kind === null) continue;
      addUnique(buckets[kind], clip(sentence, HANDOFF_ITEM_MAX), HANDOFF_LIST_MAX);
    }
  }

  const empty =
    facts.length === 0 &&
    buckets.gotchas.length === 0 &&
    buckets.decisions.length === 0 &&
    buckets.conventions.length === 0 &&
    buckets.nextSteps.length === 0;
  if (empty) return null;

  return {
    goal,
    facts,
    decisions: buckets.decisions,
    gotchas: buckets.gotchas,
    conventions: buckets.conventions,
    nextSteps: buckets.nextSteps,
  };
}
