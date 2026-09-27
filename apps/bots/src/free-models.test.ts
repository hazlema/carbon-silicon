import { expect, test } from 'bun:test';
import { freeModels } from './free-models';

const text = { input_modalities: ['text'], output_modalities: ['text'] };

test('keeps only free chat models, sorted by id, skipping paid ones, "-1" router entries and music generators', () => {
  const data = {
    data: [
      { id: 'google/lyria-3-clip-preview', name: 'Lyria', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } },
      { id: 'openrouter/auto', name: 'Auto', context_length: 1, pricing: { prompt: '-1', completion: '-1' } },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)', context_length: 262144, pricing: { prompt: '0', completion: '0' }, architecture: text },
      { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B', context_length: 262144, pricing: { prompt: '0.0000001', completion: '0.0000003' } },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron Super (free)', context_length: 262144, pricing: { prompt: '0', completion: '0' }, architecture: text },
    ],
  };
  expect(freeModels(data).map((m) => m.id)).toEqual(['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free']);
  expect(freeModels({})).toEqual([]);
});
