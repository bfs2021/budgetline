const STOPWORDS = new Set(
  (
    'the and for with that this from into your you are was were have has had not but can will ' +
    'what when where which who how why all any its our out use using make please also then them ' +
    'there their these those just like some more than only want need should would could about ' +
    'los las del por para con una uno unos unas que como esto esta este estos estas pero sus ' +
    'más mas muy sin sobre entre cuando donde quiero puedes hacer haz todo toda todos todas ' +
    'tambien también ahora aqui aquí eso esa ese ver mira dime'
  ).split(' '),
);

/**
 * Normalized keyword terms of a text: lowercase, accents removed, stopwords dropped and
 * words cut to 6 characters (a crude stemmer that works across English and Spanish).
 */
export function terms(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u);
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.push(w.length > 6 ? w.slice(0, 6) : w);
  }
  return out;
}

/** A request to budgetline itself (`/estimate …`, `/budgetline:estimate …`): not real work to compare with. */
export function isEstimateRequest(text: string): boolean {
  return /^(\/(budgetline:)?estimate|budgetline:estimate)(\s|$)/i.test(text.trim());
}

export type TaskKind = 'question' | 'change';

const QUESTION_START =
  /^(cuant[oa]s?|que|cual(es)?|donde|como|por que|quien|hay|existe|what|how|where|which|why|who|is|are|does|do|can|could)\b/;
const ACTION_EN =
  '(add|implement|fix|refactor|create|build|update|remove|delete|migrate|write|change|rename|move|install|make|replace|convert)(s|es|ed|d|ing)?';
const ACTION_ES =
  '(anad|agreg|implement|arregl|corrig|crea|haz|hacer|cambia|modific|escrib|borr|elimin|refactor|migr|actualiz|instal|configur|renombr|mueve|mover)\\w*';
/** An explicit request inside a question ("can you add…", "¿puedes añadir…"). */
const REQUEST = new RegExp(
  `\\b(can you|could you|would you|will you|please|i want|i need|let'?s|puedes|podrias|quiero|necesito|hay que|por favor)\\b.*\\b(${ACTION_EN}|${ACTION_ES})\\b`,
);

/**
 * 'question' for short asks that only need an answer: they look like a question (question
 * word first or "?" at the end) and contain no explicit request to change something
 * ("can you add…"). Anything else, including plain imperatives ("add…", "añade…"), is a 'change'.
 */
export function taskKind(text: string): TaskKind {
  const t = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/^[¿\s]+/, '').trim();
  const asks = QUESTION_START.test(t) || t.endsWith('?');
  if (!asks) return 'change';
  return REQUEST.test(t) || t.length >= 300 ? 'change' : 'question';
}

const plain = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

const REVIEW_VERB = /\b(review|explain|summari[sz]e|describ|document|audit|revis|explic|resum)\w*/;
/** Work that changes or runs something: any of these means the task is not review-only. */
const WORK_VERB = new RegExp(
  `\\b(${ACTION_EN}|${ACTION_ES}|(run|ship|bundle|compile|test|deploy|release|commit|publish|merge)(s|es|ed|d|ing)?|(compil|ejecut|lanz|despleg|publica|fusion|prueb|test)\\w*)\\b`,
);

/** Review or explanation only ("review X", "explica Y"), with no change, build or test to do. */
export function isReviewOnly(text: string): boolean {
  const t = plain(text);
  return REVIEW_VERB.test(t) && !WORK_VERB.test(t);
}
