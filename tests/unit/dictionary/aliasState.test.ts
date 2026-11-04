// @vitest-environment node
// BUS-138 PR B: alias state in the app reducer.
import { describe, expect, it } from 'vitest';

import { appReducer } from '../../../src/app/state';
import { createInitialState } from '../../../src/app/initialState';

const start = () => createInitialState(1_000, { persistDictionary: true });

describe('alias state', () => {
  it('starts empty and hydrates from the file', () => {
    expect(start().aliases).toEqual({});
    const hydrated = appReducer(start(), {
      aliases: { Voxloom: ['box loom'] },
      type: 'hydrate-words',
      words: ['Voxloom'],
    });
    expect(hydrated.aliases).toEqual({ Voxloom: ['box loom'] });
  });

  it('hydrate without aliases means none', () => {
    const withAliases = appReducer(start(), {
      aliases: { Voxloom: ['box loom'] },
      type: 'hydrate-words',
      words: ['Voxloom'],
    });
    expect(appReducer(withAliases, { type: 'hydrate-words', words: ['Voxloom'] }).aliases).toEqual({});
  });

  it('save-word stores, replaces and clears aliases', () => {
    let state = appReducer(start(), { aliases: ['box loom'], type: 'save-word', word: 'Voxloom' });
    expect(state.aliases).toEqual({ Voxloom: ['box loom'] });
    state = appReducer(state, { aliases: ['vox loom'], editing: 'Voxloom', type: 'save-word', word: 'Voxloom' });
    expect(state.aliases).toEqual({ Voxloom: ['vox loom'] });
    state = appReducer(state, { aliases: [], editing: 'Voxloom', type: 'save-word', word: 'Voxloom' });
    expect(state.aliases).toEqual({});
  });

  it('a rename moves the aliases to the new word', () => {
    let state = appReducer(start(), { aliases: ['box loom'], type: 'save-word', word: 'Voxloom' });
    state = appReducer(state, { aliases: ['box loom'], editing: 'Voxloom', type: 'save-word', word: 'Vox' });
    expect(state.aliases).toEqual({ Vox: ['box loom'] });
    // Without an aliases list the existing ones move along (older callers).
    state = appReducer(state, { editing: 'Vox', type: 'save-word', word: 'Vox2' });
    expect(state.aliases).toEqual({ Vox2: ['box loom'] });
  });

  it('delete-word removes the aliases', () => {
    let state = appReducer(start(), { aliases: ['box loom'], type: 'save-word', word: 'Voxloom' });
    state = appReducer(state, { type: 'delete-word', word: 'Voxloom' });
    expect(state.aliases).toEqual({});
  });

  it('keeps durable aliases on a dev reset and clears them on scenario-empty', () => {
    const state = appReducer(start(), { aliases: ['box loom'], type: 'save-word', word: 'Voxloom' });
    const reset = appReducer(state, { now: 2_000, persistDictionary: true, type: 'reset' });
    expect(reset.aliases).toEqual({ Voxloom: ['box loom'] });
    expect(appReducer(state, { type: 'scenario-empty' }).aliases).toEqual({});
  });
});
