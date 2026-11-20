import test from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_GROK_PRESENTATION_ALIAS, CURSOR_MODEL_CACHE_KEYS, cursorFixedModelSelection } from '../src/chat/cursor-model-state.js';

const params = () => [{ id: 'context', value: '256k' }, { id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }];
const signature = { model: 'grok-4.7-high-fast', context: '256k', reasoningEffort: 'high', fast: true, maxMode: false };
function state(route: 'grok-4.7' | 'grok-4.7-high-fast' = 'grok-4.7', routeParams = params()): any {
  return {
    model: { modelId: route, displayModelId: route, displayName: 'Grok 4.7 256K High Fast', displayNameShort: 'Grok 4.7', aliases: ['grok-4.7'], maxMode: false, thinkingDetails: {} },
    hasChangedDefaultModel: true,
    maxMode: false,
    modelParameters: { [route]: routeParams },
    selectedModel: { modelId: route, parameters: routeParams.map((item: any) => ({ ...item })) },
    modelSelectionHistory: [route],
  };
}
const rejects = (value: unknown, label: RegExp) => assert.throws(() => cursorFixedModelSelection(value), label);

test('cursor model cache key contract and absent baseline', () => {
  assert.deepEqual(CURSOR_MODEL_CACHE_KEYS, ['model', 'hasChangedDefaultModel', 'maxMode', 'modelParameters', 'selectedModel', 'modelSelectionHistory']);
  assert.equal(cursorFixedModelSelection({ unrelated: true }), null);
  rejects({ model: {} }, /invalid \/config\/model-cache completeness/);
});

test('accepts exact base parameters in any order and ignores safe presentation/preferences', () => {
  const value = state();
  value.selectedModel.parameters.reverse(); value.modelParameters['grok-4.7'] = [params()[2], params()[0], params()[1]];
  value.hasChangedDefaultModel = false; value.model.displayModelId = 'grok-4.7-high-fast'; value.model.aliases = ['grok-4.7', 'grok-4.7-high-fast'];
  assert.deepEqual(cursorFixedModelSelection(value), signature);
  const guest = Function(`return (${cursorFixedModelSelection.toString()})`)() as typeof cursorFixedModelSelection;
  assert.deepEqual(guest(structuredClone(value)), signature);
});

test('accepts approved full slug with exact selected parameters and optional empty inactive full cache', () => {
  const value = state('grok-4.7-high-fast'); value.modelParameters['grok-4.7'] = params(); value.modelSelectionHistory = ['grok-4.7', 'grok-4.7-high-fast'];
  assert.deepEqual(cursorFixedModelSelection(value), signature);
  const baseValue = state(); baseValue.modelParameters['grok-4.7-high-fast'] = []; assert.deepEqual(cursorFixedModelSelection(baseValue), signature);
});

test('accepts only the exact observed public presentation alias', () => {
  assert.equal(CURSOR_GROK_PRESENTATION_ALIAS, 'Grok 4.7  High Fast\u200B\u200B');
  for (const key of ['displayName', 'displayNameShort'] as const) {
    const accepted = state(); accepted.model[key] = CURSOR_GROK_PRESENTATION_ALIAS;
    assert.deepEqual(cursorFixedModelSelection(accepted), signature);
    const guest = Function(`return (${cursorFixedModelSelection.toString()})`)() as typeof cursorFixedModelSelection;
    assert.deepEqual(guest(structuredClone(accepted)), signature);
    for (const variant of [
      'Grok 4.7 High Fast\u200B\u200B',
      'Grok 4.7   High Fast\u200B\u200B',
      'Grok 4.7  High Fast\u200B',
      'Grok 4.7  High Fast\u200B\u200B\u200B',
    ]) {
      const rejected = state(); rejected.model[key] = variant;
      rejects(rejected, new RegExp(`invalid /model/${key} presentation`));
    }
  }
  const wrongId = state(); wrongId.model.displayName = CURSOR_GROK_PRESENTATION_ALIAS; wrongId.model.modelId = 'grok-4.8'; rejects(wrongId, /invalid \/model\/modelId/);
  const wrongParameter = state(); wrongParameter.model.displayName = CURSOR_GROK_PRESENTATION_ALIAS; wrongParameter.selectedModel.parameters[0].value = '128k'; rejects(wrongParameter, /invalid \/selectedModel\/parameters/);
  const wrongHistory = state(); wrongHistory.model.displayName = CURSOR_GROK_PRESENTATION_ALIAS; wrongHistory.modelSelectionHistory = ['grok-4.8']; rejects(wrongHistory, /invalid \/modelSelectionHistory/);
});

test('rejects non-fixed selection and altered route semantics', () => {
  const other = state(); other.selectedModel.modelId = 'grok-4.8'; rejects(other, /invalid \/selectedModel\/modelId/);
  const rawBase = state('grok-4.7', []); rejects(rawBase, /invalid \/selectedModel\/parameters/);
  const emptyFull = state('grok-4.7-high-fast', []); rejects(emptyFull, /invalid \/selectedModel\/parameters/);
  for (const [id, bad] of [['context', '128k'], ['reasoning_effort', 'low'], ['fast', 'false']] as const) { const value = state(); value.selectedModel.parameters.find((item: any) => item.id === id).value = bad; rejects(value, /invalid \/selectedModel\/parameters/); }
  const duplicate = state(); duplicate.selectedModel.parameters[2] = { id: 'context', value: '256k' }; rejects(duplicate, /invalid \/selectedModel\/parameters/);
});

test('rejects invalid map, history, model properties, credentials and unsafe aliases', () => {
  const missingActive = state(); missingActive.modelParameters = { 'grok-4.7-high-fast': [] }; rejects(missingActive, /invalid \/modelParameters keys/);
  const otherHistory = state(); otherHistory.modelSelectionHistory = ['grok-4.8']; rejects(otherHistory, /invalid \/modelSelectionHistory/);
  const duplicateHistory = state(); duplicateHistory.modelSelectionHistory = ['grok-4.7', 'grok-4.7']; rejects(duplicateHistory, /invalid \/modelSelectionHistory unique/);
  const credentials = state(); credentials.model.credentials = { token: 'secret' }; rejects(credentials, /invalid \/model keys/);
  const unknown = state(); unknown.model.provider = 'x'; rejects(unknown, /invalid \/model keys/);
  const autoAlias = state(); autoAlias.model.aliases = ['grok-auto']; rejects(autoAlias, /invalid \/model\/aliases/);
  const arbitraryAlias = state(); arbitraryAlias.model.aliases = ['grok-4.7-experimental']; rejects(arbitraryAlias, /invalid \/model\/aliases/);
  const arbitraryDisplay = state(); arbitraryDisplay.model.displayName = 'Grok 4.7 Experimental'; rejects(arbitraryDisplay, /invalid \/model\/displayName/);
  const max = state(); max.model.maxMode = true; rejects(max, /invalid \/model\/maxMode/);
  const thinking = state(); thinking.model.thinkingDetails = { enabled: true }; rejects(thinking, /invalid \/model\/thinkingDetails/);
});

test('does not mutate accepted input', () => {
  const value = state(); const before = structuredClone(value); cursorFixedModelSelection(value); assert.deepEqual(value, before);
});
