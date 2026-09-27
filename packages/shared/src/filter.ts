import {
  DataSet,
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

/** Entries of obscenity's English dataset that are slurs rather than ordinary swearing. Slurs are
 *  refused everywhere, table chat included; everything else is only censored in public channels. */
const SLUR_WORDS = new Set([
  'abo', 'abeed', 'africoon', 'arabush', 'boonga', 'chingchong', 'chink', 'dyke', 'fag', 'kike',
  'negro', 'nigger', 'retard', 'spastic', 'tranny',
]);

let matcher: RegExpMatcher | null = null;
let slurMatcher: RegExpMatcher | null = null;
let censor: TextCensor | null = null;

function getMatcher(): RegExpMatcher {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
}

function getSlurMatcher(): RegExpMatcher {
  slurMatcher ??= new RegExpMatcher({
    ...new DataSet<{ originalWord: string }>()
      .addAll(englishDataset)
      .removePhrasesIf((p) => !SLUR_WORDS.has(p.metadata?.originalWord ?? ''))
      .build(),
    ...englishRecommendedTransformers,
  });
  return slurMatcher;
}

export function containsProfanity(text: string): boolean {
  return getMatcher().hasMatch(text);
}

export function containsSlur(text: string): boolean {
  return getSlurMatcher().hasMatch(text);
}

/** Replaces profanity with grawlix (e.g. "%@$&"), keeping the rest of the text. */
export function censorText(text: string): string {
  const matches = getMatcher().getAllMatches(text);
  if (matches.length === 0) return text;
  censor ??= new TextCensor();
  return censor.applyTo(text, matches);
}
