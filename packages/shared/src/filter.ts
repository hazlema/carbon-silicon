import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

let matcher: RegExpMatcher | null = null;
let censor: TextCensor | null = null;

function getMatcher(): RegExpMatcher {
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  return matcher;
}

export function containsProfanity(text: string): boolean {
  return getMatcher().hasMatch(text);
}

/** Replaces profanity with grawlix (e.g. "%@$&"), keeping the rest of the text. */
export function censorText(text: string): string {
  const matches = getMatcher().getAllMatches(text);
  if (matches.length === 0) return text;
  censor ??= new TextCensor();
  return censor.applyTo(text, matches);
}
